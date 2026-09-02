const jwt = require('jsonwebtoken');
const { pool } = require('../db');

// Phase 4 — Customer Portal — OD-1: portal identity must remain
// structurally separate from staff auth, without building a second
// general-purpose RBAC engine. The separation is a DISTINCT SIGNING
// SECRET (never the staff JWT_SECRET) — a staff token fails verification
// here with an ordinary invalid-signature error, and a portal token fails
// the same way against staff's authenticateToken. No claim-comparison to
// get wrong; the cryptography itself enforces the boundary.
const CUSTOMER_PORTAL_JWT_SECRET = process.env.CUSTOMER_PORTAL_JWT_SECRET;
if (!CUSTOMER_PORTAL_JWT_SECRET) {
  console.error('FATAL: CUSTOMER_PORTAL_JWT_SECRET is not set. V2 backend refuses to start with an insecure fallback secret.');
  process.exit(1);
}
if (CUSTOMER_PORTAL_JWT_SECRET === process.env.JWT_SECRET) {
  console.error('FATAL: CUSTOMER_PORTAL_JWT_SECRET must not equal JWT_SECRET — portal and staff auth must use distinct secrets (OD-1).');
  process.exit(1);
}

const PORTAL_TOKEN_TTL = '24h';

// Rebuild — Implementation Spec §6/§5: the token embeds the account's
// CURRENT token_version at issue time. Revocation (password change/reset,
// admin disable, "log out of all devices") bumps the stored counter —
// every token issued before that bump then fails the comparison below on
// its very next use, everywhere, with no propagation delay (the check
// reads the live DB row on every request, not a cache).
function issuePortalToken({ portalAccountId, customerId, tokenVersion }) {
  return jwt.sign(
    { portalAccountId, customerId, tokenVersion, type: 'customer_portal' },
    CUSTOMER_PORTAL_JWT_SECRET,
    { expiresIn: PORTAL_TOKEN_TTL }
  );
}

// Every portal route uses req.customerId (from the verified token) as the
// ONLY source of ownership scope — never a client-supplied customer_id,
// per OD-1/§10 of the Implementation Spec.
async function authenticateCustomerPortal(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: { message: 'Authentication required.', code: 'AUTH_REQUIRED' } });
  }
  jwt.verify(token, CUSTOMER_PORTAL_JWT_SECRET, async (err, decoded) => {
    if (err || decoded.type !== 'customer_portal') {
      return res.status(401).json({ error: { message: 'Invalid or expired token.', code: 'AUTH_INVALID' } });
    }
    try {
      // token_version check — a mismatch (revoked token) is treated
      // IDENTICALLY to an invalid signature: same status, same message,
      // no information distinguishing "revoked" from "malformed" is ever
      // leaked to the caller (Rebuild Spec §5).
      const r = await pool.query('SELECT token_version, status FROM customer_portal_accounts WHERE id = $1', [decoded.portalAccountId]);
      const account = r.rows[0];
      if (!account || account.token_version !== decoded.tokenVersion || account.status !== 'active') {
        return res.status(401).json({ error: { message: 'Invalid or expired token.', code: 'AUTH_INVALID' } });
      }
    } catch (e) {
      return res.status(500).json({ error: { message: 'Authentication check failed.', code: 'INTERNAL' } });
    }
    req.portalAccountId = decoded.portalAccountId;
    req.customerId = decoded.customerId;
    next();
  });
}

module.exports = { authenticateCustomerPortal, issuePortalToken, CUSTOMER_PORTAL_JWT_SECRET, PORTAL_TOKEN_TTL };
