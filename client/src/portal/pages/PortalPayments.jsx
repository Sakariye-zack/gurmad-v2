import React, { useEffect, useState } from 'react';
import { DataTable, StatusBadge, EmptyState } from '../../components/ui/index.js';
import { portalApiClient } from '../apiClient.js';

export default function PortalPayments() {
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
      <h2 style={{ margin: '0 0 16px' }}>My Payments</h2>
      <DataTable
        loading={loading}
        error={error}
        onRetry={load}
        columns={[{ label: 'Invoice #' }, { label: 'Amount', align: 'right' }, { label: 'Method' }, { label: 'Status' }, { label: 'Date' }]}
        isEmpty={rows && rows.length === 0}
      >
        {rows && rows.length === 0 ? (
          <tr><td colSpan={5}><EmptyState title="No payments yet" /></td></tr>
        ) : rows?.map((r) => (
          <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
            <td style={tdStyle}>{r.invoice_number}</td>
            <td className="tabular-nums" style={{ ...tdStyle, textAlign: 'right' }}>{r.currency} {parseFloat(r.amount).toFixed(2)}</td>
            <td style={{ ...tdStyle, textTransform: 'uppercase' }}>{r.method}</td>
            <td style={tdStyle}><StatusBadge status={r.status} /></td>
            <td style={tdStyle}>{new Date(r.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const tdStyle = { padding: '10px 14px' };
