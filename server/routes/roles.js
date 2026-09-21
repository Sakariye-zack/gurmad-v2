const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

// Dynamic Roles & Permissions (user-requested) — admin-only. Lets a Super
// Admin create a new role and control what it can see, without a developer
// touching code, by toggling rows in role_permissions (server/db.js's own
// migration seeds the 6 system roles + the full permission catalog).
//
// Scope note (disclosed in the plan): a brand-new custom role controls what
// that user's Sidebar shows (via GET /my-permissions, RoleGate's
// `permission` check) but does NOT retroactively change what the existing
// requireRole(...roleNames) calls across the rest of the backend allow —
// those still only recognize the 6 original role-name strings. That
// route-level migration is an explicitly separate, later phase.

const router = express.Router();

function slugify(label) {
  return String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

router.get('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const roles = await pool.query('SELECT id, key, label, is_system FROM roles ORDER BY is_system DESC, label');
    const perms = await pool.query(
      `SELECT rp.role_id, p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id`
    );
    const permsByRole = {};
    for (const row of perms.rows) {
      (permsByRole[row.role_id] ||= []).push(row.key);
    }
    const data = roles.rows.map((r) => ({ ...r, permissions: permsByRole[r.id] || [] }));
    return res.json({ data });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load roles.', code: 'INTERNAL' } });
  }
});

router.get('/permissions', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query('SELECT id, key, module, action, label FROM permissions ORDER BY module, action');
    return res.json({ data: r.rows });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load permission catalog.', code: 'INTERNAL' } });
  }
});

router.post('/', authenticateToken, requireRole('admin'), async (req, res) => {
  const { label } = req.body || {};
  if (typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ error: { message: 'label is required.', code: 'VALIDATION' } });
  }
  const key = slugify(label);
  if (!key) return res.status(400).json({ error: { message: 'label must contain at least one letter or number.', code: 'VALIDATION' } });
  try {
    const ins = await pool.query(
      `INSERT INTO roles (key, label, is_system) VALUES ($1, $2, FALSE) RETURNING id, key, label, is_system`,
      [key, label.trim()]
    );
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'create', entityType: 'role', entityId: ins.rows[0].id, after: ins.rows[0] });
    return res.status(201).json({ data: { ...ins.rows[0], permissions: [] } });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: { message: 'A role with that name already exists.', code: 'VALIDATION' } });
    }
    return res.status(500).json({ error: { message: 'Failed to create role.', code: 'INTERNAL' } });
  }
});

router.put('/:id/permissions', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: { message: 'Role not found.', code: 'NOT_FOUND' } });
  const { permission_keys } = req.body || {};
  if (!Array.isArray(permission_keys)) {
    return res.status(400).json({ error: { message: 'permission_keys must be an array.', code: 'VALIDATION' } });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roleRes = await client.query('SELECT id, key, label FROM roles WHERE id = $1', [id]);
    if (roleRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Role not found.', code: 'NOT_FOUND' } });
    }
    let permIds = [];
    if (permission_keys.length > 0) {
      const permRes = await client.query('SELECT id, key FROM permissions WHERE key = ANY($1)', [permission_keys]);
      permIds = permRes.rows.map((r) => r.id);
    }
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
    for (const permId of permIds) {
      await client.query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [id, permId]);
    }
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'update', entityType: 'role_permissions', entityId: id, after: { permission_keys } });
    return res.json({ data: { id, permissions: permission_keys } });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: { message: 'Failed to update role permissions.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: { message: 'Role not found.', code: 'NOT_FOUND' } });
  try {
    const roleRes = await pool.query('SELECT id, is_system, label FROM roles WHERE id = $1', [id]);
    if (roleRes.rows.length === 0) return res.status(404).json({ error: { message: 'Role not found.', code: 'NOT_FOUND' } });
    if (roleRes.rows[0].is_system) {
      return res.status(400).json({ error: { message: 'System roles cannot be deleted.', code: 'VALIDATION' } });
    }
    const inUse = await pool.query('SELECT COUNT(*)::int AS n FROM v2_users WHERE role_id = $1', [id]);
    if (inUse.rows[0].n > 0) {
      return res.status(400).json({ error: { message: 'This role is still assigned to one or more users.', code: 'VALIDATION' } });
    }
    await pool.query('DELETE FROM roles WHERE id = $1', [id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'delete', entityType: 'role', entityId: id, before: roleRes.rows[0] });
    return res.json({ data: { message: 'Role deleted.' } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to delete role.', code: 'INTERNAL' } });
  }
});

module.exports = router;
