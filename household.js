// household.js
// On the Way — household accounts (Pillar 1)
//
// Exports a factory: createHouseholdRouter(supabase) -> express.Router
// The caller passes in the shared service-role Supabase client. Because that
// client BYPASSES RLS, every handler here scopes by household membership in
// code. RLS in the database is the safety net for the mobile app's direct
// Supabase calls; this module enforces its own checks.

const express = require('express');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Look up the caller's household membership. Returns the household_members row
// ({ id, household_id, role, display_name, ... }) or null if they're not in one.
async function getMembership(supabase, userId) {
  const { data, error } = await supabase
    .from('household_members')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Short, human-friendly join code. Avoids ambiguous chars (no 0/O/1/I/L).
function generateInviteCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

// Send an invitation email via Brevo's transactional HTTP API.
// No-ops (with a warning) if BREVO_API_KEY isn't configured, so the invite
// row is still created and the flow is testable without email set up.
async function sendInviteEmail({ toEmail, inviterName, householdName, token, code }) {
  const apiKey = process.env.BREVO_API_KEY;
  const acceptUrl =
    `https://cg1980-cyber.github.io/on-the-way-mobile/invite.html?token=${token}`;

  if (!apiKey) {
    console.warn('BREVO_API_KEY not set — invite created but email not sent.');
    console.warn(`Invite code: ${code} | Accept URL (share manually): ${acceptUrl}`);
    return { sent: false, acceptUrl };
  }

  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'On the Way', email: 'support@onthewayapp.net' },
      to: [{ email: toEmail }],
      subject: `${inviterName} invited you to ${householdName} on On the Way`,
      htmlContent: `
        <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color:#10b981;">You're invited to ${householdName}</h2>
          <p>${inviterName} wants you to join their household on <strong>On the Way</strong> —
             so you can both see every package coming to your home in one shared feed.</p>
          <p style="font-size:15px;">To join:</p>
          <ol style="font-size:15px;color:#334155;line-height:1.6;">
            <li>Install <strong>On the Way</strong> and sign up using <strong>${toEmail}</strong></li>
            <li>Go to <strong>Settings → Household → Have an invite code?</strong></li>
            <li>Enter this code:</li>
          </ol>
          <p style="text-align:center;margin:24px 0;">
            <span style="display:inline-block;background:#0f172a;color:#10b981;font-size:30px;
                         letter-spacing:6px;font-weight:700;padding:14px 28px;border-radius:10px;
                         font-family:monospace;">${code}</span>
          </p>
          <p style="color:#64748b;font-size:13px;">
            Or open this link for instructions: <a href="${acceptUrl}">${acceptUrl}</a><br/>
            This invite expires in 7 days.
          </p>
        </div>`,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Brevo send failed (${resp.status}): ${detail}`);
  }
  return { sent: true, acceptUrl };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
function createHouseholdRouter(supabase, auth) {
  const router = express.Router();

  // GET /api/household — the caller's household + all its members
  router.get('/', auth.authMiddleware, async (req, res) => {
    try {
      const userId = auth.getUserId(req);
      const membership = await getMembership(supabase, userId);
      if (!membership) return res.status(404).json({ error: 'No household' });

      const { data: household, error: hErr } = await supabase
        .from('households')
        .select('*')
        .eq('id', membership.household_id)
        .single();
      if (hErr) throw hErr;

      const { data: members, error: mErr } = await supabase
        .from('household_members')
        .select('id, user_id, role, display_name, invite_email, joined_at')
        .eq('household_id', membership.household_id)
        .order('joined_at', { ascending: true });
      if (mErr) throw mErr;

      res.json({ household, members, me: membership.id, myRole: membership.role });
    } catch (err) {
      console.error('Get household error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/household — rename the household (owner only)
  router.patch('/', auth.authMiddleware, async (req, res) => {
    try {
      const userId = auth.getUserId(req);
      const membership = await getMembership(supabase, userId);
      if (!membership) return res.status(404).json({ error: 'No household' });
      if (membership.role !== 'owner') {
        return res.status(403).json({ error: 'Only the owner can rename the household' });
      }

      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Name is required' });

      const { data, error } = await supabase
        .from('households')
        .update({ name })
        .eq('id', membership.household_id)
        .select()
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      console.error('Rename household error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/household/invite — owner invites someone by email
  router.post('/invite', auth.authMiddleware, async (req, res) => {
    try {
      const userId = auth.getUserId(req);
      const membership = await getMembership(supabase, userId);
      if (!membership) return res.status(404).json({ error: 'No household' });
      if (membership.role !== 'owner') {
        return res.status(403).json({ error: 'Only the owner can invite members' });
      }

      const email = (req.body.email || '').trim().toLowerCase();
      const displayName = (req.body.display_name || '').trim();
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'A valid email is required' });
      }
      if (!displayName) {
        return res.status(400).json({ error: 'A display name is required' });
      }

      // Don't double-invite an email already pending or joined in this household
      const { data: existing } = await supabase
        .from('household_members')
        .select('id, user_id, invite_email')
        .eq('household_id', membership.household_id);
      const already = (existing || []).some(
        (m) => (m.invite_email || '').toLowerCase() === email
      );
      if (already) {
        return res.status(409).json({ error: 'That email is already invited or a member' });
      }

      // Create the pending member row (user_id null until they accept)
      const { data: member, error: memErr } = await supabase
        .from('household_members')
        .insert({
          household_id: membership.household_id,
          user_id: null,
          role: 'member',
          display_name: displayName,
          invite_email: email,
        })
        .select()
        .single();
      if (memErr) throw memErr;

      // Create the invitation (token auto-generated by the DB default)
      const inviteCode = generateInviteCode();
      const { data: invite, error: invErr } = await supabase
        .from('household_invitations')
        .insert({
          household_id: membership.household_id,
          invited_by: membership.id,
          email,
          role: 'member',
          invite_code: inviteCode,
        })
        .select()
        .single();
      if (invErr) throw invErr;

      // Look up household name for the email body
      const { data: household } = await supabase
        .from('households')
        .select('name')
        .eq('id', membership.household_id)
        .single();

      let emailResult = { sent: false };
      try {
        emailResult = await sendInviteEmail({
          toEmail: email,
          inviterName: membership.display_name,
          householdName: household?.name || 'a household',
          token: invite.token,
          code: inviteCode,
        });
      } catch (sendErr) {
        // Invite row exists; surface the send failure but don't 500 the whole call.
        console.error('Invite email send failed:', sendErr.message);
      }

      res.json({
        success: true,
        member,
        invite: { id: invite.id, email, code: inviteCode, expires_at: invite.expires_at },
        invite_code: inviteCode,
        email_sent: emailResult.sent,
        accept_url: emailResult.acceptUrl,
      });
    } catch (err) {
      console.error('Invite error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/household/invite/:token — look up an invite (for the accept screen).
  // Intentionally unauthenticated: the token IS the credential.
  router.get('/invite/:token', async (req, res) => {
    try {
      const { data: invite, error } = await supabase
        .from('household_invitations')
        .select('id, household_id, email, role, invite_code, expires_at, accepted_at')
        .eq('token', req.params.token)
        .maybeSingle();
      if (error) throw error;
      if (!invite) return res.status(404).json({ error: 'Invite not found' });
      if (invite.accepted_at) {
        return res.status(410).json({ error: 'Invite already used' });
      }
      if (new Date(invite.expires_at) < new Date()) {
        return res.status(410).json({ error: 'Invite expired' });
      }

      const { data: household } = await supabase
        .from('households')
        .select('name')
        .eq('id', invite.household_id)
        .single();

      res.json({
        household_name: household?.name || 'a household',
        email: invite.email,
        role: invite.role,
        invite_code: invite.invite_code,
      });
    } catch (err) {
      console.error('Get invite error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/household/accept — the logged-in user accepts an invite by
  // { code } (preferred) or { token }. If the user is currently the sole owner
  // of their own auto-created household, that household is replaced: their
  // packages move into the invited household and the empty one is removed.
  router.post('/accept', auth.authMiddleware, async (req, res) => {
    try {
      const userId = auth.getUserId(req);
      const userEmail = (req.user.email || '').toLowerCase();
      const code = (req.body.code || '').trim().toUpperCase();
      const token = (req.body.token || '').trim();
      if (!code && !token) {
        return res.status(400).json({ error: 'An invite code is required' });
      }

      // Look up the invitation by code or token
      let q = supabase.from('household_invitations').select('*');
      q = code ? q.eq('invite_code', code) : q.eq('token', token);
      const { data: invite, error: invErr } = await q.maybeSingle();
      if (invErr) throw invErr;
      if (!invite) return res.status(404).json({ error: 'Invite not found' });
      if (invite.accepted_at) return res.status(410).json({ error: 'Invite already used' });
      if (new Date(invite.expires_at) < new Date()) {
        return res.status(410).json({ error: 'Invite expired' });
      }
      if (invite.email.toLowerCase() !== userEmail) {
        return res.status(403).json({
          error: 'This invite was sent to a different email address',
        });
      }

      // Handle the user's existing household, if any.
      const existing = await getMembership(supabase, userId);
      if (existing) {
        if (existing.household_id === invite.household_id) {
          return res.status(409).json({ error: 'You are already in this household' });
        }
        const { count } = await supabase
          .from('household_members')
          .select('id', { count: 'exact', head: true })
          .eq('household_id', existing.household_id);
        // Only auto-replace a private, solo household. Otherwise make them leave first.
        if ((count || 0) > 1 || existing.role !== 'owner') {
          return res.status(409).json({
            error: 'Leave your current household before joining another',
          });
        }
      }

      // Link the accepting user to the pending member row in the invited household
      const { data: pending, error: pendErr } = await supabase
        .from('household_members')
        .select('id')
        .eq('household_id', invite.household_id)
        .is('user_id', null)
        .ilike('invite_email', invite.email)
        .maybeSingle();
      if (pendErr) throw pendErr;
      if (!pending) {
        return res.status(404).json({ error: 'Pending membership not found' });
      }

      const { data: member, error: updErr } = await supabase
        .from('household_members')
        .update({ user_id: userId, invite_email: null, joined_at: new Date().toISOString() })
        .eq('id', pending.id)
        .select()
        .single();
      if (updErr) throw updErr;

      // Move the user's packages into the new household and dispose of the old
      // solo household (FK on packages.household_id would block deleting it
      // while packages still point there, so repoint first).
      if (existing) {
        await supabase
          .from('packages')
          .update({ household_id: invite.household_id, recipient_member_id: member.id })
          .eq('user_id', userId)
          .eq('household_id', existing.household_id);

        await supabase.from('households').delete().eq('id', existing.household_id);
      }

      await supabase
        .from('household_invitations')
        .update({ accepted_at: new Date().toISOString() })
        .eq('id', invite.id);

      res.json({ success: true, member });
    } catch (err) {
      console.error('Accept invite error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/household/members/:id — edit own display name, or (owner) any member
  router.patch('/members/:id', auth.authMiddleware, async (req, res) => {
    try {
      const userId = auth.getUserId(req);
      const membership = await getMembership(supabase, userId);
      if (!membership) return res.status(404).json({ error: 'No household' });

      const { data: target, error: tErr } = await supabase
        .from('household_members')
        .select('*')
        .eq('id', req.params.id)
        .single();
      if (tErr || !target) return res.status(404).json({ error: 'Member not found' });
      if (target.household_id !== membership.household_id) {
        return res.status(403).json({ error: 'Not in your household' });
      }

      const isSelf = target.user_id === userId;
      const isOwner = membership.role === 'owner';
      if (!isSelf && !isOwner) {
        return res.status(403).json({ error: 'Not allowed' });
      }

      const updates = {};
      if (typeof req.body.display_name === 'string') {
        const dn = req.body.display_name.trim();
        if (dn) updates.display_name = dn;
      }
      // Only the owner can change roles
      if (req.body.role && isOwner) {
        if (!['owner', 'member'].includes(req.body.role)) {
          return res.status(400).json({ error: 'Invalid role' });
        }
        updates.role = req.body.role;
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Nothing to update' });
      }

      const { data, error } = await supabase
        .from('household_members')
        .update(updates)
        .eq('id', target.id)
        .select()
        .single();
      if (error) throw error;
      res.json(data);
    } catch (err) {
      console.error('Update member error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/household/members/:id — owner removes a member, or member leaves
  router.delete('/members/:id', auth.authMiddleware, async (req, res) => {
    try {
      const userId = auth.getUserId(req);
      const membership = await getMembership(supabase, userId);
      if (!membership) return res.status(404).json({ error: 'No household' });

      const { data: target, error: tErr } = await supabase
        .from('household_members')
        .select('*')
        .eq('id', req.params.id)
        .single();
      if (tErr || !target) return res.status(404).json({ error: 'Member not found' });
      if (target.household_id !== membership.household_id) {
        return res.status(403).json({ error: 'Not in your household' });
      }

      const isSelf = target.user_id === userId;
      const isOwner = membership.role === 'owner';
      if (!isSelf && !isOwner) {
        return res.status(403).json({ error: 'Not allowed' });
      }

      // Don't let the last owner leave while others remain — they'd orphan the household.
      if (target.role === 'owner') {
        const { count } = await supabase
          .from('household_members')
          .select('id', { count: 'exact', head: true })
          .eq('household_id', membership.household_id);
        if ((count || 0) > 1) {
          return res.status(409).json({
            error: 'Transfer ownership to another member before leaving',
          });
        }
      }

      // packages.recipient_member_id auto-nulls via ON DELETE SET NULL.
      const { error } = await supabase
        .from('household_members')
        .delete()
        .eq('id', target.id);
      if (error) throw error;
      res.json({ success: true });
    } catch (err) {
      console.error('Delete member error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createHouseholdRouter, getMembership };
