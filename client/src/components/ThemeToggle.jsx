import React, { useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { getEffectiveTheme, setTheme } from '../lib/theme.js';
import { useI18n } from '../i18n/I18nContext.jsx';

// User-requested — a plain light/dark switch. Icon shows the theme a
// click would switch TO (the common convention: a sun while dark, a
// moon while light), not the one currently active.
export default function ThemeToggle() {
  const { t } = useI18n();
  const [theme, setThemeState] = useState(getEffectiveTheme);

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  }

  return (
    <button
      onClick={toggle}
      aria-label={theme === 'dark' ? t('comp.switch_to_light_mode') : t('comp.switch_to_dark_mode')}
      title={theme === 'dark' ? t('comp.light_mode') : t('comp.dark_mode')}
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
