const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool } = require('../db');
const { sniffFileType } = require('../lib/fileSniff');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  MANAGEMENT_ROLES, createComplaint, getComplaintsForStaff, getComplaintDetailForStaff,
  updateComplaintStatus, assignComplaint, replyToComplaint, setComplaintPriority,
} = require('../lib/complaintsService');

const router = express.Router();

// Final approved RBAC (Implementation Spec §9 + user's Clarification 2):
// Admin/Gudoomiye = full management. Zone Accountant/Head of Cashiers =
// read-only. Cashier = NO ACCESS (superseded from the original "own
// cashier-scope" wording — no V2-native cashier-scope engine exists, and
// none is built here per the explicit instruction not to invent one).
// Collector = no access. No new RBAC role.
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'complaints');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.includes(file.mimetype)),
});

function parseStrictId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  return parseInt(raw, 10);
}

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const zoneId = await resolveUserZoneId(req.user);
    const status = req.query.status || null;
    const rows = await getComplaintsForStaff({ zoneId, status });
    return res.json({ data: rows });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load complaints.', code: 'INTERNAL' } });
  }
});

// Staff-initiated creation — Admin/Gudoomiye only (approved OD-3).
router.post('/', authenticateToken, requireRole(...MANAGEMENT_ROLES), async (req, res) => {
  const { customer_id, title, description, priority } = req.body || {};
  const customerId = parseStrictId(customer_id);
  if (customerId === null) return res.status(400).json({ error: { message: 'A valid customer_id is required.', code: 'VALIDATION' } });
  if (typeof title !== 'string' || !title.trim() || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: { message: 'title and description are required.', code: 'VALIDATION' } });
  }
  const validPriority = ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';
  try {
    const custRes = await pool.query('SELECT id FROM customers WHERE id = $1', [customerId]);
    if (custRes.rows.length === 0) return res.status(404).json({ error: { message: 'Customer not found.', code: 'NOT_FOUND' } });
    const complaint = await createComplaint({
      customerId, title: title.trim(), description: description.trim(), priority: validPriority,
      source: 'staff', createdBy: req.user.id,
    });
    return res.status(201).json({ data: complaint });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to create complaint.', code: 'INTERNAL' } });
  }
});

router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
  try {
    const zoneId = await resolveUserZoneId(req.user);
    const complaint = await getComplaintDetailForStaff({ complaintId: id, zoneId });
    if (!complaint) return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
    return res.json({ data: complaint });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load complaint.', code: 'INTERNAL' } });
  }
});

router.put('/:id/status', authenticateToken, requireRole(...MANAGEMENT_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
  const { status } = req.body || {};
  if (!['pending', 'in_progress', 'resolved', 'closed'].includes(status)) {
    return res.status(400).json({ error: { message: 'Invalid status value.', code: 'VALIDATION' } });
  }
  try {
    const zoneId = await resolveUserZoneId(req.user);
    const result = await updateComplaintStatus({ complaintId: id, newStatus: status, actorId: req.user.id, zoneId });
    if (result.error === 'NOT_FOUND') return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
    if (result.error === 'ILLEGAL_TRANSITION') {
      return res.status(400).json({ error: { message: `Cannot transition from '${result.before}' to '${status}'.`, code: 'VALIDATION' } });
    }
    return res.json({ data: result.data });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to update status.', code: 'INTERNAL' } });
  }
});

router.put('/:id/assign', authenticateToken, requireRole(...MANAGEMENT_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  const employeeId = parseStrictId(req.body?.employee_id);
  if (id === null) return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
  if (employeeId === null) return res.status(400).json({ error: { message: 'A valid employee_id is required.', code: 'VALIDATION' } });
  try {
    const zoneId = await resolveUserZoneId(req.user);
    const result = await assignComplaint({ complaintId: id, employeeId, actorId: req.user.id, zoneId });
    if (result.error === 'NOT_FOUND') return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
    if (result.error === 'EMPLOYEE_NOT_FOUND') return res.status(400).json({ error: { message: 'Employee not found.', code: 'VALIDATION' } });
    if (result.error === 'EMPLOYEE_INACTIVE') return res.status(400).json({ error: { message: 'Employee is not active.', code: 'VALIDATION' } });
    if (result.error === 'EMPLOYEE_INELIGIBLE_TYPE') return res.status(400).json({ error: { message: 'Employee is not eligible for complaint assignment (office staff only).', code: 'VALIDATION' } });
    if (result.error === 'EMPLOYEE_WRONG_ZONE') return res.status(400).json({ error: { message: 'Employee does not belong to this complaint\'s zone.', code: 'VALIDATION' } });
    return res.json({ data: result.data });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to assign complaint.', code: 'INTERNAL' } });
  }
});

router.put('/:id/priority', authenticateToken, requireRole(...MANAGEMENT_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
  const { priority } = req.body || {};
  if (!['low', 'medium', 'high'].includes(priority)) {
    return res.status(400).json({ error: { message: 'Invalid priority value.', code: 'VALIDATION' } });
  }
  try {
    const zoneId = await resolveUserZoneId(req.user);
    const result = await setComplaintPriority({ complaintId: id, priority, actorId: req.user.id, zoneId });
    if (result.error === 'NOT_FOUND') return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
    return res.json({ data: result.data });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to update priority.', code: 'INTERNAL' } });
  }
});

router.put('/:id/reply', authenticateToken, requireRole(...MANAGEMENT_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
  const { reply } = req.body || {};
  if (typeof reply !== 'string' || !reply.trim()) {
    return res.status(400).json({ error: { message: 'Reply cannot be empty.', code: 'VALIDATION' } });
  }
  try {
    const zoneId = await resolveUserZoneId(req.user);
    const result = await replyToComplaint({ complaintId: id, reply: reply.trim(), actorId: req.user.id, zoneId });
    if (result.error === 'NOT_FOUND') return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
    return res.json({ data: result.data });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to save reply.', code: 'INTERNAL' } });
  }
});

router.post('/:id/attachments', authenticateToken, requireRole(...MANAGEMENT_ROLES), upload.single('file'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
  if (!req.file) return res.status(400).json({ error: { message: 'A file (PDF, JPEG, or PNG, max 10MB) is required.', code: 'VALIDATION' } });
  // Content-sniffing validation (Future CR promoted to in-scope, Phase 10
  // Gap Audit) — see lib/fileSniff.js. diskStorage means the file is
  // already written by the time this handler runs; read it back to sniff.
  if (!sniffFileType(fs.readFileSync(req.file.path), req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: { message: 'File content does not match its claimed type.', code: 'VALIDATION' } });
  }
  try {
    const complaintRes = await pool.query('SELECT id FROM complaints WHERE id = $1', [id]);
    if (complaintRes.rows.length === 0) return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
    const r = await pool.query(
      `INSERT INTO complaint_attachments (complaint_id, original_filename, storage_path, mime_type, file_size, uploaded_by_customer, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, FALSE, $6) RETURNING id, original_filename, mime_type, uploaded_at`,
      [id, req.file.originalname, req.file.path, req.file.mimetype, req.file.size, req.user.id]
    );
    return res.status(201).json({ data: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to upload attachment.', code: 'INTERNAL' } });
  }
});

router.get('/:id/attachments/:attId', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  const attId = parseStrictId(req.params.attId);
  if (id === null || attId === null) return res.status(404).json({ error: { message: 'Attachment not found.', code: 'NOT_FOUND' } });
  try {
    const zoneId = await resolveUserZoneId(req.user);
    const complaint = await getComplaintDetailForStaff({ complaintId: id, zoneId });
    if (!complaint) return res.status(404).json({ error: { message: 'Attachment not found.', code: 'NOT_FOUND' } });
    const attRes = await pool.query('SELECT * FROM complaint_attachments WHERE id = $1 AND complaint_id = $2', [attId, id]);
    if (attRes.rows.length === 0) return res.status(404).json({ error: { message: 'Attachment not found.', code: 'NOT_FOUND' } });
    return res.download(attRes.rows[0].storage_path, attRes.rows[0].original_filename);
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load attachment.', code: 'INTERNAL' } });
  }
});

module.exports = router;
