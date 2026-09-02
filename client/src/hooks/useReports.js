import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Module 8 — Reports. UI consumes authoritative, already-computed API
// results only — no total is ever recalculated in React (non-negotiable
// per the approved spec).

function buildQuery(period, customStart, customEnd, extra = {}) {
  const qs = new URLSearchParams({ period, ...(period === 'custom' ? { start: customStart || '', end: customEnd || '' } : {}) });
  Object.entries(extra).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') qs.set(k, v); });
  return qs.toString();
}

function useReport(category, period, customStart, customEnd, extra = {}, enabled = true) {
  const qs = buildQuery(period, customStart, customEnd, extra);
  return useQuery({
    queryKey: ['v2', 'reports', category, period, customStart, customEnd, extra],
    queryFn: () => apiClient.get(`/v2/reports/${category}?${qs}`),
    enabled: enabled && (period !== 'custom' || (!!customStart && !!customEnd)),
  });
}

export const useExecutiveSummary = (period, s, e) => useReport('executive-summary', period, s, e);
export const useCollectorPerformance = (period, s, e, extra) => useReport('collector-performance', period, s, e, extra);
export const useZonePerformance = (period, s, e) => useReport('zone-performance', period, s, e);
export const useTruckPerformance = (period, s, e, extra) => useReport('truck-performance', period, s, e, extra);
export const useCollectionHistory = (period, s, e, extra) => useReport('collection-history', period, s, e, extra);
export const useRevenue = (period, s, e, extra, enabled) => useReport('revenue', period, s, e, extra, enabled);
export const useInvoicesSummary = (period, s, e, extra, enabled) => useReport('invoices-summary', period, s, e, extra, enabled);
export const usePaymentsSummary = (period, s, e, extra, enabled) => useReport('payments-summary', period, s, e, extra, enabled);
export const useDebtsSummary = (period, s, e, extra, enabled) => useReport('debts-summary', period, s, e, extra, enabled);
export const useCashoutSummary = (period, s, e, extra, enabled) => useReport('cashout-summary', period, s, e, extra, enabled);
export const useFinancialSummary = (period, s, e, enabled) => useReport('financial-summary', period, s, e, {}, enabled);

// CSV export — authorized download, never a plain static link, per the
// document-security principle established in Module 7.
export async function downloadReportCsv(category, period, customStart, customEnd, extra = {}) {
  const qs = buildQuery(period, customStart, customEnd, extra);
  await apiClient.downloadAuthorizedFile(`/v2/reports/${category}/export.csv?${qs}`, `${category}-${new Date().toISOString().slice(0, 10)}.csv`);
}
