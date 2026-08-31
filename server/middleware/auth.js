const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. V2 backend refuses to start with an insecure fallback secret.');
  process.exit(1);
}

// V2 does not reimplement login. The reference backend (T2.8-F, frozen)
// issues the JWT at POST /api/auth/login with payload
// { id, username, role, zone }; this middleware verifies that same token
// (shared JWT_SECRET) so V2's own domain APIs can independently authorize
// requests without a second login system.
function authenticateToken(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: { message: 'Authentication required.', code: 'AUTH_REQUIRED' } });
  }
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: { message: 'Invalid or expired token.', code: 'AUTH_INVALID' } });
    }
    req.user = decoded; // { id, username, role, zone, iat, exp }
    next();
  });
}

// Backend authorization is mandatory regardless of what the frontend shows
// (RoleGate is a visibility aid only) — Phase 1 ROLE GATE rule.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: { message: 'Authentication required.', code: 'AUTH_REQUIRED' } });
    }
    if (req.user.role === 'admin' || roles.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ error: { message: 'You do not have permission to perform this action.', code: 'FORBIDDEN' } });
  };
}

module.exports = { authenticateToken, requireRole };
