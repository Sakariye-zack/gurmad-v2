import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Package } from 'lucide-react';
import { PageHeader, Card, DetailGrid, StatusBadge, LoadingState, ErrorState } from '../../components/ui/index.js';
import { useInventoryItem } from '../../hooks/useInventory.js';

export default function InventoryItemDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useInventoryItem(id);
  const item = data?.data;

  if (isLoading) return <LoadingState label="Loading item…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!item) return null;

  return (
    <div>
      <button onClick={() => navigate('/inventory/items')} style={backLinkStyle}><ArrowLeft size={14} /> Back to Items</button>
      <PageHeader icon={Package} title={item.name} subtitle={item.category || 'Inventory item'} />
      <div style={{ marginBottom: '16px' }}><StatusBadge status={item.status} map={{ active: 'success', inactive: 'info' }} /></div>
      <DetailGrid items={[
        { label: 'SKU', value: item.sku || '—' },
        { label: 'Unit of measure', value: item.unit_of_measure },
        { label: 'Reorder level', value: item.reorder_level ?? '—' },
        { label: 'Description', value: item.description || '—' },
        { label: 'Total stock (all stores)', value: item.stock?.total_balance ?? 0, className: 'tabular-nums' },
      ]} />
      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <Label>Stock by Store</Label>
        {(item.stock?.per_store || []).length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>No stock recorded for this item yet.</p>}
        {(item.stock?.per_store || []).map((row) => (
          <div key={row.store_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <span>{row.store_name}</span>
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
