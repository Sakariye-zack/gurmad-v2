import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Database, CheckCircle2, XCircle, Clock, HardDrive, Download, Loader2 } from 'lucide-react';
import { PageHeader, Button, DataTable, StatCard, Card, Modal, useToast } from '../../components/ui/index.js';
import { apiClient } from '../../lib/apiClient.js';
import { appLocale } from '../../lib/dateLocale.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

function fmtBytes(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(appLocale(), { dateStyle: 'medium', timeStyle: 'short' });
}

// Admin-only. The server independently enforces admin on every endpoint and
// requires the admin's password again before issuing a one-time download link.
export default function BackupsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [target, setTarget] = useState(null); // file name awaiting password
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [pwError, setPwError] = useState('');

  const status = useQuery({ queryKey: ['backups', 'status'], queryFn: () => apiClient.get('/v2/backups/status'), refetchInterval: 60000 });
  const list = useQuery({ queryKey: ['backups', 'list'], queryFn: () => apiClient.get('/v2/backups') });

  const run = useMutation({
    mutationFn: () => apiClient.post('/v2/backups/run', {}),
    onSuccess: (res) => {
      toast.success(t('backups.runOk', undefined, { file: res?.data?.file || '' }));
      qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (err) => {
      toast.error(err.message);
      qc.invalidateQueries({ queryKey: ['backups'] });
    },
  });

  const s = status.data?.data;
  const rows = list.data?.data || [];

  async function confirmDownload() {
    setBusy(true);
    setPwError('');
    try {
      const res = await apiClient.post(`/v2/backups/${encodeURIComponent(target)}/download-token`, { password });
      setTarget(null);
      setPassword('');
      window.location.href = `/api/v2/backups/download/${res.data.token}`;
    } catch (err) {
      setPwError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function closeModal() { setTarget(null); setPassword(''); setPwError(''); }

  const lastOk = s?.last?.ok;
  return (
    <div>
      <PageHeader
        icon={Database}
        title={t('backups.title')}
        subtitle={t('backups.subtitle')}
        actions={(
          <Button icon={run.isPending ? Loader2 : Database} onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? t('backups.running') : t('backups.runNow')}
          </Button>
        )}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard
          label={t('backups.last')}
          value={s?.last ? (lastOk ? 'OK' : t('backups.lastFailed')) : t('backups.none')}
          sub={s?.last_error ? s.last_error.line : (s?.last ? fmtDate(s.last.at) : undefined)}
          icon={lastOk === false || s?.last_error ? XCircle : CheckCircle2}
          accent={lastOk === false || s?.last_error ? 'var(--danger)' : 'var(--brand)'}
        />
        <StatCard
          label={t('backups.next')}
          value={s ? fmtDate(s.next_run_at) : ''}
          sub={s ? t('backups.nextSub', undefined, { time: s.schedule_utc }) : undefined}
          icon={Clock}
        />
        <StatCard
          label={t('backups.stored')}
          value={s ? fmtBytes(s.total_bytes) : ''}
          sub={s ? t('backups.storedSub', undefined, { db: s.count_db, up: s.count_uploads }) : undefined}
          icon={Database}
        />
        <StatCard
          label={t('backups.diskFree')}
          value={s?.disk ? fmtBytes(s.disk.free_bytes) : t('backups.diskUnknown')}
          sub={s?.disk ? t('backups.diskSub', undefined, { total: fmtBytes(s.disk.total_bytes) }) : undefined}
          icon={HardDrive}
        />
      </div>

      <DataTable
        columns={[{ label: t('backups.colDate') }, { label: t('backups.colType') }, { label: t('backups.colSize'), align: 'right' }, { label: '' }]}
        loading={list.isLoading}
        error={list.error?.message}
        onRetry={list.refetch}
        isEmpty={!list.isLoading && rows.length === 0}
        emptyTitle={t('backups.empty')}
      >
        {rows.map((f) => (
          <tr key={f.name} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={{ padding: '10px 14px' }}>
              <div>{fmtDate(f.created_at)}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{f.name}</div>
            </td>
            <td style={{ padding: '10px 14px' }}>{f.type === 'database' ? t('backups.typeDatabase') : t('backups.typeUploads')}</td>
            <td className="tabular-nums" style={{ padding: '10px 14px', textAlign: 'right' }}>{fmtBytes(f.size)}</td>
            <td style={{ padding: '10px 14px', textAlign: 'right' }}>
              <Button variant="secondary" icon={Download} onClick={() => setTarget(f.name)}>{t('backups.download')}</Button>
            </td>
          </tr>
        ))}
      </DataTable>

      <Card style={{ padding: '16px 20px', marginTop: '24px' }}>
        <div style={{ fontWeight: 800, marginBottom: '4px' }}>{t('backups.restoreTitle')}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{t('backups.restoreBody')}</div>
      </Card>

      <Modal
        open={!!target}
        onClose={closeModal}
        title={t('backups.confirmTitle')}
        footer={(
          <>
            <Button variant="secondary" onClick={closeModal}>{t('common.cancel')}</Button>
            <Button onClick={confirmDownload} disabled={busy || !password}>{t('backups.download')}</Button>
          </>
        )}
      >
        <form onSubmit={(e) => { e.preventDefault(); if (password && !busy) confirmDownload(); }}>
          <p style={{ marginTop: 0 }}>{t('backups.confirmBody', undefined, { file: target || '' })}</p>
          <label htmlFor="backup-pw" style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>{t('backups.password')}</label>
          <input
            id="backup-pw"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--surface)', color: 'var(--text)' }}
          />
          {pwError && <div role="alert" style={{ color: 'var(--danger)', fontSize: '13px', marginTop: '8px' }}>{pwError}</div>}
        </form>
      </Modal>
    </div>
  );
}
