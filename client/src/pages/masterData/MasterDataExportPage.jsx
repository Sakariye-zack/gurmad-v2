import React, { useState } from 'react';
import { Download } from 'lucide-react';
import { PageHeader, Button, Card, useToast } from '../../components/ui/index.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { EXPORT_ENTITIES, exportMasterData } from '../../hooks/useMasterDataImportExport.js';
import { useZonesList } from '../../hooks/useCustomers.js';

// Master Functional Completion Program — Phase 6. Export permission is
// enforced server-side per entity (never inherited from view access,
// Decisions §16) — this page simply reflects whatever the server allows;
// a role with zero export rights (Head of Cashiers, Cashier, Collector)
// will see the entity list but every export attempt returns 403, exactly
// as documented, not hidden client-side as if it were a secret.

export default function MasterDataExportPage() {
  const { user } = useAuth();
  const role = (user?.role || '').toLowerCase();
  const [entity, setEntity] = useState(EXPORT_ENTITIES[0].value);
  const [status, setStatus] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [exporting, setExporting] = useState(false);
  const { data: zonesData } = useZonesList();
  const zones = zonesData?.data || [];
  const toast = useToast();

  const entityDef = EXPORT_ENTITIES.find((e) => e.value === entity);
  const isCompanyWideRole = ['admin', 'head_of_cashiers', 'cashier'].includes(role);

  async function handleExport() {
    setExporting(true);
    try {
      const filters = {};
      if (status) filters.status = status;
      if (entityDef?.zoneScoped && isCompanyWideRole && zoneId) filters.zone_id = zoneId;
      await exportMasterData(entity, filters);
      toast.success('Export downloaded.');
    } catch (err) {
      toast.error(err.message || 'You do not have permission to export this entity, or the export failed.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <PageHeader icon={Download} title="Export Master Data" subtitle="Download a CSV of a master-data entity, scoped to your own role and zone." />
      <Card style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '480px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Entity</span>
          <select value={entity} onChange={(e) => setEntity(e.target.value)} style={inputStyle}>
            {EXPORT_ENTITIES.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Status (optional)</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        {entityDef?.zoneScoped && isCompanyWideRole && (
          <label style={fieldStyle}>
            <span style={labelStyle}>Zone (optional — leave blank for all zones)</span>
            <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} style={inputStyle}>
              <option value="">All zones</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </label>
        )}
        {entityDef?.zoneScoped && !isCompanyWideRole && (
          <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)' }}>This export is automatically scoped to your own zone.</p>
        )}
        <Button icon={Download} onClick={handleExport} disabled={exporting}>{exporting ? 'Exporting…' : 'Export CSV'}</Button>
      </Card>
    </div>
  );
}

const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = { padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit' };
