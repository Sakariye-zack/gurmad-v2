import React, { useEffect, useState } from 'react';
import { Wallet, AlertTriangle, Truck, Receipt } from 'lucide-react';
import { StatCard, LoadingState, ErrorState, Card } from '../../components/ui/index.js';
import { portalApiClient } from '../apiClient.js';

export default function PortalDashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    portalApiClient.get('/summary')
      .then((res) => setData(res.data))
      .catch((err) => setError(err))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  if (loading) return <LoadingState label="Loading your dashboard…" />;
  if (error) return <ErrorState message={error.message} onRetry={load} />;

  return (
    <div>
      <h2 style={{ margin: '0 0 16px' }}>My Dashboard</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
        <StatCard label="Outstanding Invoice Balance" value={`$${data.outstandingInvoiceBalance.toFixed(2)}`} icon={Wallet} accent="#2563EB" />
        <StatCard label="Outstanding Debt" value={`$${data.outstandingDebt.toFixed(2)}`} icon={AlertTriangle} accent="#DC2626" />
        <StatCard
          label="Last Payment"
          value={data.lastPayment ? `$${parseFloat(data.lastPayment.amount).toFixed(2)}` : '—'}
          sub={data.lastPayment ? new Date(data.lastPayment.created_at).toLocaleDateString() : 'No payments yet'}
          icon={Receipt}
        />
        <StatCard
          label="Last Collection"
          value={data.lastCollection ? data.lastCollection.status : '—'}
          sub={data.lastCollection ? new Date(data.lastCollection.status_at).toLocaleDateString() : 'No collection history yet'}
          icon={Truck}
        />
      </div>
      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>
          Use the tabs above to view your full collection history, invoices, and payment history.
        </p>
      </Card>
    </div>
  );
}
