import React, { useState } from 'react';
import { History, Download } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, StatCard, Pagination, useToast } from '../../components/ui/index.js';
import { useAuditLog, exportAuditLogUrl } from '../../hooks/useAudit.js';
import { apiClient } from '../../lib/apiClient.js';
import AuditDetailModal from './AuditDetailModal.jsx';

const SEVERITY_MAP = { info: 'info', warning: 'warning', critical: 'danger' };
const CATEGORIES = [
  'Authentication', 'Account Administration', 'RBAC Administration', 'Customer', 'Employee', 'Truck',
  'Zone/Group/Route', 'Collection Operations', 'Financial', 'Cashout Documents', 'Complaints', 'Reporting', 'Uncategorized',
];
const PAGE_SIZE = 50;

// Audit & Security Center — Implementation Spec §13. Admin-only (the
// Sidebar/router already gate this page to admin; the backend independently
// re-enforces it — frontend gating is never authoritative on its own).
export default function AuditCenterListPage() {
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('');
  const [category, setCategory] = useState('');
  const [success, setSuccess] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1); // 1-indexed, matching Pagination.jsx's own contract
  const [detailId, setDetailId] = useState(null);
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  const params = {
    q: search || undefined,
    severity: severity || undefined,
    category: category || undefined,
    success: success || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };
  const { data, isLoading, error, refetch } = useAuditLog(params);
  const rows = data?.data || [];
  const total = data?.meta?.total ?? 0;

  // Summary cards derive ONLY from the already-fetched page's own data —
  // no separate aggregate endpoint, no fabricated number (Spec §13).
  const warningCount = rows.filter((r) => r.severity === 'WARNING').length;
  const criticalCount = rows.filter((r) => r.severity === 'CRITICAL').length;

  async function handleExport() {
    setExporting(true);
    try {
      await apiClient.downloadAuthorizedFile(exportAuditLogUrl(params), `audit-log-${new Date().toISOString().slice(0, 10)}.csv`);
      toast.success('Audit log exported.');
    } catch (err) {
      toast.error(err.message || 'Failed to export audit log.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <PageHeader
        icon={History}
        title="Audit & Security Center"
        subtitle="Company-wide staff activity log — Admin only."
        actions={<Button variant="secondary" icon={Download} onClick={handleExport} disabled={exporting}>{exporting ? 'Exporting…' : 'Export CSV'}</Button>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Events (this page)" value={error ? '—' : rows.length} icon={History} />
        <StatCard label="Warning" value={error ? '—' : warningCount} accent="var(--warning)" />
        <StatCard label="Critical" value={error ? '—' : criticalCount} accent="var(--danger)" />
      </div>

      <FilterBar searchValue={search} onSearchChange={(v) => { setSearch(v); setPage(1); }} searchPlaceholder="Search by actor, action, or entity type…">
        <select value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }} style={selectStyle}>
          <option value="">All severities</option>
          <option value="INFO">Info</option>
          <option value="WARNING">Warning</option>
          <option value="CRITICAL">Critical</option>
        </select>
        <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} style={selectStyle}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={success} onChange={(e) => { setSuccess(e.target.value); setPage(1); }} style={selectStyle}>
          <option value="">All outcomes</option>
          <option value="true">Success</option>
          <option value="false">Failed</option>
        </select>
        <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} style={selectStyle} title="From date" />
        <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); }} style={selectStyle} title="To date" />
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && rows.length === 0}
        emptyTitle="No audit events match your filters."
        emptySubtitle="Try widening the date range or clearing a filter."
        columns={[{ label: 'Timestamp' }, { label: 'Actor' }, { label: 'Action' }, { label: 'Category' }, { label: 'Entity' }, { label: 'Severity' }, { label: 'Outcome' }]}
      >
        {rows.map((r) => (
          <tr key={r.id} onClick={() => setDetailId(r.id)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle} className="tabular-nums">{new Date(r.created_at).toLocaleString()}</td>
            <td style={cellStyle}>{r.actor_username || '—'}</td>
            <td style={cellStyle}><code style={{ fontSize: '12px' }}>{r.action}</code></td>
            <td style={cellStyle}>{r.category}</td>
            <td style={cellStyle}>{r.entity_type ? `${r.entity_type}${r.entity_id != null ? ` #${r.entity_id}` : ''}` : '—'}</td>
            <td style={cellStyle}><StatusBadge status={r.severity?.toLowerCase()} map={SEVERITY_MAP} /></td>
            <td style={cellStyle}><StatusBadge status={r.success ? 'success' : 'failed'} map={{ success: 'success', failed: 'danger' }} /></td>
          </tr>
        ))}
      </DataTable>

      <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />

      {detailId && <AuditDetailModal id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
