import React, { useState } from 'react';
import { ListChecks, Plus, Trash2 } from 'lucide-react';
import { PageHeader, Card, Button, StatusBadge, LoadingState, ErrorState, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useMyTasks, useUpdateMyTaskStatus, useStaffTasks, useCreateStaffTask, useUpdateStaffTask, useDeleteStaffTask } from '../../hooks/useStaffTasks.js';
import { useEmployees } from '../../hooks/useEmployees.js';

// General staff Todo/Task tracker (user-requested). Two halves on one
// page: "My Tasks" (self-service, every authenticated staff member with
// a linked employee record — same ungated pattern as Account
// Security/My HR) and "Manage Tasks" (admin/gudoomiye/zone_accountant/
// head_of_cashiers — create, assign, edit, delete), gated the same way
// every other manager surface in this codebase is, via RoleGate's
// `permission` prop wired to the new Dynamic Roles & Permissions engine.

const STATUS_MAP = { pending: 'warning', in_progress: 'info', done: 'success' };
const PRIORITY_COLOR = { low: 'var(--text-muted)', medium: 'var(--warning, orange)', high: 'var(--danger)' };

export default function TasksPage() {
  return (
    <div>
      <PageHeader icon={ListChecks} title="Tasks" subtitle="Your to-do list, and — for managers — everyone else's." />
      <MyTasksSection />
      <RoleGate permission="staff_tasks.view">
        <ManageTasksSection />
      </RoleGate>
    </div>
  );
}

function MyTasksSection() {
  const { data, isLoading, error, refetch } = useMyTasks();
  const tasks = data?.data || [];
  const updateStatus = useUpdateMyTaskStatus();
  const toast = useToast();

  async function handleStatusChange(id, status) {
    try { await updateStatus.mutateAsync({ id, status }); }
    catch (err) { toast.error(err.message || 'Failed to update task.'); }
  }

  return (
    <div style={{ marginBottom: '28px' }}>
      <span style={sectionLabelStyle}>My Tasks</span>
      {isLoading && <LoadingState label="Loading your tasks…" />}
      {error && <ErrorState message={error.message} onRetry={refetch} />}
      {!isLoading && !error && tasks.length === 0 && (
        <Card style={{ padding: '16px' }}><p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>No tasks assigned to you.</p></Card>
      )}
      <div style={{ display: 'grid', gap: '10px' }}>
        {tasks.map((t) => (
          <Card key={t.id} style={{ padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: PRIORITY_COLOR[t.priority] }} />
                <strong style={{ fontSize: '14px' }}>{t.title}</strong>
              </div>
              {t.description && <p style={{ margin: '4px 0 0', fontSize: '12.5px', color: 'var(--text-muted)' }}>{t.description}</p>}
              {t.due_date && <p style={{ margin: '4px 0 0', fontSize: '11.5px', color: 'var(--text-muted)' }}>Due {new Date(t.due_date).toLocaleDateString()}</p>}
            </div>
            <select value={t.status} onChange={(e) => handleStatusChange(t.id, e.target.value)} style={selectStyle}>
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="done">Done</option>
            </select>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ManageTasksSection() {
  const [statusFilter, setStatusFilter] = useState('');
  const { data, isLoading, error, refetch } = useStaffTasks(statusFilter ? { status: statusFilter } : {});
  const tasks = data?.data || [];
  const { data: employeesData } = useEmployees();
  const employees = employeesData?.data || [];
  const toast = useToast();

  const [formOpen, setFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const createTask = useCreateStaffTask();
  const deleteTask = useDeleteStaffTask();

  async function handleDelete(id) {
    if (!window.confirm('Delete this task?')) return;
    try { await deleteTask.mutateAsync(id); toast.success('Task deleted.'); }
    catch (err) { toast.error(err.message || 'Failed to delete task.'); }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <span style={sectionLabelStyle}>Manage Tasks</span>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Done</option>
          </select>
          <Button icon={Plus} onClick={() => { setEditingTask(null); setFormOpen((o) => !o); }}>New Task</Button>
        </div>
      </div>

      {formOpen && (
        <TaskForm
          employees={employees}
          onClose={() => setFormOpen(false)}
          onSubmit={async (payload) => {
            try { await createTask.mutateAsync(payload); toast.success('Task created.'); setFormOpen(false); }
            catch (err) { toast.error(err.message || 'Failed to create task.'); }
          }}
        />
      )}

      {isLoading && <LoadingState label="Loading tasks…" />}
      {error && <ErrorState message={error.message} onRetry={refetch} />}
      {!isLoading && !error && tasks.length === 0 && (
        <Card style={{ padding: '16px' }}><p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>No tasks yet.</p></Card>
      )}
      <div style={{ overflowX: 'auto', border: tasks.length ? '1px solid var(--border)' : 'none', borderRadius: 'var(--radius-md)' }}>
        {tasks.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                {['Title', 'Assigned To', 'Priority', 'Due', 'Status', ''].map((h) => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={cellStyle}><strong>{t.title}</strong></td>
                  <td style={cellStyle}>{t.assigned_to_name || '—'}</td>
                  <td style={{ ...cellStyle, textTransform: 'capitalize' }}>{t.priority}</td>
                  <td style={cellStyle}>{t.due_date ? new Date(t.due_date).toLocaleDateString() : '—'}</td>
                  <td style={cellStyle}><StatusBadge status={t.status} map={STATUS_MAP} /></td>
                  <td style={cellStyle}>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <Button variant="ghost" style={smallBtnStyle} onClick={() => setEditingTask(t)}>Edit</Button>
                      <Trash2 size={16} style={{ cursor: 'pointer', color: 'var(--danger)' }} onClick={() => handleDelete(t.id)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editingTask && (
        <TaskEditModal task={editingTask} employees={employees} onClose={() => setEditingTask(null)} />
      )}
    </div>
  );
}

function TaskForm({ employees, onClose, onSubmit }) {
  const [form, setForm] = useState({ title: '', description: '', assigned_to_employee_id: '', priority: 'medium', due_date: '' });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          title: form.title.trim(),
          description: form.description.trim() || undefined,
          assigned_to_employee_id: form.assigned_to_employee_id ? Number(form.assigned_to_employee_id) : undefined,
          priority: form.priority,
          due_date: form.due_date || undefined,
        });
      }}
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px', marginBottom: '16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', alignItems: 'end' }}
    >
      <div style={{ gridColumn: 'span 2' }}>
        <label style={labelStyle}>Title</label>
        <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={inputStyle} />
      </div>
      <div style={{ gridColumn: 'span 2' }}>
        <label style={labelStyle}>Description</label>
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={inputStyle} />
      </div>
      <div>
        <label style={labelStyle}>Assign to</label>
        <select value={form.assigned_to_employee_id} onChange={(e) => setForm({ ...form, assigned_to_employee_id: e.target.value })} style={inputStyle}>
          <option value="">Unassigned</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>
      <div>
        <label style={labelStyle}>Priority</label>
        <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} style={inputStyle}>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
      <div>
        <label style={labelStyle}>Due date</label>
        <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} style={inputStyle} />
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <Button type="submit">Create</Button>
        <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}

function TaskEditModal({ task, employees, onClose }) {
  const [form, setForm] = useState({
    title: task.title, description: task.description || '', assigned_to_employee_id: task.assigned_to_employee_id || '',
    priority: task.priority, due_date: task.due_date ? task.due_date.slice(0, 10) : '', status: task.status,
  });
  const updateTask = useUpdateStaffTask(task.id);
  const toast = useToast();

  async function handleSubmit(e) {
    e.preventDefault();
    try {
      await updateTask.mutateAsync({
        title: form.title.trim(),
        description: form.description.trim() || null,
        assigned_to_employee_id: form.assigned_to_employee_id ? Number(form.assigned_to_employee_id) : null,
        priority: form.priority,
        due_date: form.due_date || null,
        status: form.status,
      });
      toast.success('Task updated.');
      onClose();
    } catch (err) {
      toast.error(err.message || 'Failed to update task.');
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Edit Task</h3>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <label style={labelStyle}>Title</label>
            <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Description</label>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Assign to</label>
            <select value={form.assigned_to_employee_id} onChange={(e) => setForm({ ...form, assigned_to_employee_id: e.target.value })} style={inputStyle}>
              <option value="">Unassigned</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Priority</label>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} style={inputStyle}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} style={inputStyle}>
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="done">Done</option>
              </select>
            </div>
          </div>
          <div>
            <label style={labelStyle}>Due date</label>
            <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} style={inputStyle} />
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={updateTask.isPending}>{updateTask.isPending ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

const sectionLabelStyle = { display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', margin: '0 0 10px' };
const cellStyle = { padding: '12px 14px' };
const smallBtnStyle = { padding: '6px 10px', fontSize: '12px' };
const labelStyle = { display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' };
const inputStyle = { width: '100%', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '13px', boxSizing: 'border-box' };
const selectStyle = { padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '12px' };
const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 };
const modalStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '20px', width: '420px', maxWidth: '92vw', maxHeight: '90vh', overflowY: 'auto' };
