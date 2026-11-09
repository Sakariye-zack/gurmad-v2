import React, { useCallback, useEffect, useState } from 'react';
import { UserPlus, MapPin, Phone } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader, Card, Button, Modal, useToast } from '../../components/ui/index.js';
import { apiClient } from '../../lib/apiClient.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useGroups, useRoutesForGroup } from '../../hooks/useGroups.js';
import { useGroupZones } from '../../hooks/useGroupZones.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Customer self-signup requests (portal /portal/signup). Admin sees every
// district; gudoomiye only their own (enforced server-side).
const BASE = '/v2/customer-portal/signup-requests';
const STATUSES = ['pending', 'approved', 'rejected'];

export default function SignupRequestsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [approving, setApproving] = useState(null);
  const [rejecting, setRejecting] = useState(null);

  const load = useCallback(() => {
    setRows(null); setError(null);
    apiClient.get(`${BASE}?status=${status}`).then((r) => setRows(r.data || [])).catch((e) => { setError(e.message); setRows([]); });
  }, [status]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader icon={UserPlus} title={t('sreq.title')} subtitle={t('sreq.subtitle')} />
      <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
        {STATUSES.map((s) => (
          <Button key={s} variant={s === status ? 'primary' : 'secondary'} onClick={() => setStatus(s)}>{t('sreq.' + s)}</Button>
        ))}
      </div>
      {error && <div style={{ color: 'var(--danger)', marginBottom: '10px' }}>{error}</div>}
      {rows === null ? <div>{t('sreq.loading')}</div> : rows.length === 0 ? <Card><div style={{ padding: '16px', color: 'var(--text-muted)' }}>{t('sreq.empty')}</div></Card> : (
        <div style={{ display: 'grid', gap: '12px' }}>
          {rows.map((r) => <RequestCard key={r.id} r={r} t={t} onApprove={() => setApproving(r)} onReject={() => setRejecting(r)} />)}
        </div>
      )}
      {approving && <ApproveModal r={approving} onClose={() => setApproving(null)} onDone={() => { setApproving(null); toast.success(t('sreq.approvedOk')); load(); }} />}
      {rejecting && <RejectModal r={rejecting} onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); toast.success(t('sreq.rejectedOk')); load(); }} />}
    </div>
  );
}

function RequestCard({ r, t, onApprove, onReject }) {
  const hasLoc = r.lat !== null && r.lng !== null;
  const line = (label, value) => value ? <div><span style={{ color: 'var(--text-muted)' }}>{label}: </span>{value}</div> : null;
  return (
    <Card>
      <div style={{ padding: '14px 16px', display: 'flex', gap: '16px', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ fontSize: '13px', display: 'grid', gap: '3px', minWidth: '240px', flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: '15px' }}>{r.full_name}{r.business_name ? ` — ${r.business_name}` : ''}</div>
          <div><Phone size={12} /> <a href={`tel:${r.phone}`}>{r.phone}</a>{r.alternate_phone ? ` · ${r.alternate_phone}` : ''}</div>
          {line(t('signup.type'), t(r.customer_type === 'commercial' ? 'signup.commercial' : 'signup.residential'))}
          {line(t('signup.district'), r.zone_name)}
          {line(t('signup.area'), r.area)}
          {line(t('signup.address'), r.address_line)}
          {line(t('signup.door'), r.door_number)}
          {line(t('sreq.prefBilling'), r.preferred_billing && t('signup.' + r.preferred_billing))}
          {line(t('signup.notes'), r.notes)}
          {line(t('sreq.submitted'), new Date(r.created_at).toLocaleString())}
          {r.reject_reason && line(t('sreq.reason'), r.reject_reason)}
          {hasLoc && (
            <a href={`https://www.google.com/maps?q=${r.lat},${r.lng}`} target="_blank" rel="noreferrer" style={{ color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <MapPin size={12} /> {t('signup.viewMap')} ({Number(r.lat).toFixed(5)}, {Number(r.lng).toFixed(5)})
            </a>
          )}
          {r.customer_id && <a href={`/customers/${r.customer_id}`} style={{ color: 'var(--brand)' }}>{t('sreq.customer')} #{r.customer_id}</a>}
        </div>
        {r.status === 'pending' && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <Button onClick={onApprove}>{t('sreq.approve')}</Button>
            <Button variant="danger" onClick={onReject}>{t('sreq.reject')}</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

const inputStyle = { width: '100%', padding: '9px 11px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px', boxSizing: 'border-box', background: 'var(--surface)', color: 'var(--text)' };
const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '5px' };
function Field({ label, children, hint }) {
  return <div><label style={labelStyle}>{label}</label>{children}{hint && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>{hint}</div>}</div>;
}

function ApproveModal({ r, onClose, onDone }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    zone_id: String(r.zone_id), group_id: '', gz_filter: '', route_id: '', door_number: r.door_number || '',
    billing_type: r.preferred_billing || '', fee_currency: 'USD', fee: '',
  });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const zones = useZonesList().data?.data || [];
  const groups = (useGroups({ status: 'active', limit: 200 }).data?.data || []).filter((g) => String(g.zone_id) === form.zone_id);
  const gzs = (useGroupZones(form.group_id || undefined).data?.data || []).filter((z) => z.status === 'active');
  const routes = (useRoutesForGroup(form.group_id || undefined).data?.data || [])
    .filter((x) => x.status === 'active' && (form.gz_filter === '' || String(x.group_zone_id) === form.gz_filter));
  const set = (k, v) => setForm((f) => {
    const n = { ...f, [k]: v };
    if (k === 'zone_id') { n.group_id = ''; n.gz_filter = ''; n.route_id = ''; }
    if (k === 'group_id') { n.gz_filter = ''; n.route_id = ''; }
    if (k === 'gz_filter') n.route_id = '';
    return n;
  });

  async function submit() {
    setErr(null);
    if (!/^\d+$/.test(form.door_number)) { setErr(t('sreq.door')); return; }
    setBusy(true);
    try {
      await apiClient.post(`${BASE}/${r.id}/approve`, {
        zone_id: Number(form.zone_id), group_id: form.group_id ? Number(form.group_id) : null, route_id: form.route_id ? Number(form.route_id) : null,
        door_number: form.door_number, billing_type: form.billing_type || undefined, fee_currency: form.fee_currency,
        fee: form.fee === '' ? null : Number(form.fee),
      });
      qc.invalidateQueries({ queryKey: ['v2', 'customers'] });
      onDone();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('sreq.approveTitle')} maxWidth="560px"
      footer={<><Button variant="secondary" onClick={onClose}>{t('sreq.cancel')}</Button><Button onClick={submit} disabled={busy}>{t('sreq.approve')}</Button></>}>
      <div style={{ display: 'grid', gap: '12px' }}>
        <div style={{ fontWeight: 700 }}>{r.full_name} · {r.phone}</div>
        {err && <div style={{ color: 'var(--danger)', fontSize: '13px' }}>{err}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
          <Field label={t('cust.district', 'District')}>
            <select value={form.zone_id} onChange={(e) => set('zone_id', e.target.value)} style={inputStyle}>
              {zones.map((z) => <option key={z.id} value={String(z.id)}>{z.name}</option>)}
            </select>
          </Field>
          <Field label={t('cust.group_optional', 'Group')}>
            <select value={form.group_id} onChange={(e) => set('group_id', e.target.value)} style={inputStyle}>
              <option value="">{t('cust.no_group', 'No group')}</option>
              {groups.map((g) => <option key={g.id} value={String(g.id)}>{g.name && g.name !== g.code ? `${g.code} ${g.name}` : g.code}</option>)}
            </select>
          </Field>
          <Field label={t('group.zone', 'Zone')}>
            <select value={form.gz_filter} onChange={(e) => set('gz_filter', e.target.value)} style={inputStyle} disabled={!form.group_id}>
              <option value="">{t('group.all_zones', 'All zones')}</option>
              {gzs.map((z) => <option key={z.id} value={String(z.id)}>{z.name ? `${z.code} — ${z.name}` : z.code}</option>)}
            </select>
          </Field>
          <Field label={t('cust.route_optional', 'Sub Zone')}>
            <select value={form.route_id} onChange={(e) => set('route_id', e.target.value)} style={inputStyle} disabled={!form.group_id}>
              <option value="">{t('cust.no_route', 'No sub zone')}</option>
              {routes.map((x) => <option key={x.id} value={String(x.id)}>{x.name && x.name !== x.code ? `${x.code} — ${x.name}` : x.code}</option>)}
            </select>
          </Field>
          <Field label={t('sreq.door')} hint={form.door_number ? t('sreq.doorHint', undefined, { door: form.door_number.replace(/^0+(?=\d)/, '').padStart(2, '0') }) : null}>
            <input value={form.door_number} onChange={(e) => set('door_number', e.target.value.replace(/\D/g, ''))} style={inputStyle} inputMode="numeric" maxLength={20} />
          </Field>
          <Field label={t('sreq.billingType')}>
            <select value={form.billing_type} onChange={(e) => set('billing_type', e.target.value)} style={inputStyle}>
              <option value="">{t('sreq.default')}</option>
              <option value="monthly">{t('signup.monthly')}</option>
              <option value="daily">{t('signup.daily')}</option>
            </select>
          </Field>
          <Field label={t('sreq.currency')}>
            <select value={form.fee_currency} onChange={(e) => set('fee_currency', e.target.value)} style={inputStyle}>
              <option value="USD">USD</option>
              <option value="SLSH">SLSH</option>
            </select>
          </Field>
          <Field label={t('sreq.fee')}>
            <input value={form.fee} onChange={(e) => set('fee', e.target.value)} style={inputStyle} type="number" min="0" step="any" />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function RejectModal({ r, onClose, onDone }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!reason.trim()) { setErr(t('sreq.reason')); return; }
    setBusy(true); setErr(null);
    try {
      await apiClient.post(`${BASE}/${r.id}/reject`, { reason: reason.trim() });
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={t('sreq.rejectTitle')}
      footer={<><Button variant="secondary" onClick={onClose}>{t('sreq.cancel')}</Button><Button variant="danger" onClick={submit} disabled={busy || !reason.trim()}>{t('sreq.reject')}</Button></>}>
      <div style={{ display: 'grid', gap: '10px' }}>
        <div style={{ fontWeight: 700 }}>{r.full_name} · {r.phone}</div>
        {err && <div style={{ color: 'var(--danger)', fontSize: '13px' }}>{err}</div>}
        <Field label={t('sreq.reason')}>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...inputStyle, minHeight: '80px' }} maxLength={500} autoFocus />
        </Field>
      </div>
    </Modal>
  );
}
