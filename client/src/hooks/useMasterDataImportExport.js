import { useMutation } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Master Functional Completion Program — Phase 6: Import/Export + Master
// Data Governance. Reuses the existing apiClient.uploadFile/
// downloadAuthorizedFile helpers unchanged (no new fetch/blob logic
// invented, per every prior phase's own precedent).

export const IMPORT_ENTITIES = [
  { value: 'zones', label: 'Zones', zoneScoped: false },
  { value: 'customers', label: 'Customers', zoneScoped: true },
  { value: 'trucks', label: 'Trucks', zoneScoped: true },
  { value: 'leave-types', label: 'Leave Types', zoneScoped: false },
  { value: 'inventory-items', label: 'Inventory Items', zoneScoped: false },
];

export const EXPORT_ENTITIES = [
  { value: 'zones', label: 'Zones', zoneScoped: false },
  { value: 'customers', label: 'Customers', zoneScoped: true },
  { value: 'trucks', label: 'Trucks', zoneScoped: true },
  { value: 'leave-types', label: 'Leave Types', zoneScoped: false },
  { value: 'inventory-items', label: 'Inventory Items', zoneScoped: false },
  { value: 'suppliers', label: 'Suppliers', zoneScoped: false },
  { value: 'inventory-stores', label: 'Inventory Stores', zoneScoped: true },
  { value: 'employees', label: 'Employees', zoneScoped: true },
  { value: 'groups', label: 'Groups', zoneScoped: true },
  { value: 'routes', label: 'Routes', zoneScoped: false },
  { value: 'asset-register', label: 'Asset Register', zoneScoped: true },
];

export function useValidateImport() {
  return useMutation({
    mutationFn: ({ entity, formData }) => apiClient.uploadFile(`/v2/master-data/${entity}/import/validate`, formData),
  });
}

export function useCommitImport() {
  return useMutation({
    mutationFn: ({ entity, formData }) => apiClient.uploadFile(`/v2/master-data/${entity}/import/commit`, formData),
  });
}

export async function exportMasterData(entity, filters = {}) {
  const qs = new URLSearchParams(filters).toString();
  return apiClient.downloadAuthorizedFile(`/v2/master-data/${entity}/export${qs ? `?${qs}` : ''}`, `${entity}-${new Date().toISOString().slice(0, 10)}.csv`);
}
