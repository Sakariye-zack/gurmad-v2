// Client mirror of server/lib/passwordPolicy.js — for live hints and the
// strength meter only. The server is the authority; keep the rules (and
// the rule codes) in step with it.
export const MIN_LENGTH = 10;

const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '0123456789', '12345678910',
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd123',
  'qwerty123', 'qwerty1234', 'qwertyuiop', 'qwerty12345', '1q2w3e4r5t', '1qaz2wsx3edc',
  'abc1234567', 'abcd123456', 'iloveyou12', 'welcome123', 'welcome1234',
  'admin12345', 'admin123456', 'administrator1', 'letmein123', 'changeme123',
  'gurmad123', 'gurmad1234', 'gurmad12345', 'gurmad2024', 'gurmad2025', 'gurmad2026',
  'somalia123', 'somaliland1', 'hargeisa123',
]);

// Returns the list of rules, each { code, ok }.
export function checkPassword(password, username) {
  const pw = password || '';
  const u = (username || '').trim().toLowerCase();
  return [
    { code: 'too_short', ok: pw.length >= MIN_LENGTH },
    { code: 'needs_letter', ok: /[A-Za-z]/.test(pw) },
    { code: 'needs_digit', ok: /[0-9]/.test(pw) },
    { code: 'too_common', ok: !!pw && !COMMON_PASSWORDS.has(pw.toLowerCase()) },
    { code: 'same_as_username', ok: !!pw && (!u || pw.toLowerCase() !== u) },
  ];
}

export function isPasswordAcceptable(password, username) {
  return checkPassword(password, username).every((r) => r.ok);
}

// 0..4 — purely a visual hint layered on top of the hard rules.
export function passwordScore(password, username) {
  const pw = password || '';
  if (!pw) return 0;
  if (!isPasswordAcceptable(pw, username)) return 1;
  let score = 2;
  if (pw.length >= 14) score += 1;
  if (/[^A-Za-z0-9]/.test(pw) && /[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  return Math.min(score, 4);
}
