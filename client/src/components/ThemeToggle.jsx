import React, { useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { getEffectiveTheme, setTheme } from '../lib/theme.js';

// User-requested — a plain light/dark switch. Icon shows the theme a
// click would switch TO (the common convention: a sun while dark, a
// moon while light), not the one currently active.
export default function ThemeToggle() {
  const [theme, setThemeState] = useState(getEffectiveTheme);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  }

  return (
    <button
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '36px', height: '36px', borderRadius: 'var(--radius-sm)',
        border: 'none', background: 'none', color: 'var(--text-muted)', cursor: 'pointer',
      }}
    >
      {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
