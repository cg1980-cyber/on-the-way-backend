const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// SECURITY: Get secrets from environment
const JWT_SECRET = process.env.JWT_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TOKEN_EXPIRY = '24h';

/**
 * Validate security configuration on startup
 */
function validateSecurityConfig() {
    const required = ['JWT_SECRET', 'WEBHOOK_SECRET'];
    const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
        throw new Error(`Missing security configuration: ${missing.join(', ')}`);
  }
}

/**
 * Generate JWT token for authenticated user
 */
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
        issuer: 'on-the-way-app'
  });
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
    if (!JWT_SECRET) {
          throw new Error('JWT_SECRET not configured');
    }

  try {
        return jwt.verify(token, JWT_SECRET, {
                algorithms: ['HS256'],
                issuer: 'on-the-way-app'
        });
  } catch (error) {
        if (error.name === 'TokenExpiredError') {
                throw new Error('Token expired');
        }
        if (error.name === 'JsonWebTokenError') {
                throw new Error('Invalid token');
        }
        throw error;
  }
}

/**
 * Express middleware to verify JWT
 */
function authMiddleware(req, res, next) {
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
        const decoded = verifyToken(token);
        req.user = {
                userId: decoded.userId,
                email: decoded.email,
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

/**
 * Verify webhook signature
 */
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

/**
 * Extract Bearer token
 */
function extractToken(authHeader) {
    if (!authHeader || typeof authHeader !== 'string') {
          return null;
    }

  const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
          return null;
    }

  return parts[1];
}

/**
 * Get user ID from request
 */
function getUserId(req) {
    if (!req.user || !req.user.userId) {
          throw new Error('User not authenticated');
    }
    return req.user.userId;
}

/**
 * Rate limiting
 */
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
                              return (Array.isArray(ips) ? ips[0] : ips).trim();
                  }
                  return req.ip || req.connection.remoteAddress;
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
                        return (Array.isArray(ips) ? ips[0] : ips).trim();
              }
              return req.ip || req.connection.remoteAddress;
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
