import React, { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Card, Button, Modal, StatusBadge, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { apiClient } from '../../lib/apiClient.js';

// Phase 4 — Customer Portal — OD-5: a minimal, additive UI integration
// into the CLOSED Module 2 Customer Detail page. This component only
// calls the new Customer Portal API (POST /v2/customer-portal/accounts,
// GET /v2/customer-portal/accounts/by-customer/:id) — it never touches
// Module 2's own customer routes/schema, and Module 2's own CRUD behavior
// is unchanged (this card is purely additive below the existing page
// content).
export default function CustomerPortalAccessCard({ customerId }) {
  const toast = useToast();
  const [account, setAccount] = useState(undefined); // undefined = loading, null = none
  const [modalOpen, setModalOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    apiClient.get(`/v2/customer-portal/accounts/by-customer/${customerId}`)
      .then((res) => setAccount(res.data))
      .catch(() => setAccount(null));
  }

  useEffect(load, [customerId]);

  async function handleActivate(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiClient.post('/v2/customer-portal/accounts', { customer_id: Number(customerId), initial_password: password });
      toast.success('Portal access activated. Share the initial password with the customer securely.');
      setModalOpen(false);
      setPassword('');
      load();
    } catch (err) {
      toast.error(err.message || 'Failed to activate portal access.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <RoleGate roles={['admin']}>
      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: '14px' }}>Customer Portal Access</h3>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>
              {account === undefined
                ? 'Loading…'
                : account
                  ? <>Portal account <StatusBadge status={account.status} /> since {new Date(account.created_at).toLocaleDateString()}</>
                  : 'This customer does not yet have Customer Portal access.'}
            </p>
          </div>
          {account === null && (
            <Button variant="secondary" icon={KeyRound} onClick={() => setModalOpen(true)}>Activate Portal Access</Button>
          )}
        </div>
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Activate Portal Access"
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button onClick={handleActivate} disabled={saving || password.length < 8}>{saving ? 'Activating…' : 'Activate'}</Button>
          </>
        }
      >
        <p style={{ marginTop: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
          Set an initial password for this customer's portal account. Share it with them securely —
          they can change it after logging in.
        </p>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>
          Initial Password
        </label>
        <input
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px', boxSizing: 'border-box' }}
        />
      </Modal>
    </RoleGate>
  );
}
