// Somaliland phone display helpers — one rule for every server-side output
// (CSV exports). Mirror of client/src/lib/phone.js (keep both in step).
//
// Stored phones are free text ("634259981", "0634259981", "+252 63 4259981").
// A Somaliland mobile is 9 national digits starting with 6/7/9; it is shown
// in the local style "063 4259981". Anything that does not look like that is
// returned trimmed and otherwise untouched (never invented).

function nationalDigits(raw) {
  if (raw === null || raw === undefined) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('00252')) d = d.slice(5);
  else if (d.startsWith('252') && d.length === 12) d = d.slice(3);
  if (d.length === 10 && d.startsWith('0')) d = d.slice(1);
  return /^[679]\d{8}$/.test(d) ? d : null;
}

function formatPhoneLocal(raw) {
  if (raw === null || raw === undefined) return '';
  const d = nationalDigits(raw);
  if (!d) return String(raw).trim();
  return `0${d.slice(0, 2)} ${d.slice(2)}`;
}

module.exports = { nationalDigits, formatPhoneLocal };
