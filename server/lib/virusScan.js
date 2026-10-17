// Antivirus scanning for uploaded files, via a local ClamAV daemon (clamd).
// Files never leave the server. Disabled unless CLAMAV_ENABLED=true, so local
// development and the test suite are unaffected by default.
//
//   CLAMAV_ENABLED=true
//   CLAMAV_SOCKET=/var/run/clamav/clamd.ctl     (default)   -or-   CLAMAV_HOST / CLAMAV_PORT (TCP)
//   CLAMAV_FAIL_MODE=open|closed                 (default open)
//     open   : if clamd is unreachable, allow the upload and log a warning
//     closed : if clamd is unreachable, reject the upload with 503
//   CLAMAV_TIMEOUT_MS=20000                      (default)
//
// Talks the clamd INSTREAM protocol directly over `net` — no npm dependency.
const net = require('net');
const fs = require('fs');
const logger = require('./logger');

const CHUNK = 64 * 1024;

function config() {
  return {
    enabled: String(process.env.CLAMAV_ENABLED || '').toLowerCase() === 'true',
    socket: process.env.CLAMAV_SOCKET || '/var/run/clamav/clamd.ctl',
    host: process.env.CLAMAV_HOST || null,
    port: parseInt(process.env.CLAMAV_PORT || '3310', 10),
    failMode: String(process.env.CLAMAV_FAIL_MODE || 'open').toLowerCase() === 'closed' ? 'closed' : 'open',
    timeoutMs: parseInt(process.env.CLAMAV_TIMEOUT_MS || '20000', 10),
  };
}

// Parses a clamd reply such as "stream: OK", "stream: Eicar-Test-Signature FOUND" or "... ERROR".
function parseReply(text) {
  const t = text.replace(/\0/g, '').trim();
  if (/\bOK$/.test(t)) return { status: 'clean' };
  const found = t.match(/^stream:\s*(.+?)\s+FOUND$/);
  if (found) return { status: 'infected', signature: found[1] };
  return { status: 'error', message: t || 'empty reply from clamd' };
}

// Scans a Buffer. Resolves { status: 'clean' | 'infected' | 'error', signature?, message? } — never rejects.
function scanBuffer(buffer, cfg = config()) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; socket.destroy(); resolve(r); } };
    const socket = cfg.host ? net.connect({ host: cfg.host, port: cfg.port }) : net.connect({ path: cfg.socket });
    let reply = '';
    socket.setTimeout(cfg.timeoutMs, () => done({ status: 'error', message: 'clamd timed out' }));
    socket.on('error', (e) => done({ status: 'error', message: e.message }));
    socket.on('data', (d) => { reply += d.toString('latin1'); });
    socket.on('end', () => done(parseReply(reply)));
    socket.on('close', () => done(parseReply(reply)));
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < buffer.length; i += CHUNK) {
        const part = buffer.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4); len.writeUInt32BE(part.length, 0);
        socket.write(len); socket.write(part);
      }
      socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
    });
  });
}

// Express helper used by every upload route, right after content-sniffing.
// Returns true if it already sent a response (the caller must `return`).
//   buffer   : the file bytes (memoryStorage routes)
//   filePath : path on disk (diskStorage routes) — read back, and deleted if rejected
async function rejectIfInfected(req, res, { buffer, filePath, label } = {}) {
  const cfg = config();
  if (!cfg.enabled) return false;
  const bytes = buffer || (filePath ? fs.readFileSync(filePath) : null);
  if (!bytes) return false;

  const result = await scanBuffer(bytes, cfg);
  if (result.status === 'clean') return false;

  const discard = () => { if (filePath) fs.unlink(filePath, () => {}); };
  const actor = { actorId: (req.user && req.user.id) || null, actorUsername: (req.user && (req.user.username || req.user.phone)) || null };
  const audit = async (action, extra) => {
    try { await require('../db').logAudit({ ...actor, action, entityType: 'upload', entityId: null, after: { route: req.path, label: label || null, ...extra } }); }
    catch (e) { logger.error('virus_scan_audit_failed', { message: e.message }); }
  };

  if (result.status === 'infected') {
    discard();
    await audit('upload.virus_detected', { signature: result.signature });
    logger.error('upload_virus_detected', { path: req.path, signature: result.signature });
    res.status(422).json({ error: { message: 'This file was rejected because it contains malware.', code: 'MALWARE_DETECTED' } });
    return true;
  }

  // scanner unavailable
  logger.error('virus_scan_unavailable', { path: req.path, message: result.message, failMode: cfg.failMode });
  await audit('upload.scan_unavailable', { reason: result.message, failMode: cfg.failMode });
  if (cfg.failMode === 'closed') {
    discard();
    res.status(503).json({ error: { message: 'File scanning is temporarily unavailable. Please try again shortly.', code: 'SCAN_UNAVAILABLE' } });
    return true;
  }
  return false;
}

module.exports = { scanBuffer, rejectIfInfected, parseReply, config };
