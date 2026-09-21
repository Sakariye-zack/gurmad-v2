const { pool } = require('../db');

// User & Access Administration — Implementation Spec §1/§10, OD-6.
//
// THE single authoritative path for turning an authenticated identity into
// a live authorization scope. Nothing outside this module should ever read
// role/zone/employee-status off a JWT claim directly — every value here is
// re-read from v2_users/employees on every call, never cached, never
// trusted from token contents past the id itself.
//
// This directly satisfies the CRITICAL SECURITY REQUIREMENT (Implementation
// Authorization message): a request must resolve current User -> Employee
// -> Role -> Zone -> Authorization Scope, not an old JWT's embedded values.
// It is also, by construction, how Employee deactivation/on_leave blocks
// protected access with ZERO write to (or code change in) the closed
// Employees module (Module 3) — this only ever READS employees.status.

const PROTECTED_EMPLOYEE_STATUSES = ['active'];

// zones.name -> zones.id, the exact lookup every one of the 12
// resolveUserZoneId() copies already performs — centralized here so this
// module is the ONLY place that logic lives going forward (OD-6: "do not
// duplicate resolveUserZoneId() in new routes"). The 12 existing closed
// route files are NOT modified by this workstream (CHANGE REQUEST
// REQUIRED if that consolidation is ever separately authorized) — they
// keep their own local copies, operating on the zone NAME string that
// authenticateToken now populates live (see middleware/auth.js), which is
// how their behavior stays correct without their own code changing at all.
async function resolveZoneIdByName(zoneName, client = pool) {
  if (!zoneName) return null;
  const r = await client.query('SELECT id FROM zones WHERE name = $1', [zoneName]);
  return r.rows[0]?.id ?? null;
}

// zones.id -> zones.name (the reverse direction), needed because an
// employee's own zone_id (Module 3's authoritative field) is preferred
// over v2_users.zone (a name string, fallback-only per Spec §11) whenever
// a linked employee exists — but authenticateToken must still populate
// req.user.zone as a NAME (matching the shape the 12 existing consumer
// files already expect), so a live zone_id needs converting back.
async function resolveZoneNameById(zoneId, client = pool) {
  if (zoneId === null || zoneId === undefined) return null;
  const r = await client.query('SELECT name FROM zones WHERE id = $1', [zoneId]);
  return r.rows[0]?.name ?? null;
}

// Returns null if the user doesn't exist in v2_users at all (i.e. has not
// yet been migrated, Preconditions §1 — a legitimate, expected state
// during the phased transition, not an error). Callers must treat null as
// "fall back to trusting the JWT's own claims" (middleware/auth.js does
// exactly this), never as a hard failure.
// Dynamic Roles & Permissions (user-requested). role_id is a nullable FK
// resolved live here, same "never trust a cached/token value" rule this
// whole module already enforces for role/zone — a permission grant change
// made in the new Roles & Permissions admin page takes effect on the
// user's very next request, no token action needed. Returns [] for a
// user with no role_id yet (not-yet-backfilled or a raw legacy row).
async function resolvePermissions(roleId, client = pool) {
  if (!roleId) return [];
  const r = await client.query(
    `SELECT p.key FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = $1`,
    [roleId]
  );
  return r.rows.map((row) => row.key);
}

async function resolveAccessContext(userId, client = pool) {
  const userRes = await client.query(
    `SELECT id, username, role, role_id, zone, is_active, token_version, auth_source
     FROM v2_users WHERE id = $1`,
    [userId]
  );
  const user = userRes.rows[0];
  if (!user) return null;

  const empRes = await client.query(
    `SELECT id, status, zone_id FROM employees WHERE user_id = $1`,
    [userId]
  );
  const employee = empRes.rows[0] || null;

  // Zone: prefer the linked employee's own zone_id (Module 3's
  // authoritative field, a real FK) over v2_users.zone (a name string,
  // fallback-only) — this is what makes a zone REASSIGNMENT on the
  // employee record take effect on the very next request, with no token
  // action needed (Spec §1/§11).
  let zoneId = null;
  let zoneName = null;
  if (employee && employee.zone_id !== null && employee.zone_id !== undefined) {
    zoneId = employee.zone_id;
    zoneName = await resolveZoneNameById(zoneId, client);
  } else if (user.zone) {
    zoneName = user.zone;
    zoneId = await resolveZoneIdByName(user.zone, client);
  }

  const employeeActive = !employee || PROTECTED_EMPLOYEE_STATUSES.includes(employee.status);
  const permissions = await resolvePermissions(user.role_id, client);

  return {
    userId: user.id,
    username: user.username,
    role: user.role,
    permissions,
    zoneId,
    zoneName,
    employeeId: employee ? employee.id : null,
    employeeStatus: employee ? employee.status : null,
    // true only when: the user account itself is active AND (there is no
    // linked employee at all, OR the linked employee's status is
    // 'active'). 'on_leave'/'suspended'/'archived' all resolve to false
    // here — OD-5's CRITICAL requirement, enforced in exactly one place.
    authorized: user.is_active && employeeActive,
    isActive: user.is_active,
    tokenVersion: user.token_version,
    authSource: user.auth_source,
  };
}

module.exports = { resolveAccessContext, resolveZoneIdByName, resolveZoneNameById, PROTECTED_EMPLOYEE_STATUSES };
