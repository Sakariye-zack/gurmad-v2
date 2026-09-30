import React, { createContext, useContext, useState, useCallback } from 'react';
import { TRANSLATIONS, LANGUAGES } from './translations.js';

// Somali/English bilingual support (user-requested). Language choice is
// per-device (localStorage), not per-account — same pattern as
// ThemeToggle's own dark/light choice already uses in this codebase, so
// switching device/browser resets to the default rather than silently
// carrying a setting nobody can see anywhere.
const STORAGE_KEY = 'gurmad_v2_lang';
const I18nContext = createContext(null);

function readStoredLang() {
  const saved = localStorage.getItem(STORAGE_KEY);
  return LANGUAGES.includes(saved) ? saved : 'en';
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(readStoredLang);

  const setLang = useCallback((next) => {
    if (!LANGUAGES.includes(next)) return;
    localStorage.setItem(STORAGE_KEY, next);
    setLangState(next);
  }, []);

  const t = useCallback((key, fallback) => {
    const entry = TRANSLATIONS[key];
    if (!entry) return fallback ?? key;
    return entry[lang] || entry.en || fallback || key;
  }, [lang]);

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
