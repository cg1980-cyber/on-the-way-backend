// server.js
// On the Way — backend server
// Receives carrier emails via webhook, stores packages in Supabase

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { parseCarrierEmail } = require('./emailParser');
const auth = require('./auth');
const { createHouseholdRouter, getMembership } = require('./household');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Validate config on startuph
try {
  auth.validateSecurityConfig();
  } catch (error) {
    console.error('Security config error:', error.message);
      process.exit(1);
      }

      // Apply rate limiting
      app.use('/api/', auth.apiLimiter);
      // Webhook ingest is secret-protected but was previously unthrottled.
      // 50 req/15min is generous for beta-scale email volume; revisit the
      // per-IP keying before real scale (Cloudflare egress IPs are shared).
      app.use('/webhook/', auth.webhookLimiter);

// ─── Supabase Client ────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // Service key bypasses RLS for server-side writes
);

// ─── Household routes (Pillar 1) ────────────────────────────────────────────
app.use('/api/household', createHouseholdRouter(supabase, auth));

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Smart-route: if the shipping email names exactly one household member,
// return that member so the package can be assigned to them.
function matchRecipientMember(emailText, members) {
  if (!emailText || !Array.isArray(members) || members.length < 2) return null;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Tier 1: greeting / delivery phrases ("Hi Cory," / "delivered to Cory")
  const anchored = members.filter((m) => {
    const name = (m.display_name || '').trim();
    if (name.length < 2) return false;
    const re = new RegExp(
      `(?:\\bhi|\\bhello|\\bdear|\\bhey|\\bfor|delivered to|shipped to|addressed to)[,:]?\\s+${esc(name)}\\b`,
      'i'
    );
    return re.test(emailText);
  });
  if (anchored.length === 1) return anchored[0];

  // Tier 2: exactly one member's name appears anywhere in the email
  const mentioned = members.filter((m) => {
    const name = (m.display_name || '').trim();
    return name.length >= 2 && new RegExp(`\\b${esc(name)}\\b`, 'i').test(emailText);
  });
  return mentioned.length === 1 ? mentioned[0] : null;
}

// Push a notification to every joined member of a household (or one user).
// The household-wide delivery alert is the Pillar 1 differentiator: everyone
// at the address knows, not just the buyer. No-ops until push_tokens exist.
async function sendHouseholdPush(householdId, fallbackUserId, title, body) {
  try {
    let userIds = [];
    if (householdId) {
      const { data: members } = await supabase
        .from('household_members')
        .select('user_id')
        .eq('household_id', householdId)
        .not('user_id', 'is', null);
      userIds = (members || []).map((m) => m.user_id);
    } else if (fallbackUserId) {
      userIds = [fallbackUserId];
    }
    if (!userIds.length) return;

    const { data: tokens, error } = await supabase
      .from('push_tokens')
      .select('token')
      .in('user_id', userIds);
    if (error || !tokens || !tokens.length) return;

    const messages = tokens.map((t) => ({ to: t.token, sound: 'default', title, body }));
    for (let i = 0; i < messages.length; i += 100) {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages.slice(i, i + 100)),
      });
    }
  } catch (err) {
    console.warn('Push send failed:', err.message);
  }
}

// ─── Health Check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'On the Way backend is running ✓', timestamp: new Date().toISOString() });
});

// ─── Email Webhook ──────────────────────────────────────────────────────────
// Cloudflare Worker will POST to this endpoint when an email arrives
// Expected body: { to, from, subject, text, html }
app.post('/webhook/email', async (req, res) => {
  try {
    const { to, from, subject, text, html } = req.body;

    // Verify webhook secret to prevent unauthorized posts
    const secret = req.headers['x-webhook-secret'];
    if (secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!to || !from) {
      return res.status(400).json({ error: 'Missing required fields: to, from' });
    }

    // The "to" address is the user's unique address, e.g. cliff.abc123@onthewayapp.net
    // Look up which user owns this address
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email')
      .eq('tracking_email', to.toLowerCase())
      .single();

    if (userError || !user) {
      console.log(`No user found for email address: ${to}`);
      return res.status(200).json({ message: 'No matching user, ignoring' });
    }

    // Parse the carrier email to extract package info
    const parsed = parseCarrierEmail(`${from || ''} ${subject || ''} ${text || ''} ${html || ''}`);

    // Reject emails the parser is not confident are real shipping notifications.
    // Without this gate, every non-shipping email forwarded to the user's
    // tracking address would create a junk row in `packages`.
    if (!parsed.isShipping) {
      console.log(
        `Ignoring non-shipping email for ${user.email} (from=${from}, subject=${subject})`
      );
      return res.status(200).json({ message: 'Not a shipping email, ignoring' });
    }

    // Resolve the recipient's household so packages land in the shared feed.
    // Default recipient is whoever owns the tracking address that received the
    // email; smart name-matching against members refines this when the label
    // names someone else in the household.
    const membership = await getMembership(supabase, user.id);
    let recipientMemberId = membership ? membership.id : null;
    if (membership) {
      try {
        const { data: members } = await supabase
          .from('household_members')
          .select('id, display_name')
          .eq('household_id', membership.household_id);
        const matched = matchRecipientMember(`${subject || ''} ${text || ''}`, members || []);
        if (matched) {
          recipientMemberId = matched.id;
          console.log(`Recipient matched by name: ${matched.display_name}`);
        }
      } catch (e) {
        console.warn('Recipient name-match failed:', e.message);
      }
    }

    // Check if we already have a package with this tracking number for this user
    // to avoid duplicate entries from multiple status update emails
    let packageRecord;

    if (parsed.tracking_number) {
      const { data: existing } = await supabase
        .from('packages')
        .select('id, status, delivered_at')
        .eq('user_id', user.id)
        .eq('tracking_number', parsed.tracking_number)
        .single();

      if (existing) {
        // Update the existing package's status. A "Delivered" carrier email
        // arrives on delivery day, so today is the actual delivery date.
        const statusUpdate = {
          status: parsed.status,
          estimated_delivery: parsed.estimated_delivery,
          last_updated: new Date().toISOString(),
        };
        if (parsed.status === 'Delivered' && !existing.delivered_at) {
          statusUpdate.delivered_at = new Date().toISOString().slice(0, 10);
        }
        const { data: updated, error: updateError } = await supabase
          .from('packages')
          .update(statusUpdate)
          .eq('id', existing.id)
          .select()
          .single();

        if (updateError) throw updateError;
        packageRecord = updated;
        console.log(`Updated package ${parsed.tracking_number} for user ${user.id}: ${parsed.status}`);

        // Household-wide alert when the status actually changed.
        if (parsed.status && parsed.status !== existing.status) {
          sendHouseholdPush(
            membership ? membership.household_id : null,
            user.id,
            `📦 ${parsed.status}`,
            `${updated.nickname || updated.merchant || 'A package'}${updated.carrier ? ` · ${updated.carrier}` : ''}`
          );
        }
      }
    }

    // If no existing package was found (or no tracking number), create a new one
    if (!packageRecord) {
      const { data: newPackage, error: insertError } = await supabase
        .from('packages')
        .insert({
          user_id: user.id,
          household_id: membership ? membership.household_id : null,
          recipient_member_id: recipientMemberId,
          tracking_number: parsed.tracking_number || null,
          carrier: parsed.carrier,
          status: parsed.status,
          merchant: parsed.merchant,
          estimated_delivery: parsed.estimated_delivery,
          delivered_at: parsed.status === 'Delivered' ? new Date().toISOString().slice(0, 10) : null,
          nickname: null,  // User can set this in the app
          last_updated: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError) throw insertError;
      packageRecord = newPackage;
      console.log(`Created new package for user ${user.id}: ${parsed.merchant} via ${parsed.carrier}`);

      sendHouseholdPush(
        membership ? membership.household_id : null,
        user.id,
        '📦 New package on the way',
        `${parsed.merchant || 'A package'}${parsed.carrier ? ` · ${parsed.carrier}` : ''}`
      );
    }

    res.json({ success: true, package: packageRecord });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Packages API ───────────────────────────────────────────────────────────

// GET /api/packages — returns all packages for the authenticated user
app.get('/api/packages', auth.authMiddleware, async (req, res) => {
  try {
    const userId = auth.getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Missing user ID' });

    const membership = await getMembership(supabase, userId);

    let query = supabase.from('packages').select('*');
    if (membership) {
      // Whole household feed, plus any of the user's own pre-household packages.
      query = query.or(
        `household_id.eq.${membership.household_id},and(user_id.eq.${userId},household_id.is.null)`
      );
    } else {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query.order('last_updated', { ascending: false });
    if (error) throw error;

    // Gift mode: hide packages the viewer has been explicitly excluded from.
    const visible = membership
      ? data.filter((p) => !(p.hidden_from || []).includes(membership.id))
      : data;

    res.json(visible);

  } catch (err) {
    console.error('Get packages error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/packages/:id — update a package (e.g. set a nickname or archive it)
app.patch('/api/packages/:id', auth.authMiddleware, async (req, res) => {
  try {
    const userId = auth.getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Missing user ID' });

    const membership = await getMembership(supabase, userId);

    // Authorize: the package adder, or any member of the package's household.
    const { data: pkg, error: fErr } = await supabase
      .from('packages')
      .select('id, user_id, household_id')
      .eq('id', req.params.id)
      .single();
    if (fErr || !pkg) return res.status(404).json({ error: 'Package not found' });

    const isAdder = pkg.user_id === userId;
    const sameHousehold =
      membership && pkg.household_id && pkg.household_id === membership.household_id;
    if (!isAdder && !sameHousehold) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const { nickname, archived, deleted, note, merchant, recipient_member_id, hidden_from } = req.body;

    // recipient_member_id, if set, must belong to the same household.
    if (recipient_member_id && membership) {
      const { data: m } = await supabase
        .from('household_members')
        .select('id')
        .eq('id', recipient_member_id)
        .eq('household_id', membership.household_id)
        .maybeSingle();
      if (!m) return res.status(400).json({ error: 'recipient_member_id not in your household' });
    }

    const { data, error } = await supabase
      .from('packages')
      .update({ nickname, archived, deleted, note, merchant, recipient_member_id, hidden_from })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);

  } catch (err) {
    console.error('Update package error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/packages/:id — remove a package
app.delete('/api/packages/:id', auth.authMiddleware, async (req, res) => {
  try {
    const userId = auth.getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Missing user ID' });

    const membership = await getMembership(supabase, userId);

    const { data: pkg, error: fErr } = await supabase
      .from('packages')
      .select('id, user_id, household_id')
      .eq('id', req.params.id)
      .single();
    if (fErr || !pkg) return res.status(404).json({ error: 'Package not found' });

    const isAdder = pkg.user_id === userId;
    const isHouseholdOwner =
      membership && membership.role === 'owner' && pkg.household_id === membership.household_id;
    if (!isAdder && !isHouseholdOwner) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    const { error } = await supabase
      .from('packages')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });

  } catch (err) {
    console.error('Delete package error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── User Auth / Account ────────────────────────────────────────────────────

// POST /api/auth/signup — create a new user and generate their tracking email
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, address } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Sign up with Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) throw authError;

    // Generate unique tracking email: firstname.randomhex@onthewayapp.net
    const localPart = email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
    const randomHex = Math.random().toString(16).substring(2, 8);
    const trackingEmail = `${localPart}.${randomHex}@onthewayapp.net`;

    // Create user profile record
    const { data: userProfile, error: profileError } = await supabase
      .from('users')
      .insert({
        id: authData.user.id,
        email: email,
        tracking_email: trackingEmail,
        address: address || null,
      })
      .select()
      .single();

    if (profileError) throw profileError;

    // Household setup at signup. If an invitation is waiting for this email,
    // auto-join that household — the invitee never has to type a code.
    // Otherwise every new user gets their own household (owner role).
    let joinedExisting = false;
    try {
      const { data: invites } = await supabase
        .from('household_invitations')
        .select('*')
        .ilike('email', email.toLowerCase())
        .is('accepted_at', null);
      const invite = (invites || []).find((i) => new Date(i.expires_at) > new Date());
      if (invite) {
        const { data: pending } = await supabase
          .from('household_members')
          .select('id')
          .eq('household_id', invite.household_id)
          .is('user_id', null)
          .ilike('invite_email', invite.email)
          .maybeSingle();
        if (pending) {
          await supabase
            .from('household_members')
            .update({ user_id: authData.user.id, invite_email: null, joined_at: new Date().toISOString() })
            .eq('id', pending.id);
          await supabase
            .from('household_invitations')
            .update({ accepted_at: new Date().toISOString() })
            .eq('id', invite.id);
          joinedExisting = true;
          console.log(`New signup ${email} auto-joined household ${invite.household_id}`);
        }
      }
    } catch (joinErr) {
      console.error('Invite auto-join failed at signup:', joinErr.message);
    }

    if (!joinedExisting) {
      try {
        const displayName = email.split('@')[0];
        const { data: household } = await supabase
          .from('households')
          .insert({ name: `${displayName}'s Household` })
          .select()
          .single();
        if (household) {
          await supabase.from('household_members').insert({
            household_id: household.id,
            user_id: authData.user.id,
            role: 'owner',
            display_name: displayName,
          });
        }
      } catch (hErr) {
        // Non-fatal: the account exists; a household can be backfilled if this fails.
        console.error('Household auto-create failed for new user:', hErr.message);
      }
    }

    res.json({
      success: true,
      user: userProfile,
      trackingEmail,
    });

  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: err.message || 'Signup failed' });
  }
});

// GET /api/auth/profile — get current user's profile including their tracking email
app.get('/api/auth/profile', auth.authMiddleware, async (req, res) => {
  try {
    const userId = auth.getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Missing user ID' });

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) throw error;
    res.json(data);

  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/account — permanent account deletion (Play Store requirement).
// Removes packages, household membership (with ownership handoff), profile row,
// and the Supabase auth user.
app.delete('/api/auth/account', auth.authMiddleware, async (req, res) => {
  try {
    const userId = auth.getUserId(req);

    const membership = await getMembership(supabase, userId);
    if (membership) {
      const { data: others } = await supabase
        .from('household_members')
        .select('id, role, joined_at, user_id')
        .eq('household_id', membership.household_id)
        .neq('id', membership.id);
      const rest = others || [];
      const joinedRest = rest.filter((m) => m.user_id);

      if (membership.role === 'owner' && joinedRest.length) {
        // Promote the longest-tenured joined member so the household survives.
        const heir = joinedRest.sort((a, b) => new Date(a.joined_at) - new Date(b.joined_at))[0];
        await supabase.from('household_members').update({ role: 'owner' }).eq('id', heir.id);
      }

      await supabase.from('household_members').delete().eq('id', membership.id);

      if (!rest.length) {
        // Nobody left (not even pending invitees) — dissolve the household.
        // Clear package FKs first so the household row can be removed.
        await supabase
          .from('packages')
          .update({ household_id: null, recipient_member_id: null })
          .eq('household_id', membership.household_id);
        await supabase.from('households').delete().eq('id', membership.household_id);
      }
    }

    await supabase.from('packages').delete().eq('user_id', userId);
    await supabase.from('push_tokens').delete().eq('user_id', userId); // ignore result; table may not exist yet
    await supabase.from('users').delete().eq('id', userId);

    const { error: adminErr } = await supabase.auth.admin.deleteUser(userId);
    if (adminErr) throw adminErr;

    console.log(`Account deleted: ${userId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Account deletion error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/push/register — store an Expo push token for the caller.
app.post('/api/push/register', auth.authMiddleware, async (req, res) => {
  try {
    const userId = auth.getUserId(req);
    const { token, platform } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token required' });
    }
    const { error } = await supabase.from('push_tokens').upsert(
      { user_id: userId, token, platform: platform || 'android', updated_at: new Date().toISOString() },
      { onConflict: 'token' }
    );
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Push register error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/push/test — send a test notification to the caller's household.
// Lets users (and us) verify the FCM pipeline end-to-end from Settings.
app.post('/api/push/test', auth.authMiddleware, async (req, res) => {
  try {
    const userId = auth.getUserId(req);
    const { data: tokens } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId);
    if (!tokens || !tokens.length) {
      return res.json({ sent: false, reason: 'No device registered yet — open the app once with notifications allowed.' });
    }
    const membership = await getMembership(supabase, userId);
    await sendHouseholdPush(
      membership ? membership.household_id : null,
      userId,
      '🔔 Test notification',
      'Push is working — On the Way'
    );
    res.json({ sent: true });
  } catch (err) {
    console.error('Push test error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/refresh-status — live-status refresh via EasyPost (task #49).
// No-ops (enabled:false) until EASYPOST_API_KEY is set on Railway; the mobile
// pull-to-refresh already calls this, so setting the key lights it up.
const EASYPOST_STATUS_MAP = {
  pre_transit: 'Label Created',
  in_transit: 'In Transit',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  available_for_pickup: 'Available for Pickup',
  return_to_sender: 'Delayed',
  failure: 'Delayed',
  error: 'Delayed',
};

app.post('/api/refresh-status', auth.authMiddleware, async (req, res) => {
  try {
    const apiKey = process.env.EASYPOST_API_KEY;
    if (!apiKey) return res.json({ refreshed: 0, enabled: false });

    const userId = auth.getUserId(req);
    const membership = await getMembership(supabase, userId);

    let query = supabase
      .from('packages')
      .select('id, tracking_number, carrier, status, estimated_delivery, delivered_at, nickname, merchant')
      .eq('archived', false)
      .eq('deleted', false)
      .not('tracking_number', 'is', null);
    query = membership
      ? query.eq('household_id', membership.household_id)
      : query.eq('user_id', userId);
    const { data: pkgs, error } = await query;
    if (error) throw error;

    const authHeader = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
    let refreshed = 0;
    const diagnostics = [];

    for (const pkg of (pkgs || []).slice(0, 30)) {
      const diag = { tracking_number: pkg.tracking_number, current_status: pkg.status };
      try {
        // Registering a tracker is idempotent-ish: on duplicate, fall back to lookup.
        let tracker = null;
        const createResp = await fetch('https://api.easypost.com/v2/trackers', {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracker: { tracking_code: pkg.tracking_number } }),
        });
        if (createResp.ok) {
          tracker = await createResp.json();
        } else {
          const createErrBody = await createResp.text().catch(() => '');
          diag.create_error = `${createResp.status}: ${createErrBody.slice(0, 200)}`;

          const listResp = await fetch(
            `https://api.easypost.com/v2/trackers?tracking_code=${encodeURIComponent(pkg.tracking_number)}`,
            { headers: { Authorization: authHeader } }
          );
          if (listResp.ok) {
            const list = await listResp.json();
            tracker = (list.trackers || [])[0] || null;
          } else {
            const listErrBody = await listResp.text().catch(() => '');
            diag.list_error = `${listResp.status}: ${listErrBody.slice(0, 200)}`;
          }
        }
        if (!tracker) {
          diag.result = 'no_tracker_returned';
          diagnostics.push(diag);
          continue;
        }

        diag.easypost_status = tracker.status;
        diag.easypost_est_delivery = tracker.est_delivery_date || null;

        const newStatus = EASYPOST_STATUS_MAP[tracker.status] || null;
        const newEta = tracker.est_delivery_date ? String(tracker.est_delivery_date).slice(0, 10) : null;
        const updates = {};
        if (newStatus && newStatus !== pkg.status) updates.status = newStatus;
        if (newEta && newEta !== pkg.estimated_delivery) updates.estimated_delivery = newEta;

        // Actual delivery date: EasyPost's tracking timeline has the real
        // delivered scan, which can be days before we happen to refresh.
        if (tracker.status === 'delivered' && !pkg.delivered_at) {
          const details = Array.isArray(tracker.tracking_details) ? tracker.tracking_details : [];
          const deliveredScan = [...details].reverse().find(
            (d) => (d.status || '').toLowerCase() === 'delivered'
          );
          const deliveredAt = deliveredScan && deliveredScan.datetime
            ? String(deliveredScan.datetime).slice(0, 10)
            : new Date().toISOString().slice(0, 10);
          updates.delivered_at = deliveredAt;
        }

        if (Object.keys(updates).length) {
          updates.last_updated = new Date().toISOString();
          await supabase.from('packages').update(updates).eq('id', pkg.id);
          refreshed++;
          diag.result = 'updated';
          diag.new_status = updates.status || null;
          if (updates.status) {
            sendHouseholdPush(
              membership ? membership.household_id : null,
              userId,
              `📦 ${updates.status}`,
              `${pkg.nickname || pkg.merchant || pkg.tracking_number}${pkg.carrier ? ` · ${pkg.carrier}` : ''}`
            );
          }
        } else if (!newStatus) {
          diag.result = `unmapped_easypost_status:${tracker.status}`;
        } else {
          diag.result = 'no_change_needed';
        }
      } catch (e) {
        diag.result = 'exception';
        diag.error = e.message;
        console.warn(`EasyPost refresh failed for ${pkg.tracking_number}:`, e.message);
      }
      diagnostics.push(diag);
    }

    console.log('EasyPost refresh diagnostics:', JSON.stringify(diagnostics));
    res.json({ refreshed, enabled: true, checked: diagnostics.length, diagnostics });
  } catch (err) {
    console.error('Refresh status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Webhook Handler ---
// Receives package updates from carriers with HMAC-SHA256 signature verification
app.post('/api/webhooks', async (req, res) => {
  try {
      const signature = req.headers['x-webhook-signature'];
          
              // Require signature header
                  if (!signature) {
                        return res.status(401).json({ error: 'Missing webhook signature' });
                            }
                                
                                    const payload = JSON.stringify(req.body);
                                        
                                            // Verify webhook signature using HMAC-SHA256
                                                try {
                                                      auth.verifyWebhookSignature(
                                                              payload,
                                                                      signature,
                                                                              process.env.WEBHOOK_SECRET
                                                                                    );
                                                                                        } catch (signatureError) {
                                                                                              console.error('Webhook signature verification failed:', signatureError.message);
                                                                                                    return res.status(401).json({ error: 'Invalid webhook signature' });
                                                                                                        }
                                                                                                            
                                                                                                                // Process the webhook payload
                                                                                                                    const { tracking_number, status, estimated_delivery, carrier } = req.body;
                                                                                                                        
                                                                                                                            // Validate required webhook fields
                                                                                                                                if (!tracking_number || !status) {
                                                                                                                                      return res.status(400).json({ error: 'Missing required fields: tracking_number, status' });
                                                                                                                                          }
                                                                                                                                              
                                                                                                                                                  // Update package status in database
                                                                                                                                                      const { data: packages, error: queryError } = await supabase
                                                                                                                                                            .from('packages')
                                                                                                                                                                  .select('id, user_id')
                                                                                                                                                                        .eq('tracking_number', tracking_number)
                                                                                                                                                                              .single();
                                                                                                                                                                                  
                                                                                                                                                                                      if (queryError || !packages) {
                                                                                                                                                                                            console.warn(`Package not found for tracking number: ${tracking_number}`);
                                                                                                                                                                                                  return res.status(404).json({ error: 'Package not found' });
                                                                                                                                                                                                      }
                                                                                                                                                                                                          
                                                                                                                                                                                                              // Update package with new status
                                                                                                                                                                                                                  const updateData = {
                                                                                                                                                                                                                        status: status,
                                                                                                                                                                                                                              last_updated: new Date().toISOString()
                                                                                                                                                                                                                                  };
                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                          if (estimated_delivery) {
                                                                                                                                                                                                                                                updateData.estimated_delivery = estimated_delivery;
                                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                                        
                                                                                                                                                                                                                                                            const { error: updateError } = await supabase
                                                                                                                                                                                                                                                                  .from('packages')
                                                                                                                                                                                                                                                                        .update(updateData)
                                                                                                                                                                                                                                                                              .eq('id', packages.id);
                                                                                                                                                                                                                                                                                  
                                                                                                                                                                                                                                                                                      if (updateError) {
                                                                                                                                                                                                                                                                                            throw updateError;
                                                                                                                                                                                                                                                                                                }
                                                                                                                                                                                                                                                                                                    
                                                                                                                                                                                                                                                                                                        // Log successful webhook processing
                                                                                                                                                                                                                                                                                                            console.log(`Webhook processed: ${tracking_number} -> ${status}`);
                                                                                                                                                                                                                                                                                                                
                                                                                                                                                                                                                                                                                                                    res.json({
                                                                                                                                                                                                                                                                                                                          success: true,
                                                                                                                                                                                                                                                                                                                                message: 'Package status updated successfully',
                                                                                                                                                                                                                                                                                                                                      tracking_number,
                                                                                                                                                                                                                                                                                                                                            status
                                                                                                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                                                                                                                    
                                                                                                                                                                                                                                                                                                                                                      } catch (error) {
                                                                                                                                                                                                                                                                                                                                                          console.error('Webhook processing error:', error);
                                                                                                                                                                                                                                                                                                                                                              res.status(500).json({ error: 'Internal server error' });
                                                                                                                                                                                                                                                                                                                                                                }
                                                                                                                                                                                                                                                                                                                                                                });

// ─── Start Server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`On the Way backend listening on port ${PORT}`);
});
