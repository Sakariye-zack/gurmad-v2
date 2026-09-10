import React, { useState } from 'react';
import { Upload, CheckCircle2, AlertTriangle } from 'lucide-react';
import { PageHeader, Button, Card, useToast } from '../../components/ui/index.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useValidateImport, useCommitImport, IMPORT_ENTITIES } from '../../hooks/useMasterDataImportExport.js';
import { useZonesList } from '../../hooks/useCustomers.js';

// Master Functional Completion Program — Phase 6: Import/Export + Master
// Data Governance. Direct-URL-only page, no Sidebar/nav entry — identical
// precedent to Phases 4/5.
const ADMIN_ROLES_BY_ENTITY = { zones: ['admin'], customers: ['admin', 'gudoomiye'], trucks: ['admin', 'gudoomiye'], 'leave-types': ['admin'], 'inventory-items': ['admin'] };

export default function MasterDataImportPage() {
  const { user } = useAuth();
  const role = (user?.role || '').toLowerCase();
  const permittedEntities = IMPORT_ENTITIES.filter((e) => (ADMIN_ROLES_BY_ENTITY[e.value] || []).includes(role));

  const [entity, setEntity] = useState(permittedEntities[0]?.value || '');
  const [zoneId, setZoneId] = useState('');
  const [companyWide, setCompanyWide] = useState(false);
  const [file, setFile] = useState(null);
  const [validation, setValidation] = useState(null);
  const [commitResult, setCommitResult] = useState(null);
  const [error, setError] = useState('');

  const { data: zonesData } = useZonesList();
  const zones = zonesData?.data || [];
  const validateMutation = useValidateImport();
  const commitMutation = useCommitImport();
  const toast = useToast();

  const entityDef = IMPORT_ENTITIES.find((e) => e.value === entity);
  const isGudoomiye = role === 'gudoomiye';

  function buildFormData(includeToken) {
    const fd = new FormData();
    fd.append('file', file);
    if (entityDef?.zoneScoped && !isGudoomiye) {
      if (companyWide) fd.append('company_wide', 'true');
      else if (zoneId) fd.append('zone_id', zoneId);
    }
    if (includeToken && validation?.validationToken) fd.append('validationToken', validation.validationToken);
    return fd;
  }

  async function handleValidate(e) {
    e.preventDefault();
    setError(''); setValidation(null); setCommitResult(null);
    if (!file) { setError('A CSV file is required.'); return; }
    try {
      const result = await validateMutation.mutateAsync({ entity, formData: buildFormData(false) });
      setValidation(result.data);
      if (!result.data.valid) toast.error(`${result.data.errors.length} validation error(s) found.`);
      else toast.success(`${result.data.rowCount} row(s) validated successfully.`);
    } catch (err) { setError(err.message || 'Validation failed.'); }
  }

  async function handleCommit() {
    setError('');
    try {
      const result = await commitMutation.mutateAsync({ entity, formData: buildFormData(true) });
      setCommitResult(result.data);
      setValidation(null);
      setFile(null);
      toast.success(`${result.data.created} row(s) imported successfully.`);
    } catch (err) { setError(err.message || 'Import failed.'); }
  }

  if (permittedEntities.length === 0) {
    return (
      <div>
        <PageHeader icon={Upload} title="Import Master Data" subtitle="Bulk-create master-data records from a CSV file." />
        <Card style={{ padding: '16px' }}><p style={{ margin: 0 }}>You do not have permission to import any master-data entity.</p></Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader icon={Upload} title="Import Master Data" subtitle="Bulk-create master-data records from a CSV file. Validate first, then commit." />
      <Card style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '520px' }}>
        <form onSubmit={handleValidate} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <label style={fieldStyle}>
            <span style={labelStyle}>Entity</span>
            <select value={entity} onChange={(e) => { setEntity(e.target.value); setValidation(null); setCommitResult(null); }} style={inputStyle}>
              {permittedEntities.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
            </select>
          </label>
          {entityDef?.zoneScoped && !isGudoomiye && (
            <>
              <label style={fieldStyle}>
                <span style={labelStyle}>Target zone (or company-wide)</span>
                <select value={companyWide ? '__company_wide__' : zoneId} onChange={(e) => { if (e.target.value === '__company_wide__') { setCompanyWide(true); setZoneId(''); } else { setCompanyWide(false); setZoneId(e.target.value); } }} style={inputStyle}>
                  <option value="">Select a zone…</option>
                  <option value="__company_wide__">Company-wide</option>
                  {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                </select>
              </label>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)' }}>Every row in this file will be imported into the selected zone. A file cannot mix rows for different zones.</p>
            </>
          )}
          {entityDef?.zoneScoped && isGudoomiye && (
            <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)' }}>Rows will be imported into your own assigned zone.</p>
          )}
          <label style={fieldStyle}>
            <span style={labelStyle}>CSV file (max 5MB, 5,000 rows)</span>
            <input type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] || null); setValidation(null); setCommitResult(null); }} style={inputStyle} />
          </label>
          {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
          <Button type="submit" disabled={validateMutation.isPending}>{validateMutation.isPending ? 'Validating…' : 'Validate'}</Button>
        </form>

        {validation && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '14px' }}>
            {validation.valid ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--success)' }}>
                  <CheckCircle2 size={16} /><strong>{validation.rowCount} row(s) valid and ready to import.</strong>
                </div>
                <Button onClick={handleCommit} disabled={commitMutation.isPending}>{commitMutation.isPending ? 'Committing…' : `Commit ${validation.rowCount} row(s)`}</Button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)' }}>
                  <AlertTriangle size={16} /><strong>{validation.errors.length} error(s) found — nothing will be imported until they are fixed.</strong>
                </div>
                <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                    <thead><tr style={{ background: 'var(--bg)' }}><th style={cellStyle}>Row</th><th style={cellStyle}>Field</th><th style={cellStyle}>Code</th><th style={cellStyle}>Message</th></tr></thead>
                    <tbody>{validation.errors.map((err, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={cellStyle}>{err.row ?? '—'}</td><td style={cellStyle}>{err.field || '—'}</td><td style={cellStyle}>{err.code}</td><td style={cellStyle}>{err.message}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {commitResult && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '14px', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--success)' }}>
            <CheckCircle2 size={16} /><strong>Import complete — {commitResult.created} row(s) created.</strong>
          </div>
        )}
      </Card>
    </div>
  );
}

const cellStyle = { padding: '8px 10px', textAlign: 'left' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = { padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit' };
