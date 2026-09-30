import React from 'react';
import { useI18n } from '../i18n/I18nContext.jsx';

// Somali/English bilingual support (user-requested) — a plain EN/SO
// switch, same visual slot/pattern as ThemeToggle.jsx right next to it.
export default function LanguageToggle() {
  const { lang, setLang } = useI18n();

  function toggle() {
    setLang(lang === 'en' ? 'so' : 'en');
  }

  return (
    <button
      onClick={toggle}
      aria-label={lang === 'en' ? 'Badal Soomaali' : 'Switch to English'}
      title={lang === 'en' ? 'Soomaali' : 'English'}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minWidth: '36px', height: '36px', padding: '0 8px', borderRadius: 'var(--radius-sm)',
        border: 'none', background: 'none', color: 'var(--text-muted)', cursor: 'pointer',
        fontSize: '12px', fontWeight: 800, letterSpacing: '0.03em',
      }}
    >
      {lang === 'en' ? 'SO' : 'EN'}
    </button>
  );
}
