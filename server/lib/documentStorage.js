const fs = require('fs');
const path = require('path');

// Master Functional Completion Program — Phase 5: Document & File
// Management. This is the ONE seam between the rest of the app and the
// filesystem — no route or business-logic file ever calls fs/multer
// storage details directly (Implementation Specification §7/§8). This
// exists specifically so a future object-storage backend (Future CR —
// PRODUCTION OBJECT STORAGE MIGRATION) can be swapped in without any
// caller-side change: putFile/getFileStream/deleteFile is the whole
// contract.
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'documents');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Defense-in-depth: storageKey is always server-generated (never derived
// from client input — see generateStorageKey below), but every read/write
// additionally asserts the resolved path stays inside UPLOAD_DIR before
// touching the filesystem at all, per §18 (Path Traversal Protection).
function resolveSafePath(storageKey) {
  const resolved = path.resolve(UPLOAD_DIR, storageKey);
  if (!resolved.startsWith(UPLOAD_DIR + path.sep) && resolved !== UPLOAD_DIR) {
    throw new Error('Resolved storage path escapes the upload directory.');
  }
  return resolved;
}

async function putFile(buffer, storageKey) {
  const filePath = resolveSafePath(storageKey);
  await fs.promises.writeFile(filePath, buffer);
}

function getFileStream(storageKey) {
  const filePath = resolveSafePath(storageKey);
  return fs.createReadStream(filePath);
}

function fileExists(storageKey) {
  try {
    return fs.existsSync(resolveSafePath(storageKey));
  } catch (err) {
    return false;
  }
}

// Reserved for a future orphan-sweep process (Implementation Specification
// §31) — never invoked by any MVP route (void/archive/restore do not call
// this; a binary is only ever removed synchronously on an upload-time
// rollback, via the caller's own try/catch, not through this function).
async function deleteFile(storageKey) {
  const filePath = resolveSafePath(storageKey);
  await fs.promises.unlink(filePath).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

module.exports = { UPLOAD_DIR, putFile, getFileStream, fileExists, deleteFile };
