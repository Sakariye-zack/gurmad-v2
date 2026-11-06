const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { sniffFileType } = require('./fileSniff');
const { rejectIfInfected } = require('./virusScan');

// Fleet receipts (fuel / maintenance) and truck photos. Same pattern as the
// avatar and complaint uploads: multer disk storage with a server-generated
// filename, MIME allowlist, magic-byte sniffing, then the ClamAV scan.
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'fleet');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_BYTES = 5 * 1024 * 1024;
const RECEIPT_MIME = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const PHOTO_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const EXT = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

function makeUpload(allowed, prefix) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOAD_DIR),
      filename: (req, file, cb) => cb(null, `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${EXT[file.mimetype] || ''}`),
    }),
    limits: { fileSize: MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => cb(null, allowed.includes(file.mimetype)),
  });
}
const receiptUpload = makeUpload(RECEIPT_MIME, 'receipt');
const photoUpload = makeUpload(PHOTO_MIME, 'truck');

// Express middleware: parse one file field, turning multer errors into 400s.
function single(upload, field = 'file') {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: { message: 'File exceeds the maximum allowed size (5MB).', code: 'VALIDATION' } });
        return res.status(400).json({ error: { message: 'Invalid file upload.', code: 'VALIDATION' } });
      }
      next();
    });
  };
}

// After multer: require a file, sniff it, virus-scan it. Returns true when a
// response was already sent (caller must return).
async function rejectBadFile(req, res, { kindsLabel, label }) {
  if (!req.file) {
    res.status(400).json({ error: { message: `A file is required (${kindsLabel}, max 5MB).`, code: 'VALIDATION' } });
    return true;
  }
  if (!sniffFileType(fs.readFileSync(req.file.path), req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: { message: 'File content does not match its claimed type.', code: 'VALIDATION' } });
    return true;
  }
  return rejectIfInfected(req, res, { filePath: req.file.path, label });
}

function discard(req) {
  if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
}

// Stored values are bare server-generated filenames; never trust them as paths.
function resolveStored(name) {
  if (!name) return null;
  const p = path.resolve(UPLOAD_DIR, path.basename(String(name)));
  if (!p.startsWith(UPLOAD_DIR + path.sep)) return null;
  return fs.existsSync(p) ? p : null;
}

function removeStored(name) {
  const p = resolveStored(name);
  if (p) fs.unlink(p, () => {});
}

function sendStored(res, { name, mime, filename }) {
  const p = resolveStored(name);
  if (!p) return res.status(404).json({ error: { message: 'File not found.', code: 'NOT_FOUND' } });
  res.setHeader('Content-Type', mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const safeName = String(filename || path.basename(p)).replace(/[^\w.\- ]/g, '_').slice(0, 120);
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
  return res.sendFile(p);
}

module.exports = {
  receiptUpload, photoUpload, single, rejectBadFile, discard, resolveStored, removeStored, sendStored,
  UPLOAD_DIR, RECEIPT_MIME, PHOTO_MIME,
};
