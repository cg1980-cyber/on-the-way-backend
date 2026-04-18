/**
 * auth.js — JWT verification for Supabase-issued tokens (ES256 / JWKS)
 *
 * Replaces the previous HS256 + JWT_SECRET implementation.
 *
 * Background:
 *   - The mobile app signs users in via supabase.auth.signInWithPassword and
 *     sends the resulting session.access_token as `Authorization: Bearer ...`
 *     on every backend call.
 *   - Supabase rotated this project from HS256 (shared secret) to ES256
 *     (asymmetric signing), so a shared `JWT_SECRET` can no longer verify new
 *     tokens. We must fetch the public key from Supabase's JWKS endpoint and
 *     verify ES256 (or RS256) signatures.
 *
 * Required env vars on Railway:
 *   - SUPABASE_URL          e.g. https://clqivishcuwlptoumdre.supabase.co
 *   - WEBHOOK_SECRET        (unchanged — used by /api/webhooks)
 *
 * Optional / no longer required:
 *   - JWT_SECRET            (only kept here so legacy generateToken() doesn't
 *                            crash if some old code path still calls it. Safe
 *                            to remove from Railway once you confirm nothing
 *                            references it.)
 */

const jwt = require('jsonwebtoken');           // kept for legacy generateToken
const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify, errors: joseErrors } = require('jose');

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const JWT_SECRET     = process.env.JWT_SECRET;          // legacy / unused
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SUPABASE_URL   = process.env.SUPABASE_URL;        // <-- NEW required var
const TOKEN_EXPIRY   = '24h';

const SUPABASE_JWKS_URL = SUPABASE_URL
  ? `${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`
  : null;

// Cached JWKS — jose re-fetches and caches automatically when keys rotate.
const JWKS = SUPABASE_JWKS_URL
  ? createRemoteJWKSet(new URL(SUPABASE_JWKS_URL))
  : null;

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------
function validateSecurityConfig() {
  const required = ['SUPABASE_URL', 'WEBHOOK_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing security configuration: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Legacy backend-issued token (kept for backwards compatibility with any
// route that still calls generateToken). New auth flows do NOT use this.
// ---------------------------------------------------------------------------
function generateToken(userId, email) {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET not configured');
  }
  const payload = {
    userId,
    email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60),
    jti: crypto.randomBytes(16).toString('hex'),
  };
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: 'HS256',
    issuer: 'on-the-way-app',
  });
}

// ---------------------------------------------------------------------------
// Verify a Supabase-issued access token using JWKS (ES256/RS256)
// Returns a normalized object: { userId, email, ...rawClaims }
// ---------------------------------------------------------------------------
async function verifyToken(token) {
  if (!JWKS) {
    throw new Error('SUPABASE_URL not configured (cannot verify tokens)');
  }

  try {
    // Note: we intentionally do NOT pin `issuer` here. Supabase has used two
    // different issuer formats over time (`https://<ref>.supabase.co` and
    // `https://<ref>.supabase.co/auth/v1`). Signature verification against
    // Supabase's JWKS is sufficient proof that Supabase issued the token;
    // `audience: 'authenticated'` gates on signed-in users.
    const { payload } = await jwtVerify(token, JWKS, {
      audience: 'authenticated',
      algorithms: ['ES256', 'RS256'],
    });

    return {
      userId: payload.sub,        // Supabase puts user id in `sub`
      email:  payload.email,
      jti:    payload.jti,
      ...payload,
    };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      throw new Error('Token expired');
    }
    if (
      error instanceof joseErrors.JWTInvalid ||
      error instanceof joseErrors.JWSSignatureVerificationFailed ||
      error instanceof joseErrors.JWTClaimValidationFailed
    ) {
      throw new Error('Invalid token');
    }
    // Network/JWKS fetch errors etc. — log details but don't leak to caller.
    console.error('Unexpected JWT verification error:', error);
    throw new Error('Invalid token');
  }
}

// ---------------------------------------------------------------------------
// Express middleware (now async)
// ---------------------------------------------------------------------------
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Invalid Authorization header format' });
  }

  const token = parts[1];

  try {
    const decoded = await verifyToken(token);
    req.user = {
      userId:  decoded.userId,
      email:   decoded.email,
      tokenId: decoded.jti,
    };
    next();
  } catch (error) {
    console.warn(`Auth failed: ${error.message} from IP: ${req.ip}`);
    if (error.message === 'Token expired') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------------------------------------------------------------------------
// Webhook signature verification (unchanged)
// ---------------------------------------------------------------------------
function verifyWebhookSignature(emailContent, signature) {
  if (!WEBHOOK_SECRET) {
    throw new Error('WEBHOOK_SECRET not configured');
  }
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(emailContent)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers (unchanged)
// ---------------------------------------------------------------------------
function extractToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  return parts[1];
}

function getUserId(req) {
  if (!req.user || !req.user.userId) {
    throw new Error('User not authenticated');
  }
  return req.user.userId;
}

// ---------------------------------------------------------------------------
// Rate limiting (unchanged)
// ---------------------------------------------------------------------------
const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many API requests',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = typeof forwarded === 'string' ? forwarded.split(',') : forwarded;
      return Array.isArray(ips) ? ips[0].trim() : ips;
    }
    return req.ip || (req.connection && req.connection.remoteAddress);
  },
});

const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many webhook requests',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = typeof forwarded === 'string' ? forwarded.split(',') : forwarded;
      return Array.isArray(ips) ? ips[0].trim() : ips;
    }
    return req.ip || (req.connection && req.connection.remoteAddress);
  },
});

module.exports = {
  validateSecurityConfig,
  generateToken,
  verifyToken,
  authMiddleware,
  verifyWebhookSignature,
  extractToken,
  getUserId,
  apiLimiter,
  webhookLimiter,
};
