// Content-Sniffing Validation — shared across every upload endpoint.
//
// Future CR — CONTENT-SNIFFING VALIDATION (originally raised in Phase 5
// Decisions §4/S5, deferred at the time as "requires a new parsing
// dependency"). Promoted to in-scope, Phase 10 Gap Audit follow-up
// (flagged High priority in the consolidated Future CR register).
//
// Every upload endpoint in this codebase (Documents, Cashout attachments,
// Complaints, Customer Portal complaints, Settings logo) validated file
// type using ONLY the client-supplied `mimetype` (the request's
// Content-Type for that part) and the filename's extension — both fully
// attacker-controlled. A file renamed malware.exe -> report.pdf with a
// spoofed part Content-Type passed every check that existed before this
// module. Implemented via manual magic-byte inspection instead of adding
// a new npm dependency (file-type et al.) — deliberately narrower than
// the originally-deferred CR, but closes the actual exploitable gap
// without the separate dependency-addition decision that CR was deferred
// over.
//
// text/csv and text/plain have no reliable magic bytes (plain text) —
// instead rejected if the sample contains a NUL byte, a strong signal of
// binary content masquerading as text (a real CSV/text file never
// legitimately does).
function sniffFileType(buffer, mimetype) {
  if (!buffer || buffer.length === 0) return false;
  const b = buffer;
  switch (mimetype) {
    case 'application/pdf':
      return b.slice(0, 5).toString('latin1') === '%PDF-';
    case 'image/png':
      return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
    case 'image/jpeg':
    case 'image/jpg':
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/webp':
      return b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP';
    // .docx / .xlsx are ZIP containers — the OOXML-specific internal
    // structure isn't worth parsing here; confirming it's a genuine ZIP
    // (not an EXE/script with a renamed extension) is the actual security
    // boundary this check exists for.
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
    // Legacy .doc / .xls — OLE Compound File Binary signature, shared by
    // both formats (same reasoning as the ZIP case above).
    case 'application/msword':
    case 'application/vnd.ms-excel':
      return b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1;
    case 'text/csv':
    case 'text/plain':
      return !b.slice(0, 8192).includes(0x00);
    default:
      return false; // unreachable when called after a MIME allowlist check
  }
}

module.exports = { sniffFileType };
