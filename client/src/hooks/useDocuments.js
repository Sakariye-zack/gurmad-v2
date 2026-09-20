import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Master Functional Completion Program — Phase 5: Document & File
// Management. UI consumes authoritative API results only.

export function useDocuments(params = {}) {
  const qs = new URLSearchParams();
  if (params.title) qs.set('title', params.title);
  if (params.category) qs.set('category', params.category);
  if (params.status) qs.set('status', params.status);
  if (params.uploaded_by) qs.set('uploaded_by', params.uploaded_by);
  if (params.date_from) qs.set('date_from', params.date_from);
  if (params.date_to) qs.set('date_to', params.date_to);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'documents', params], queryFn: () => apiClient.get(`/v2/documents${query ? `?${query}` : ''}`) });
}

export function useDocument(id) {
  return useQuery({ queryKey: ['v2', 'documents', id], queryFn: () => apiClient.get(`/v2/documents/${id}`), enabled: !!id });
}

export function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (formData) => apiClient.uploadFile('/v2/documents', formData),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'documents'] }),
  });
}

export function useUpdateDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => apiClient.put(`/v2/documents/${id}`, data),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'documents'] }); qc.invalidateQueries({ queryKey: ['v2', 'documents', vars.id] }); },
  });
}

export function useReplaceDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, formData }) => apiClient.uploadFile(`/v2/documents/${id}/replace`, formData),
    // Hardening fix (Phase 10 deep review): this only invalidated the
    // list, never the OLD document's own detail cache — unlike every
    // other lifecycle action here (useUpdateDocument, useArchiveDocument,
    // etc). Replace voids the old document and creates a new one; the UI
    // navigates to the new id, but the old id's cached detail (still
    // showing 'active', not 'voided') stayed stale for anyone who
    // navigated back to it or had it open in another tab.
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'documents'] }); qc.invalidateQueries({ queryKey: ['v2', 'documents', vars.id] }); },
  });
}

function useLifecycleAction(action) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => apiClient.put(`/v2/documents/${id}/${action}`, data),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'documents'] }); qc.invalidateQueries({ queryKey: ['v2', 'documents', vars.id] }); },
  });
}
export function useArchiveDocument() { return useLifecycleAction('archive'); }
export function useRestoreDocument() { return useLifecycleAction('restore'); }
export function useVoidDocument() { return useLifecycleAction('void'); }

export async function fetchDocumentPreviewUrl(id) {
  return apiClient.fetchAuthorizedFileUrl(`/v2/documents/${id}/file`);
}

export async function downloadDocumentFile(id, filename) {
  return apiClient.downloadAuthorizedFile(`/v2/documents/${id}/file?download=1`, filename);
}

// Categories are LOCKED by explicit Business-Owner decision — exactly
// these 9 values, in this order. Never add/rename/remove without a new
// Decisions Amendment.
export const DOCUMENT_CATEGORIES = [
  { value: 'official', label: 'Official' },
  { value: 'contract', label: 'Contract' },
  { value: 'certificate', label: 'Certificate' },
  { value: 'report', label: 'Report' },
  { value: 'financial', label: 'Financial' },
  { value: 'hr', label: 'HR' },
  { value: 'procurement', label: 'Procurement' },
  { value: 'operational', label: 'Operational' },
  { value: 'other', label: 'Other' },
];

export const PREVIEWABLE_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
