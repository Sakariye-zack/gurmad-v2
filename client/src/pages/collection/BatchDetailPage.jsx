import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardList, Play, Flag, XCircle, Plus, Trash2, CalendarClock, Receipt } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, ConfirmDialog, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import CapacityPanel, { CapacityPreview } from '../../components/collection/CapacityPanel.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  useBatch, useBatchCustomers, useStartBatch, useCloseCycleOnBatch, useCancelBatch,
  useCreateTask, useRemoveResource, useTaskStatus,
  useMarkCustomerStatus, useRescheduleCustomer, useBatches,
} from '../../hooks/useCollectionOps.js';
import { useEmployees } from '../../hooks/useEmployees.js';
import { useTrucks } from '../../hooks/useTrucks.js';
// User-reported gap (Phase 10 Billing audit): invoices previously had no
// path from an actual serviced collection to a real invoice — every one
// had to be typed by hand. See invoices.js's own POST /bulk-generate.
import { useBulkGenerateInvoices } from '../../hooks/useFinancial.js';

const STATUS_LABELS = { draft: 'Draft', assigned: 'Assigned', in_progress: 'In Progress', partially_completed: 'Partially Completed', completed: 'Completed', cancelled: 'Cancelled' };
const CUSTOMER_STATUS_MAP = { pending: 'warning', serviced: 'success', missed: 'danger', skipped: 'info', rescheduled: 'info' };

export default function BatchDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useBatch(id);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [addTaskOpen, setAddTaskOpen] = useState(false);
  const startBatch = useStartBatch(id);
  const closeCycle = useCloseCycleOnBatch(id);
  const cancelBatch = useCancelBatch(id);
  const bulkGenerateInvoices = useBulkGenerateInvoices();
  const toast = useToast();
  const batch = data?.data;

  if (isLoading) return <LoadingState label="Loading batch…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!batch) return null;

  const progress = batch.progress || {};

  async function handleStart() {
    try { await startBatch.mutateAsync(); toast.success('Batch started.'); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleCloseCycle() {
    try {
      const result = await closeCycle.mutateAsync();
      toast.success(`Batch is now ${STATUS_LABELS[result.data.status]}.`);
    } catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleGenerateInvoices() {
    try {
      const result = await bulkGenerateInvoices.mutateAsync(id);
      const { created, skipped_no_fee: skippedNoFee } = result.data;
      if (created.length === 0 && skippedNoFee.length === 0) {
        toast.success('Nothing to invoice — every serviced customer already has one.');
      } else if (skippedNoFee.length > 0) {
        toast.success(`${created.length} invoice(s) created. ${skippedNoFee.length} skipped — no fee on file (${skippedNoFee.map((c) => c.customer_name).join(', ')}).`);
      } else {
        toast.success(`${created.length} invoice(s) created.`);
      }
    } catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleCancel(reason) {
    try { await cancelBatch.mutateAsync(reason); toast.success('Batch cancelled.'); setCancelOpen(false); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  return (
    <div>
      <button onClick={() => navigate('/collection-cycles/batches')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Batches
      </button>

      <PageHeader
        icon={ClipboardList}
        title={batch.batch_code}
        subtitle={`${batch.zone_name} · ${batch.customer_type}${batch.commercial_shift ? ` (${batch.commercial_shift})` : ''}`}
        actions={
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <RoleGate roles={['admin', 'gudoomiye']}>
              {['draft', 'assigned'].includes(batch.status) && <Button variant="secondary" icon={Play} onClick={handleStart} disabled={startBatch.isPending}>Start</Button>}
              {['in_progress', 'assigned', 'partially_completed'].includes(batch.status) && <Button variant="secondary" icon={Flag} onClick={handleCloseCycle} disabled={closeCycle.isPending}>Close Cycle</Button>}
              {!['completed', 'cancelled'].includes(batch.status) && <Button variant="danger" icon={XCircle} onClick={() => setCancelOpen(true)}>Cancel</Button>}
            </RoleGate>
            {/* Generate Invoices — user-reported gap (Phase 10). Same
                CREATE_ROLES the backend route itself enforces (admin,
                cashier — a cashier, not just admin/gudoomiye, is who
                actually bills customers). Shown once there's at least
                one serviced customer, regardless of whether the batch
                itself has been formally closed yet — a partially-worked
                batch can still have real, billable serviced visits. */}
            {(progress.serviced ?? 0) > 0 && (
              <RoleGate roles={['admin', 'cashier']}>
                <Button variant="secondary" icon={Receipt} onClick={handleGenerateInvoices} disabled={bulkGenerateInvoices.isPending}>
                  {bulkGenerateInvoices.isPending ? 'Generating…' : 'Generate Invoices'}
                </Button>
              </RoleGate>
            )}
          </div>
        }
      />

      <div style={{ marginBottom: '20px' }}>
        <DetailGrid items={[
          { label: 'Status', value: <StatusBadge status={STATUS_LABELS[batch.status]} map={{ draft: 'info', assigned: 'warning', 'in progress': 'warning', 'partially completed': 'warning', completed: 'success', cancelled: 'danger' }} /> },
          { label: 'Progress', value: `${progress.percent_complete ?? 0}%` },
          { label: 'Total customers', value: progress.total ?? batch.total_customers, className: 'tabular-nums' },
          { label: 'Pending', value: progress.pending ?? '—', className: 'tabular-nums' },
          { label: 'Serviced', value: progress.serviced ?? '—', className: 'tabular-nums' },
          { label: 'Missed', value: progress.missed ?? '—', className: 'tabular-nums' },
          { label: 'Skipped', value: progress.skipped ?? '—', className: 'tabular-nums' },
          { label: 'Rescheduled', value: progress.rescheduled ?? '—', className: 'tabular-nums' },
        ]} />
      </div>

      <span style={sectionLabelStyle}>Capacity</span>
      <div style={{ marginBottom: '20px' }}>
        <CapacityPanel capacity={batch.capacity} />
      </div>

      <span style={sectionLabelStyle}>Tasks &amp; Resources</span>
      <RoleGate roles={['admin', 'gudoomiye']}>
        <div style={{ marginBottom: '12px' }}>
          <Button variant="secondary" icon={Plus} onClick={() => setAddTaskOpen(true)}>Add Task</Button>
        </div>
      </RoleGate>
      {(batch.tasks || []).length === 0 && (
        <Card style={{ padding: '16px', marginBottom: '20px' }}>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>No tasks created yet.</p>
        </Card>
      )}
      {(batch.tasks || []).map((task) => (
        <TaskCard key={task.id} task={task} batchId={id} currentUserRole={user?.role} />
      ))}

      <span style={{ ...sectionLabelStyle, marginTop: '24px' }}>Customers</span>
      <CustomerStatusTable batchId={id} tasks={batch.tasks || []} currentUserRole={user?.role} />

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => handleCancel(document.getElementById('cancel-reason')?.value || '')}
        title="Cancel this batch?"
        message={<CancelReasonPrompt />}
        confirmLabel="Cancel Batch"
        danger
        isLoading={cancelBatch.isPending}
      />
      <AddTaskModal open={addTaskOpen} onClose={() => setAddTaskOpen(false)} batchId={id} />
    </div>
  );
}

function CancelReasonPrompt() {
  return (
    <div>
      <p style={{ margin: '0 0 8px' }}>This will stop all further work on the batch. A reason is required.</p>
      <input id="cancel-reason" placeholder="Reason for cancellation" style={inputStyle} />
    </div>
  );
}

function TaskCard({ task, batchId, currentUserRole }) {
  const toast = useToast();
  const removeResource = useRemoveResource(batchId, task.id);
  const taskStatus = useTaskStatus(batchId, task.id);
  const isAdminOrGud = currentUserRole === 'admin' || currentUserRole === 'gudoomiye';
  // Task-start blocking (final hardening pass, §D): a capacity or DR-7
  // stale-assignment block must stay visible on the card, not just flash
  // as a toast — the server's exact message (capacity/current load/excess)
  // is shown inline until the user acts again.
  const [startBlockedMessage, setStartBlockedMessage] = useState(null);

  async function handleRemove(r) {
    const reason = window.prompt(`Reason for removing this ${r.resource_type}?`);
    if (!reason) return;
    try {
      await removeResource.mutateAsync({ resourceType: r.resource_type, resourceId: r.resource_id, reason });
      toast.success('Resource removed.');
    } catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleStatus(status) {
    setStartBlockedMessage(null);
    try {
      await taskStatus.mutateAsync(status);
      toast.success(`Task status changed to ${status}.`);
    } catch (err) {
      const message = err.message || 'Something went wrong.';
      toast.error(message);
      if (status === 'in_progress' && /capacity|DR-7|assignment/i.test(message)) setStartBlockedMessage(message);
    }
  }

  return (
    <Card style={{ padding: '16px', marginBottom: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <strong>Task #{task.id}</strong> — <StatusBadge status={task.status.replace('_', ' ')} map={{ pending: 'warning', 'in progress': 'info', completed: 'success' }} />
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {task.status === 'pending' && <Button variant="secondary" onClick={() => handleStatus('in_progress')} disabled={taskStatus.isPending}>Start Task</Button>}
          {task.status === 'in_progress' && <Button variant="primary" onClick={() => handleStatus('completed')} disabled={taskStatus.isPending}>Complete Task</Button>}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' }}>
        {task.resources.length === 0 && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No resources assigned.</span>}
        {task.resources.map((r) => (
          <span key={`${r.resource_type}-${r.resource_id}`} style={chipStyle}>
            <span style={{ textTransform: 'capitalize' }}>{r.resource_type}</span>: {r.name || `#${r.resource_id}`}
            {isAdminOrGud && (
              <button onClick={() => handleRemove(r)} aria-label="Remove" style={chipRemoveStyle}><Trash2 size={12} /></button>
            )}
          </span>
        ))}
      </div>
      {startBlockedMessage && (
        <div style={{ marginTop: '10px', padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--danger-bg)', color: 'var(--danger)', fontSize: '12px', fontWeight: 600 }}>
          Task Start blocked: {startBlockedMessage}
        </div>
      )}
    </Card>
  );
}

function AddTaskModal({ open, onClose, batchId }) {
  if (!open) return null;
  return <AddTaskContent onClose={onClose} batchId={batchId} />;
}
function AddTaskContent({ onClose, batchId }) {
  const [resourceType, setResourceType] = useState('collector');
  const [resourceId, setResourceId] = useState('');
  const [error, setError] = useState('');
  const createTask = useCreateTask(batchId);
  const { data: employeesData } = useEmployees({ employee_type: resourceType === 'truck' ? undefined : resourceType, status: 'active' });
  const { data: trucksData } = useTrucks({ status: 'active' });
  const { data: batchData } = useBatch(batchId);
  const toast = useToast();
  const options = resourceType === 'truck' ? (trucksData?.data || []) : (employeesData?.data || []);
  const batchLoad = batchData?.data?.capacity?.load ?? batchData?.data?.total_customers ?? 0;
  // Truck-selection capacity preview (final hardening pass, §C): client-side
  // preview only, using the SELECTED truck's own capacity against the
  // batch's current load — the server re-checks authoritatively on submit
  // regardless of what this shows.
  const selectedTruck = resourceType === 'truck' && resourceId ? options.find((t) => String(t.id) === resourceId) : null;
  const wouldExceedCapacity = selectedTruck && selectedTruck.capacity != null && batchLoad > selectedTruck.capacity;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      const resources = resourceId ? [{ resource_type: resourceType, resource_id: parseInt(resourceId, 10) }] : [];
      await createTask.mutateAsync({ resources });
      toast.success('Task created.');
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={createTask.isPending ? () => {} : onClose}
      title="Add Task"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={createTask.isPending}>Cancel</Button>
        <Button type="submit" form="add-task-form" disabled={createTask.isPending || wouldExceedCapacity}>{createTask.isPending ? 'Saving…' : 'Add Task'}</Button>
      </>}
    >
      <form id="add-task-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>A task can start with no resource, or one — add more from the batch&rsquo;s Task card afterward.</span>
        <label style={fieldStyle}>
          <span style={labelStyle}>Resource type</span>
          <select value={resourceType} onChange={(e) => { setResourceType(e.target.value); setResourceId(''); }} style={inputStyle}>
            <option value="collector">Collector</option>
            <option value="driver">Driver</option>
            <option value="truck">Truck</option>
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Resource</span>
          <select value={resourceId} onChange={(e) => setResourceId(e.target.value)} style={inputStyle}>
            <option value="">None (add later)</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name || o.plate_number}{resourceType === 'truck' && o.capacity != null ? ` (capacity ${o.capacity})` : ''}</option>)}
          </select>
        </label>
        {selectedTruck && selectedTruck.capacity != null && (
          <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: wouldExceedCapacity ? 'var(--danger-bg)' : 'var(--bg)', border: '1px solid var(--border)' }}>
            <span className="tabular-nums" style={{ fontSize: '12px', fontWeight: wouldExceedCapacity ? 700 : 400, color: wouldExceedCapacity ? 'var(--danger)' : 'var(--text-muted)' }}>
              Batch load {batchLoad} / truck capacity {selectedTruck.capacity}
              {wouldExceedCapacity ? ` — Over Capacity by ${batchLoad - selectedTruck.capacity}. This truck cannot be assigned.` : ' — Within Capacity.'}
            </span>
          </div>
        )}
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function CustomerStatusTable({ batchId, tasks, currentUserRole }) {
  const { data, isLoading, error, refetch } = useBatchCustomers(batchId);
  const markStatus = useMarkCustomerStatus(batchId);
  const reschedule = useRescheduleCustomer(batchId);
  const { data: otherBatchesData } = useBatches({ status: 'draft' });
  const toast = useToast();
  const [missedTarget, setMissedTarget] = useState(null);
  const [rescheduleTarget, setRescheduleTarget] = useState(null);
  const canMarkStatus = currentUserRole === 'admin' || currentUserRole === 'collector';
  const canReschedule = ['admin', 'gudoomiye', 'zone_accountant'].includes(currentUserRole);
  const rows = data?.data || [];
  const openTasks = tasks.filter((t) => t.status !== 'completed');
  const defaultTaskId = openTasks[0]?.id ?? tasks[0]?.id ?? null;

  async function handleMark(customerId, status, reason) {
    try {
      await markStatus.mutateAsync({ customerId, status, task_id: defaultTaskId, reason });
      toast.success(`Marked ${status}.`);
      setMissedTarget(null);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  async function handleReschedule(customerId, targetBatchId) {
    try {
      await reschedule.mutateAsync({ customerId, target_batch_id: targetBatchId });
      toast.success('Customer rescheduled.');
      setRescheduleTarget(null);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  if (isLoading) return <LoadingState label="Loading customers…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;

  return (
    <>
      <DataTableSimple
        rows={rows}
        renderRow={(c) => (
          <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{c.customer_number}</td>
            <td style={cellStyle}>{c.business_name || c.name}</td>
            <td style={cellStyle}><StatusBadge status={c.status} map={CUSTOMER_STATUS_MAP} /></td>
            <td style={cellStyle}>
              {c.status === 'pending' && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {canMarkStatus && !defaultTaskId && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Add a task first.</span>}
                  {canMarkStatus && defaultTaskId && (
                    <>
                      <Button variant="secondary" onClick={() => handleMark(c.customer_id, 'serviced')} disabled={markStatus.isPending}>Serviced</Button>
                      <Button variant="secondary" onClick={() => setMissedTarget(c)} disabled={markStatus.isPending}>Missed</Button>
                      <Button variant="secondary" onClick={() => handleMark(c.customer_id, 'skipped')} disabled={markStatus.isPending}>Skip</Button>
                    </>
                  )}
                </div>
              )}
              {c.status === 'missed' && canReschedule && (
                <Button variant="secondary" icon={CalendarClock} onClick={() => setRescheduleTarget(c)}>Reschedule</Button>
              )}
            </td>
          </tr>
        )}
      />
      <Modal
        open={!!missedTarget}
        onClose={() => setMissedTarget(null)}
        title="Mark as Missed"
        footer={<>
          <Button variant="secondary" onClick={() => setMissedTarget(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => handleMark(missedTarget.customer_id, 'missed', document.getElementById('missed-reason')?.value)} disabled={markStatus.isPending}>Confirm Missed</Button>
        </>}
      >
        <label style={fieldStyle}>
          <span style={labelStyle}>Reason (required)</span>
          <input id="missed-reason" style={inputStyle} placeholder="e.g. Gate locked, no one home" />
        </label>
      </Modal>
      <Modal
        open={!!rescheduleTarget}
        onClose={() => setRescheduleTarget(null)}
        title="Reschedule Customer"
        footer={null}
      >
        <p style={{ margin: '0 0 10px', fontSize: '13px', color: 'var(--text-muted)' }}>Choose a target Draft batch to move this customer into. Adding this customer to an over-capacity target will be blocked by the server.</p>
        {(otherBatchesData?.data || []).filter((b) => b.id !== Number(batchId)).map((b) => (
          <RescheduleTargetOption
            key={b.id}
            batch={b}
            onSelect={() => handleReschedule(rescheduleTarget.customer_id, b.id)}
            disabled={reschedule.isPending}
          />
        ))}
        {(otherBatchesData?.data || []).length === 0 && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No other Draft batches available — create one first.</span>}
      </Modal>
    </>
  );
}

// Batch list rows already carry their own live `capacity` (backend list
// endpoint was extended in this same pass) — no extra fetch needed here.
function RescheduleTargetOption({ batch, onSelect, disabled }) {
  const wouldExceed = batch.capacity && batch.capacity.capacity != null
    && (batch.capacity.load + 1) > batch.capacity.capacity;
  return (
    <div style={{ marginBottom: '8px' }}>
      <Button
        variant="secondary"
        style={{ width: '100%', justifyContent: 'flex-start', opacity: wouldExceed ? 0.6 : 1 }}
        onClick={onSelect}
        disabled={disabled || wouldExceed}
      >
        {batch.batch_code}
      </Button>
      <div style={{ padding: '2px 4px' }}>
        <CapacityPreview capacityBefore={batch.capacity} additionalLoad={1} />
      </div>
    </div>
  );
}

function DataTableSimple({ rows, renderRow }) {
  if (rows.length === 0) {
    return (
      <Card style={{ padding: '16px' }}>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>No customers in this batch yet.</p>
      </Card>
    );
  }
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
            {['Customer #', 'Name', 'Status', 'Actions'].map((h) => (
              <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{rows.map(renderRow)}</tbody>
      </table>
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
const sectionLabelStyle = {
  display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)', margin: '0 0 10px',
};
const chipStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderRadius: '999px',
  background: 'var(--bg)', border: '1px solid var(--border)', fontSize: '12px', fontWeight: 600,
};
const chipRemoveStyle = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', display: 'flex', padding: 0 };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
