// server.js
// On the Way — backend server
// Receives carrier emails via webhook, stores packages in Supabase

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { parseCarrierEmail } = require('./emailParser');
const auth = require('./auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Validate config on startup
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
    const parsed = parseCarrierEmail({ from, subject, text, html });

    // Check if we already have a package with this tracking number for this user
    // to avoid duplicate entries from multiple status update emails
    let packageRecord;

    if (parsed.trackingNumber) {
      const { data: existing } = await supabase
        .from('packages')
        .select('id, status')
        .eq('user_id', user.id)
        .eq('tracking_number', parsed.trackingNumber)
        .single();

      if (existing) {
        // Update the existing package's status
        const { data: updated, error: updateError } = await supabase
          .from('packages')
          .update({
            status: parsed.status,
            estimated_delivery: parsed.estimatedDelivery,
            last_updated: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (updateError) throw updateError;
        packageRecord = updated;
        console.log(`Updated package ${parsed.trackingNumber} for user ${user.id}: ${parsed.status}`);
      }
    }

    // If no existing package was found (or no tracking number), create a new one
    if (!packageRecord) {
      const { data: newPackage, error: insertError } = await supabase
        .from('packages')
        .insert({
          user_id: user.id,
          tracking_number: parsed.trackingNumber || null,
          carrier: parsed.carrier,
          status: parsed.status,
          merchant: parsed.merchant,
          estimated_delivery: parsed.estimatedDelivery,
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

    const { data, error } = await supabase
      .from('packages')
      .select('*')
      .eq('user_id', userId)
      .order('last_updated', { ascending: false });

    if (error) throw error;
    res.json(data);

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

    const { nickname, archived, deleted } = req.body;

    const { data, error } = await supabase
      .from('packages')
      .update({ nickname, archived, deleted })
      .eq('id', req.params.id)
      .eq('user_id', userId)  // Ensures user can only update their own packages
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

    const { error } = await supabase
      .from('packages')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', userId);

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
