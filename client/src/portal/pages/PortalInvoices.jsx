import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DataTable, StatusBadge, EmptyState, Button } from '../../components/ui/index.js';
import { Smartphone } from 'lucide-react';
import PortalZaadPayModal from '../components/PortalZaadPayModal.jsx';
import { portalApiClient } from '../apiClient.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

export default function PortalInvoices() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(null);

  function load({ quiet = false } = {}) {
    if (!quiet) setLoading(true);
    setError(null);
    portalApiClient.get('/invoices')
      .then((res) => setRows(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  return (
    <div>
      <h2 style={{ margin: '0 0 16px' }}>{t('portal.invoices.title')}</h2>
      <DataTable
        loading={loading}
        error={error}
        onRetry={() => load()}
        columns={[{ label: t('portal.col.invoice') }, { label: t('portal.col.total'), align: 'right' }, { label: t('portal.col.outstanding'), align: 'right' }, { label: t('common.status') }, { label: t('common.date') }, { label: '' }]}
        isEmpty={rows && rows.length === 0}
      >
        {rows && rows.length === 0 ? (
          <tr><td colSpan={6}><EmptyState title={t('portal.invoices.empty')} /></td></tr>
        ) : rows?.map((r) => (
          <tr key={r.id} onClick={() => navigate(`/portal/invoices/${r.id}`)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={tdStyle}>{r.invoice_number}</td>
            <td className="tabular-nums" style={{ ...tdStyle, textAlign: 'right' }}>{r.currency} {parseFloat(r.invoice_total - r.discount_amount).toFixed(2)}</td>
            <td className="tabular-nums" style={{ ...tdStyle, textAlign: 'right' }}>{r.currency} {parseFloat(r.outstanding || 0).toFixed(2)}</td>
            <td style={tdStyle}><StatusBadge status={r.status} /></td>
            <td style={tdStyle}>{new Date(r.created_at).toLocaleDateString()}</td>
            <td style={{ ...tdStyle, textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
              {r.status !== 'voided' && Number(r.outstanding) > 0.004 && (
                <Button icon={Smartphone} style={{ padding: "6px 10px", fontSize: "12px" }} onClick={() => setPaying(r)}>{t('portal.zaad.pay')}</Button>
              )}
            </td>
          </tr>
        ))}
      </DataTable>
      {paying && (
        <PortalZaadPayModal
          invoice={paying}
          outstanding={paying.outstanding}
          onClose={() => setPaying(null)}
          onPaid={() => load({ quiet: true })}
        />
      )}
    </div>
  );
}

const tdStyle = { padding: '10px 14px' };
