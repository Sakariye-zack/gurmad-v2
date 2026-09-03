const jwt = require('jsonwebtoken');
const { resolveAccessContext } = require('../lib/accessResolution');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. V2 backend refuses to start with an insecure fallback secret.');
  process.exit(1);
}

// User & Access Administration — Implementation Spec §1/§2/§6/§10.
//
// Signature verification is UNCHANGED: any token signed with the shared
// JWT_SECRET (issued by either the legacy reference backend or, once a
// user's auth_source = 'v2', V2's own POST /api/v2/auth/login) verifies
// here identically — this is the OD-1 Hybrid architecture's core
// mechanism, not new in this pass.
//
// What's new: after signature verification, this is now the ONE place in
// the whole backend that resolves live authorization state (CRITICAL
// SECURITY REQUIREMENT) — via lib/accessResolution.js, OD-6's shared
// service. req.user is populated with the SAME shape every existing route
// (all 15 files, including the 12 CLOSED/PROTECTED resolveUserZoneId()
// consumers) has always read — { id, username, role, zone } — but the
// VALUES are now live-resolved, not trusted from the token's own claims,
// for any user who has been migrated into v2_users (Preconditions §1).
// requireRole() below, and every existing route file, is UNCHANGED.
//
// A user with no v2_users row yet (not migrated — a legitimate, expected
// state during the phased transition, OD-8) falls back to the token's own
// embedded claims exactly as before this pass — this is the "legacy
// authentication may remain temporarily" half of OD-1, applied per-user,
// not per-deployment.
async function authenticateToken(req, res, next) {
  const header = req.headers['authorization'];
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: { message: 'Authentication required.', code: 'AUTH_REQUIRED' } });
  }
  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: { message: 'Invalid or expired token.', code: 'AUTH_INVALID' } });
    }
    try {
      const ctx = await resolveAccessContext(decoded.id);

      if (ctx) {
        // token_version check (OD-3) — a mismatch is rejected with the
        // IDENTICAL error shape as an invalid signature, never
        // distinguishing "revoked" from "malformed/expired" to the
        // caller, matching the Customer Portal's own established
        // anti-enumeration precedent.
        const claimVersion = decoded.tokenVersion ?? 0;
        if (claimVersion !== ctx.tokenVersion) {
          return res.status(401).json({ error: { message: 'Invalid or expired token.', code: 'AUTH_INVALID' } });
        }
        // Employee deactivation/on_leave/suspended, or the user account
        // itself disabled — CRITICAL SECURITY REQUIREMENT, enforced here,
        // once, for every route in the backend (all 15 files, not just
        // the 12 consumers) with zero write to and zero code change in
        // the closed Employees module. Deliberately mapped to the SAME
        // 403 shape requireRole() already uses for "wrong role" — a
        // deactivated employee cannot distinguish "no permission" from
        // "your employee record is inactive" (Spec §20).
        if (!ctx.authorized) {
          return res.status(403).json({ error: { message: 'You do not have permission to perform this action.', code: 'FORBIDDEN' } });
        }
        req.user = {
          id: ctx.userId,
          username: ctx.username,
          role: ctx.role,       // live from v2_users, not the JWT claim
          zone: ctx.zoneName,   // live-resolved name string — the 12 existing consumer files keep working unchanged against this
          employeeId: ctx.employeeId,
        };
        return next();
      }

      // Not yet migrated — fall back to the token's own claims exactly as
      // every route already behaved before this pass. No token_version
      // check is possible for an account V2 doesn't yet know about.
      req.user = decoded; // { id, username, role, zone, iat, exp }
      return next();
    } catch (e) {
      return res.status(500).json({ error: { message: 'Authentication check failed.', code: 'INTERNAL' } });
    }
  });
}

// Backend authorization is mandatory regardless of what the frontend shows
// (RoleGate is a visibility aid only) — Phase 1 ROLE GATE rule.
// UNCHANGED — reads req.user.role exactly as before; every existing
// requireRole() call site across all 15 route files needs no modification.
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

// Issues a token in the EXACT existing claim shape ({id, username, role,
// zone, exp}) plus tokenVersion (OD-3) — signed with the SAME shared
// JWT_SECRET the legacy backend already uses, so a V2-issued token is
// verifiable by the (unmodified) legacy system too during the Hybrid
// transition (Spec §6/§14), and vice versa. 24h lifetime, unchanged from
// today — no approved decision calls for shortening it.
const STAFF_TOKEN_TTL = '24h';
function issueStaffToken({ id, username, role, zone, tokenVersion }) {
  return jwt.sign({ id, username, role, zone, tokenVersion }, JWT_SECRET, { expiresIn: STAFF_TOKEN_TTL });
}

module.exports = { authenticateToken, requireRole, issueStaffToken, JWT_SECRET };
