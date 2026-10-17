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

  // t(key, fallback?, vars?) — vars fills {placeholders} in the string, e.g.
  // t('x.count', undefined, { n: 3 }) with 'Waxaa jira {n}' -> 'Waxaa jira 3'.
  const t = useCallback((key, fallback, vars) => {
    const entry = TRANSLATIONS[key];
    const str = entry ? (entry[lang] || entry.en || fallback || key) : (fallback ?? key);
    return vars ? str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : str;
  }, [lang]);

  // tc: same as t() but with the first letter upper-cased (for chips/buttons built from status words).
  const tc = useCallback((key, fallback, vars) => {
    const s = t(key, fallback, vars);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }, [t]);

  return (
    <I18nContext.Provider value={{ lang, setLang, t, tc }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
