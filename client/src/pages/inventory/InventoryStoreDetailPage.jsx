import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Warehouse } from 'lucide-react';
import { PageHeader, Card, DetailGrid, StatusBadge, LoadingState, ErrorState } from '../../components/ui/index.js';
import { useInventoryStore } from '../../hooks/useInventory.js';

export default function InventoryStoreDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useInventoryStore(id);
  const store = data?.data;

  if (isLoading) return <LoadingState label="Loading store…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!store) return null;

  return (
    <div>
      <button onClick={() => navigate('/inventory/stores')} style={backLinkStyle}><ArrowLeft size={14} /> Back to Stores</button>
      <PageHeader icon={Warehouse} title={store.name} subtitle={store.zone_name || 'Company-wide'} />
      <div style={{ marginBottom: '16px' }}><StatusBadge status={store.status} map={{ active: 'success', inactive: 'info' }} /></div>
      <Card style={{ padding: '16px' }}>
        <Label>Current Stock</Label>
        {(store.stock || []).length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>No stock recorded at this store yet.</p>}
        {(store.stock || []).map((row) => (
          <div key={row.item_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <span>{row.name} ({row.unit_of_measure})</span>
            <span className="tabular-nums">{row.balance}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

function Label({ children }) {
  return <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{children}</span>;
}
const backLinkStyle = { display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px' };
