// Currency-aware money formatting. SLSH: no decimals ("30,000 SLSH"); USD: "$12.00".
export function fmtMoney(n, cur) {
  const v = Number(n || 0);
  return cur === 'SLSH' ? `${Math.round(v).toLocaleString('en-US')} SLSH` : `$${v.toFixed(2)}`;
}

// {USD: x, SLSH: y} -> "$12.00 + 30,000 SLSH" (only non-zero parts; "$0.00" when none).
export function fmtByCurrency(by) {
  const parts = [];
  if (Number(by?.USD) > 0.004) parts.push(fmtMoney(by.USD, 'USD'));
  if (Number(by?.SLSH) > 0.4) parts.push(fmtMoney(by.SLSH, 'SLSH'));
  return parts.length ? parts.join(' + ') : '$0.00';
}
