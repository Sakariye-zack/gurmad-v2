import React, { useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import { Card, Button, Modal, useToast } from '../../components/ui/index.js';
import { useCompanySettings, useUpdateCompanySettings } from '../../hooks/useSettings.js';
import { useDepositAccounts, useSaveDepositAccount, useCashoutMeta } from '../../hooks/useCashouts.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import '../financial/cashout.css';

const TYPES = ['safe', 'bank', 'mobile'];
const money2 = /^\d+(\.\d{1,2})?$/;

// Settings → Cashout controls (admin only): the tolerance a difference may
// have and still count as balanced, the shortage above which only an admin
// may approve, and the deposit accounts approved cash can go to.
export default function CashoutSettingsCard() {
  const { t } = useI18n();
  const { data } = useCompanySettings();
  const s = data?.data;
  const tol = s?.cashout_tolerance_usd ?? 1;
  const thr = s?.cashout_admin_threshold_usd ?? 10;
  return (
    <Card style={{ padding: '20px', marginTop: '16px' }}>
      <span className="co-section-label">{t('co2.set.title')}</span>
      <ControlsForm key={`${tol}-${thr}`} tol={tol} thr={thr} />
      <CutoffForm />
      <DepositAccounts />
    </Card>
  );
}

function ControlsForm({ tol, thr }) {
  const { t } = useI18n();
  const toast = useToast();
  const update = useUpdateCompanySettings();
  const [tolerance, setTolerance] = useState(String(tol));
  const [threshold, setThreshold] = useState(String(thr));
  const [error, setError] = useState('');
  async function save(e) {
    e.preventDefault();
    if (!money2.test(tolerance) || !money2.test(threshold)) { setError(t('co2.set.invalid')); return; }
    if (Number(tolerance) > Number(threshold)) { setError(t('co2.set.order')); return; }
    setError('');
    try {
      await update.mutateAsync({ cashout_tolerance_usd: Number(tolerance), cashout_admin_threshold_usd: Number(threshold) });
      toast.success(t('co2.set.saved'));
    } catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }
  return (
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '6px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="co-field" style={{ flex: '0 1 220px' }}>
          <span>{t('co2.set.tolerance')}</span>
          <input className="co-input" inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value.trim())} />
        </label>
        <label className="co-field" style={{ flex: '0 1 220px' }}>
          <span>{t('co2.set.threshold')}</span>
          <input className="co-input" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value.trim())} />
        </label>
        <Button type="submit" disabled={update.isPending}>{t('common.save', 'Save')}</Button>
      </div>
      <span className={error ? 'co-err' : 'co-note'}>{error || t('co2.set.hint')}</span>
    </form>
  );
}

const pad = (n) => String(n).padStart(2, '0');
function toLocalInput(d) {
  const x = new Date(d);
  if (isNaN(x.getTime())) return '';
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

// Cut-off: payments recorded before it are never listed as "not yet cashed
// out" nor alerted on (history from before Cashout V2 went live).
function CutoffForm() {
  const { data } = useCashoutMeta();
  const since = data?.data?.cashout_v2_since;
  if (!since) return null;
  return <CutoffInner key={since} since={since} />;
}
function CutoffInner({ since }) {
  const { t } = useI18n();
  const toast = useToast();
  const update = useUpdateCompanySettings();
  const [value, setValue] = useState(toLocalInput(since));
  const [error, setError] = useState('');
  async function save(e) {
    e.preventDefault();
    const d = new Date(value);
    if (!value || isNaN(d.getTime())) { setError(t('co2.set.cutoffInvalid')); return; }
    if (d.getTime() > Date.now()) { setError(t('co2.set.cutoffFuture')); return; }
    setError('');
    try {
      await update.mutateAsync({ cashout_v2_since: d.toISOString() });
      toast.success(t('co2.set.saved'));
    } catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }
  return (
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '14px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="co-field" style={{ flex: '0 1 260px' }}>
          <span>{t('co2.set.cutoff')}</span>
          <input type="datetime-local" className="co-input" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <Button type="submit" variant="secondary" disabled={update.isPending}>{t('common.save', 'Save')}</Button>
      </div>
      <span className={error ? 'co-err' : 'co-note'}>{error || t('co2.set.cutoffHint')}</span>
    </form>
  );
}

function DepositAccounts() {
  const { t } = useI18n();
  const { data, isLoading } = useDepositAccounts(true);
  const [edit, setEdit] = useState(null); // null | {} | account
  const rows = data?.data || [];
  return (
    <div style={{ marginTop: '18px', borderTop: '1px solid var(--border)', paddingTop: '14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: '14px' }}>{t('co2.set.accounts')}</strong>
        <Button variant="secondary" icon={Plus} onClick={() => setEdit({})}>{t('co2.set.addAccount')}</Button>
      </div>
      <p className="co-note" style={{ margin: '4px 0 10px' }}>{t('co2.set.accountsHint')}</p>
      {isLoading && <div className="co-note">{t('common.loading')}</div>}
      {!isLoading && rows.length === 0 && <div className="co-note">{t('co2.set.noAccounts')}</div>}
      <div className="co-list">
        {rows.map((a) => (
          <div key={a.id} style={a.active ? undefined : { opacity: 0.6 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>{a.name} <span className={`co-chip ${a.active ? 'success' : 'info'}`}>{a.active ? t('co2.set.active') : t('co2.set.inactive')}</span></div>
              <div className="ref">{t(`co2.acct.${a.type}`)}{a.account_ref ? ` · ${a.account_ref}` : ''}</div>
            </div>
            <Button variant="ghost" icon={Pencil} onClick={() => setEdit(a)} aria-label={t('co2.set.edit')}>{t('co2.set.edit')}</Button>
          </div>
        ))}
      </div>
      {edit && <AccountModal account={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function AccountModal({ account, onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const save = useSaveDepositAccount();
  const [name, setName] = useState(account.name || '');
  const [type, setType] = useState(account.type || 'safe');
  const [ref, setRef] = useState(account.account_ref || '');
  const [active, setActive] = useState(account.active ?? true);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) { setError(t('co2.set.nameRequired')); return; }
    try {
      await save.mutateAsync({ id: account.id, name: name.trim(), type, account_ref: ref.trim() || null, active });
      toast.success(t('co2.set.accountSaved'));
      onClose();
    } catch (err) { setError(err.message || t('common.somethingWrong')); }
  }
  return (
    <Modal open onClose={save.isPending ? () => {} : onClose} title={account.id ? t('co2.set.editAccount') : t('co2.set.addAccount')}
      footer={<><Button variant="secondary" onClick={onClose} disabled={save.isPending}>{t('common.cancel')}</Button><Button type="submit" form="co-acct-form" disabled={save.isPending}>{t('common.save', 'Save')}</Button></>}>
      <form id="co-acct-form" onSubmit={submit} className="co-form">
        <label className="co-field"><span>{t('co2.set.name')}</span><input className="co-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></label>
        <label className="co-field">
          <span>{t('co2.set.type')}</span>
          <select className="co-input" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((x) => <option key={x} value={x}>{t(`co2.acct.${x}`)}</option>)}
          </select>
        </label>
        <label className="co-field"><span>{t('co2.set.ref')}</span><input className="co-input" value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} /></label>
        <label style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px' }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t('co2.set.active')}
        </label>
        {error && <span className="co-err">{error}</span>}
      </form>
    </Modal>
  );
}
