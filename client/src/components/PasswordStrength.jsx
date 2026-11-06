import React from 'react';
import { Check, X } from 'lucide-react';
import { checkPassword, passwordScore } from '../lib/passwordPolicy.js';
import { useI18n } from '../i18n/I18nContext.jsx';

// Account security — strength meter + live rule hints under any "new
// password" field. Purely advisory; the server enforces the same rules.
const LEVEL_COLORS = ['var(--border)', 'var(--danger)', 'var(--warning)', 'var(--success)', 'var(--success)'];
const LEVEL_KEYS = ['', 'pwPolicy.weak', 'pwPolicy.ok', 'pwPolicy.good', 'pwPolicy.strong'];

export default function PasswordStrength({ password, username }) {
  const { t } = useI18n();
  if (!password) {
    return <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>{t('pwPolicy.summary')}</p>;
  }
  const rules = checkPassword(password, username);
  const score = passwordScore(password, username);
  return (
    <div style={{ marginTop: '8px' }} aria-live="polite">
      <div style={{ display: 'flex', gap: '4px' }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} style={{ flex: 1, height: '5px', borderRadius: '3px', background: i <= score ? LEVEL_COLORS[score] : 'var(--border)' }} />
        ))}
      </div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: LEVEL_COLORS[score], marginTop: '4px' }}>{t(LEVEL_KEYS[score])}</div>
      <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0', display: 'grid', gap: '2px' }}>
        {rules.map((r) => (
          <li key={r.code} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: r.ok ? 'var(--success)' : 'var(--text-muted)' }}>
            {r.ok ? <Check size={13} /> : <X size={13} />}
            {t('pwPolicy.rule.' + r.code)}
          </li>
        ))}
      </ul>
    </div>
  );
}
