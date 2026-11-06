// Account security — the ONE shared password-strength rule for staff
// accounts. Applied on every path that SETS a password (self-service
// change, reset confirm, admin create, admin reset). Existing stored
// passwords are never re-validated — a weak legacy password keeps working
// until its owner next changes it.

const MIN_LENGTH = 10;

// Small built-in deny-list (compared case-insensitively). Kept short on
// purpose: the length/letter/digit rules already reject most of the
// classic weak passwords; this catches the common ones that pass them.
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '0123456789', '12345678910',
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd123',
  'qwerty123', 'qwerty1234', 'qwertyuiop', 'qwerty12345', '1q2w3e4r5t', '1qaz2wsx3edc',
  'abc1234567', 'abcd123456', 'iloveyou12', 'welcome123', 'welcome1234',
  'admin12345', 'admin123456', 'administrator1', 'letmein123', 'changeme123',
  'gurmad123', 'gurmad1234', 'gurmad12345', 'gurmad2024', 'gurmad2025', 'gurmad2026',
  'somalia123', 'somaliland1', 'hargeisa123',
]);

// Returns { ok, errors: [rule codes], message }. Rule codes are stable so
// the client can map them to translated hints:
//   too_short | needs_letter | needs_digit | too_common | same_as_username
function validatePassword(password, username) {
  const errors = [];
  if (typeof password !== 'string' || password.length < MIN_LENGTH) errors.push('too_short');
  const pw = typeof password === 'string' ? password : '';
  if (!/[A-Za-z]/.test(pw)) errors.push('needs_letter');
  if (!/[0-9]/.test(pw)) errors.push('needs_digit');
  if (pw && COMMON_PASSWORDS.has(pw.toLowerCase())) errors.push('too_common');
  if (pw && typeof username === 'string' && username.trim() && pw.toLowerCase() === username.trim().toLowerCase()) errors.push('same_as_username');
  return { ok: errors.length === 0, errors, message: errors.length ? describe(errors) : null };
}

const MESSAGES = {
  too_short: `at least ${MIN_LENGTH} characters`,
  needs_letter: 'at least one letter',
  needs_digit: 'at least one digit',
  too_common: 'not a commonly used password',
  same_as_username: 'not the same as the username',
};
function describe(errors) {
  return 'Password must be ' + errors.map((e) => MESSAGES[e]).join(', ') + '.';
}

// Standard 400 body for a policy failure — code stays 'VALIDATION' (the
// shape every existing client error handler already understands), with
// the machine-readable rule list alongside.
function policyErrorBody(result) {
  return { error: { message: result.message, code: 'VALIDATION', reasons: result.errors } };
}

module.exports = { validatePassword, policyErrorBody, MIN_LENGTH, COMMON_PASSWORDS };
