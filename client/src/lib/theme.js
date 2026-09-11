// User-requested ('mida kale iigu soo dar systemka meeshii aan
// colorska ka badalayey ee mode ka' — add a way to switch color/mode):
// tokens.css already fully defines both a light :root and an explicit
// dark override via [data-theme] (see its own header comment) — the
// CSS was ready, there was simply never a control anywhere that set
// the attribute. This is the one place that reads/writes it.
const KEY = 'gurmad_v2_theme'; // 'light' | 'dark' | absent (= follow system)

export function getStoredTheme() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // private browsing / storage blocked — falls back to system
  }
}

// Call once, as early as possible (before React mounts) — sets the
// attribute synchronously so there is no flash of the wrong theme on
// load for a user who has explicitly chosen one.
export function applyStoredTheme() {
  const t = getStoredTheme();
  if (t === 'light' || t === 'dark') {
    document.documentElement.setAttribute('data-theme', t);
  }
}

export function setTheme(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* per-viewer convenience only — a failed write just means the
       choice won't survive a reload, not a broken toggle this session */
  }
  document.documentElement.setAttribute('data-theme', theme);
}

// What's actually showing right now — the explicit choice if one was
// made, otherwise whatever the OS/browser currently prefers.
export function getEffectiveTheme() {
  const stored = getStoredTheme();
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
