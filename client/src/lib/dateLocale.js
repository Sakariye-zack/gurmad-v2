// Locale to use for month/weekday names: Somali when the user picked it, otherwise the browser default.
export function appLocale() {
  try { return localStorage.getItem('gurmad_v2_lang') === 'so' ? 'so' : undefined; } catch { return undefined; }
}
