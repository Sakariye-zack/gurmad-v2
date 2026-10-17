import React, { useEffect, useState } from 'react';
import { DataTable, StatusBadge, EmptyState } from '../../components/ui/index.js';
import { portalApiClient } from '../apiClient.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

// User-reported (Phase 10, screenshot from the Customer Portal): payment
// status always rendered as a flat, neutral blue 'recorded' pill —
// StatusBadge's own DEFAULT_MAP has no entry for 'recorded'/'reversed'
// (it falls back to the generic 'info' style), so a customer's own
// successful payment read as unremarkable/uncertain rather than a clear
// positive confirmation. Every staff-facing page that renders this same
// payment status (BillingView.jsx, InvoiceDetailPage.jsx,
// ReportsPage.jsx) already passes this exact
// { recorded: 'success', reversed: 'danger' } map locally — the Portal
// page was the one place this was missed. 'recorded' is the correct,
// final state for a successful payment (Module 6 is closed/frozen); it
// only ever becomes 'reversed' if an admin reverses it — there is no
// missing third state, only a missing color.
const PAYMENT_STATUS_MAP = { recorded: 'success', reversed: 'danger' };

export default function PortalPayments() {
  const { t } = useI18n();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    portalApiClient.get('/payments')
      .then((res) => setRows(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <div>
      <h2 style={{ margin: '0 0 16px' }}>{t('portal.payments.title')}</h2>
      <DataTable
        loading={loading}
        error={error}
        onRetry={load}
        columns={[{ label: t('portal.col.invoice') }, { label: t('common.amount'), align: 'right' }, { label: t('common.method') }, { label: t('common.status') }, { label: t('common.date') }]}
        isEmpty={rows && rows.length === 0}
      >
        {rows && rows.length === 0 ? (
          <tr><td colSpan={5}><EmptyState title={t('portal.payments.empty')} /></td></tr>
        ) : rows?.map((r) => (
          <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
            <td style={tdStyle}>{r.invoice_number}</td>
            <td className="tabular-nums" style={{ ...tdStyle, textAlign: 'right' }}>{r.currency} {parseFloat(r.amount).toFixed(2)}</td>
            <td style={{ ...tdStyle, textTransform: 'uppercase' }}>{r.method}</td>
            <td style={tdStyle}><StatusBadge status={r.status} map={PAYMENT_STATUS_MAP} /></td>
            <td style={tdStyle}>{new Date(r.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const tdStyle = { padding: '10px 14px' };
