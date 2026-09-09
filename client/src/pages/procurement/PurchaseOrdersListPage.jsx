import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart } from 'lucide-react';
import { PageHeader, DataTable, StatusBadge, FilterBar, StatCard } from '../../components/ui/index.js';
import { usePurchaseOrders } from '../../hooks/useProcurement.js';

const STATUS_MAP = { draft: 'info', ordered: 'warning', partially_received: 'warning', received: 'success', cancelled: 'danger' };

export default function PurchaseOrdersListPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = usePurchaseOrders({ q: search || undefined, status: statusFilter || undefined });
  const orders = data?.data || [];
  const totalValue = orders.reduce((sum, po) => sum + parseFloat(po.total_amount), 0);

  return (
    <div>
      <PageHeader icon={ShoppingCart} title="Purchase Orders" subtitle="Purchase orders created from approved procurement requests." />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Total Orders" value={error ? '—' : orders.length} icon={ShoppingCart} />
        <StatCard label="Total Value" value={error ? '—' : totalValue.toFixed(2)} icon={ShoppingCart} />
      </div>

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search PO number…">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="ordered">Ordered</option>
          <option value="partially_received">Partially Received</option>
          <option value="received">Received</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && orders.length === 0}
        emptyTitle="No purchase orders"
        columns={[{ label: 'PO Number' }, { label: 'Supplier' }, { label: 'Request' }, { label: 'Total' }, { label: 'Status' }]}
      >
        {orders.map((po) => (
          <tr key={po.id} onClick={() => navigate(`/procurement/purchase-orders/${po.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{po.po_number}</strong></td>
            <td style={cellStyle}>{po.supplier_name}</td>
            <td style={cellStyle}>{po.request_number}</td>
            <td style={cellStyle} className="tabular-nums">{parseFloat(po.total_amount).toFixed(2)}</td>
            <td style={cellStyle}><StatusBadge status={po.status} map={STATUS_MAP} /></td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = { padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '13px' };
