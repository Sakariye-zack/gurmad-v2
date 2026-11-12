import React, { useMemo, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Modal, Button } from '../../components/ui/index.js';
import { useBulkAssignSubzone, useZonesList } from '../../hooks/useCustomers.js';
import { useGroups, useRoutesForGroup } from '../../hooks/useGroups.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { groupLabel, districtLabel } from '../../lib/hierarchy.js';

// Bulk "Assign Sub Zone" for the customers selected on the Customers list.
// The server (POST /v2/customers/bulk/assign-subzone) applies every rule —
// same district, active Sub Zone, zone scope, DR-7 collector type — and
// reports the customers it skipped with a reason; this modal only collects
// the target and shows that result.
export default function AssignSubZoneModal({ open, customers, onClose }) {
  const { t } = useI18n();
  const mutation = useBulkAssignSubzone();
  const [zoneId, setZoneId] = useState(() => {
    const zs = [...new Set(customers.map((c) => c.zone_id))];
    return zs.length === 1 ? String(zs[0]) : '';
  });
  const [groupId, setGroupId] = useState('');
  const [routeId, setRouteId] = useState('');
  const [result, setResult] = useState(null);
  const { data: zonesData } = useZonesList();
  const districts = zonesData?.data || [];
  const { data: groupsData } = useGroups({ limit: 200, status: 'active', zone_id: zoneId || undefined });
  const groups = groupsData?.data || [];
  const { data: routesData } = useRoutesForGroup(groupId || undefined);
  const routes = (routesData?.data || []).filter((r) => r.status === 'active');
  const byId = useMemo(() => new Map(customers.map((c) => [c.id, c])), [customers]);
  const districtsOfSelection = new Set(customers.map((c) => c.zone_id)).size;

  const submit = async () => {
    try {
      const r = await mutation.mutateAsync({ customer_ids: customers.map((c) => c.id), route_id: Number(routeId) });
      setResult(r.data);
    } catch { /* error shown below */ }
  };

  const route = routes.find((r) => String(r.id) === routeId);
  const footer = result
    ? <Button onClick={() => onClose(true)}>{t('common.close')}</Button>
    : (<>
      <Button variant="secondary" onClick={() => onClose(false)}>{t('common.cancel')}</Button>
      <Button onClick={submit} disabled={!routeId || mutation.isPending}>{mutation.isPending ? t('cl.bulk.working') : t('cl.bulk.assignN', undefined, { n: customers.length })}</Button>
    </>);

  return (
    <Modal open={open} onClose={() => onClose(!!result)} title={t('cl.bulk.title')} footer={footer} maxWidth="560px">
      {result ? (
        <div className="cl-form">
          <div className="cl-result"><CheckCircle2 size={16} style={{ verticalAlign: '-3px', marginRight: '6px' }} />{t('cl.bulk.updated', undefined, { n: result.updated })}</div>
          {result.skipped.length > 0 && (<>
            <div className="cl-note">{t('cl.bulk.skippedN', undefined, { n: result.skipped.length })}</div>
            <div className="cl-skips">
              {result.skipped.map((s) => {
                const c = byId.get(s.id);
                return (
                  <div key={s.id}>
                    <span><strong className="tabular-nums">{c ? c.customer_number : `#${s.id}`}</strong>{c ? ` · ${c.name}` : ''}</span>
                    <span className="cl-muted" title={s.message || undefined}>{t('cl.skip.' + s.reason, s.reason)}</span>
                  </div>
                );
              })}
            </div>
          </>)}
        </div>
      ) : (
        <div className="cl-form">
          <div className="cl-note">{t('cl.bulk.intro', undefined, { n: customers.length })}</div>
          {districtsOfSelection > 1 && <div className="cl-err">{t('cl.bulk.mixedDistricts')}</div>}
          {districts.length > 1 && (
            <label className="cl-field">
              <span>{t('map.f.district')}</span>
              <select className="cl-input" value={zoneId} onChange={(e) => { setZoneId(e.target.value); setGroupId(''); setRouteId(''); }}>
                <option value="">{t('map.f.all_districts')}</option>
                {districts.map((z) => <option key={z.id} value={String(z.id)}>{districtLabel(z.name)}</option>)}
              </select>
            </label>
          )}
          <label className="cl-field">
            <span>{t('map.f.group')}</span>
            <select className="cl-input" value={groupId} onChange={(e) => { setGroupId(e.target.value); setRouteId(''); }}>
              <option value="">{t('cl.bulk.pickGroup')}</option>
              {groups.map((g) => <option key={g.id} value={String(g.id)}>{groupLabel(g.code, g.name) + (g.zone_name ? ` — ${districtLabel(g.zone_name)}` : '')}</option>)}
            </select>
          </label>
          <label className="cl-field">
            <span>{t('map.f.subzone')}</span>
            <select className="cl-input" value={routeId} onChange={(e) => setRouteId(e.target.value)} disabled={!groupId}>
              <option value="">{t('cl.bulk.pickSubZone')}</option>
              {routes.map((r) => (
                <option key={r.id} value={String(r.id)}>
                  {[r.group_zone_name || r.group_zone_code, r.name || r.code].filter(Boolean).join(' › ')}{r.collector_name ? ` — ${r.collector_name}` : ''}
                </option>
              ))}
            </select>
          </label>
          {route && !route.collector_user_id && <div className="cl-note">{t('cl.bulk.noCollector')}</div>}
          <div className="cl-note">{t('cl.bulk.rules')}</div>
          {mutation.error && <div className="cl-err">{mutation.error.message}</div>}
        </div>
      )}
    </Modal>
  );
}
