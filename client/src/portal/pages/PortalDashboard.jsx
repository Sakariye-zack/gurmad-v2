import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wallet, AlertTriangle, Truck, Receipt, Bell } from 'lucide-react';
import { StatCard, LoadingState, ErrorState } from '../../components/ui/index.js';
import PortalPageHeader from '../components/PortalPageHeader.jsx';
import PortalCard from '../components/PortalCard.jsx';
import PortalEmptyBanner from '../components/PortalEmptyBanner.jsx';
import { portalApiClient } from '../apiClient.js';

// Rebuild — Implementation Spec §20: a real hierarchy — one prominent
// "what needs attention" card above the existing StatCard row (unchanged
// data source, GET /summary), followed by a Recent Activity list merged
// client-side from 3 already-fetched lists (no new backend aggregation
// route — avoids duplicating what /summary + the 3 list routes already
// provide).
export default function PortalDashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [activity, setActivity] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    Promise.all([
      portalApiClient.get('/summary'),
      portalApiClient.get('/invoices'),
      portalApiClient.get('/payments'),
      portalApiClient.get('/collection-history'),
    ])
      .then(([summaryRes, invoicesRes, paymentsRes, collectionsRes]) => {
        setData(summaryRes.data);
        const merged = [
          ...invoicesRes.data.slice(0, 3).map((i) => ({ kind: 'invoice', id: i.id, label: `Invoice ${i.invoice_number}`, at: i.created_at })),
          ...paymentsRes.data.slice(0, 3).map((p) => ({ kind: 'payment', id: p.invoice_id, label: `Payment of ${p.currency} ${parseFloat(p.amount).toFixed(2)}`, at: p.created_at })),
          ...collectionsRes.data.slice(0, 3).map((c) => ({ kind: 'collection', id: c.id, label: `Collection ${c.status}`, at: c.status_at })),
        ].filter((a) => a.at).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 5);
        setActivity(merged);
      })
      .catch((err) => setError(err))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  if (loading) return <LoadingState label="Loading your dashboard…" />;
  if (error) return <ErrorState message={error.message} onRetry={load} />;

  const hasBalance = data.outstandingInvoiceBalance > 0 || data.outstandingDebt > 0;

  return (
    <div>
      <PortalPageHeader title="My Dashboard" subtitle="An overview of your account" />

      {hasBalance ? (
        <PortalCard style={{ borderLeft: '3px solid #DC2626', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <AlertTriangle size={22} color="#DC2626" />
          <div>
            <div style={{ fontWeight: 800, fontSize: '14px' }}>You have an outstanding balance</div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '2px' }}>
              ${(data.outstandingInvoiceBalance + data.outstandingDebt).toFixed(2)} due — view your invoices for details.
            </div>
          </div>
        </PortalCard>
      ) : (
        <div style={{ marginBottom: '16px' }}>
          <PortalEmptyBanner title="You're all caught up" subtitle="No outstanding balance on your account." />
        </div>
      )}

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

      <PortalCard style={{ marginTop: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <Bell size={15} color="var(--text-muted)" />
          <h3 style={{ margin: 0, fontSize: '14px' }}>Recent Activity</h3>
        </div>
        {!activity || activity.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>No recent activity yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {activity.map((a, i) => (
              <div
                key={i}
                onClick={() => a.kind === 'invoice' || a.kind === 'payment' ? navigate(`/portal/invoices/${a.id}`) : navigate(`/portal/collections/${a.id}`)}
                style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: i > 0 ? '1px solid var(--border)' : 'none', cursor: 'pointer', fontSize: '13px' }}
              >
                <span>{a.label}</span>
                <span style={{ color: 'var(--text-muted)' }}>{new Date(a.at).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}
      </PortalCard>
    </div>
  );
}
