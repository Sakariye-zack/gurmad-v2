import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  // Production Readiness (T) — Implementation Spec §6/O-8. `dist/` (build
  // output) and `public/` (static assets, including the service worker,
  // which is not authored as an ES module and predates this lint config)
  // were being linted by the global `js.configs.recommended` rules below
  // with no file scope of their own — found live the first time `npm run
  // lint` was ever actually run in this repo (no lint script existed
  // before this pass). Neither is source code this project authors or
  // should lint; excluding them is standard ESLint hygiene, not a
  // reduction in real coverage.
  { ignores: ['dist/**', 'public/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2021 },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
