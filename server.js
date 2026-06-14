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

// ─── Supabase Client ────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // Service key bypasses RLS for server-side writes
);

// ─── Household routes (Pillar 1) ────────────────────────────────────────────
app.use('/api/household', createHouseholdRouter(supabase, auth));

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
    // email; smart name-matching against other members can refine this later.
    const membership = await getMembership(supabase, user.id);

    // Check if we already have a package with this tracking number for this user
    // to avoid duplicate entries from multiple status update emails
    let packageRecord;

    if (parsed.tracking_number) {
      const { data: existing } = await supabase
        .from('packages')
        .select('id, status')
        .eq('user_id', user.id)
        .eq('tracking_number', parsed.tracking_number)
        .single();

      if (existing) {
        // Update the existing package's status
        const { data: updated, error: updateError } = await supabase
          .from('packages')
          .update({
            status: parsed.status,
            estimated_delivery: parsed.estimated_delivery,
            last_updated: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (updateError) throw updateError;
        packageRecord = updated;
        console.log(`Updated package ${parsed.tracking_number} for user ${user.id}: ${parsed.status}`);
      }
    }

    // If no existing package was found (or no tracking number), create a new one
    if (!packageRecord) {
      const { data: newPackage, error: insertError } = await supabase
        .from('packages')
        .insert({
          user_id: user.id,
          household_id: membership ? membership.household_id : null,
          recipient_member_id: membership ? membership.id : null,
          tracking_number: parsed.tracking_number || null,
          carrier: parsed.carrier,
          status: parsed.status,
          merchant: parsed.merchant,
          estimated_delivery: parsed.estimated_delivery,
          nickname: null,  // User can set this in the app
          last_updated: new Date().toISOString(),
        })
        .select()
        .single();

      if (insertError) throw insertError;
      packageRecord = newPackage;
      console.log(`Created new package for user ${user.id}: ${parsed.merchant} via ${parsed.carrier}`);
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

    // Every new user gets their own household so Pillar 1 works from signup.
    // The user is the owner; they can invite others later.
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
