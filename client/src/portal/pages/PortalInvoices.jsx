import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DataTable, StatusBadge, EmptyState } from '../../components/ui/index.js';
import { portalApiClient } from '../apiClient.js';

export default function PortalInvoices() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    portalApiClient.get('/invoices')
      .then((res) => setRows(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <div>
      <h2 style={{ margin: '0 0 16px' }}>My Invoices</h2>
      <DataTable
        loading={loading}
        error={error}
        onRetry={load}
        columns={[{ label: 'Invoice #' }, { label: 'Total', align: 'right' }, { label: 'Status' }, { label: 'Date' }]}
        isEmpty={rows && rows.length === 0}
      >
        {rows && rows.length === 0 ? (
          <tr><td colSpan={4}><EmptyState title="No invoices yet" /></td></tr>
        ) : rows?.map((r) => (
          <tr key={r.id} onClick={() => navigate(`/portal/invoices/${r.id}`)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={tdStyle}>{r.invoice_number}</td>
            <td className="tabular-nums" style={{ ...tdStyle, textAlign: 'right' }}>{r.currency} {parseFloat(r.invoice_total - r.discount_amount).toFixed(2)}</td>
            <td style={tdStyle}><StatusBadge status={r.status} /></td>
            <td style={tdStyle}>{new Date(r.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const tdStyle = { padding: '10px 14px' };
