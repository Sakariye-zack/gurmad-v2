import React, { useState } from 'react';
import { ArrowLeftRight, ArrowDownToLine, ArrowUpFromLine, Repeat, Undo2, PlayCircle } from 'lucide-react';
import { PageHeader, Button, DataTable, FilterBar, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useInventoryMovements, useIssueStock, useReceiveStock, useTransferStock, useReturnStock, useRecordOpeningBalance } from '../../hooks/useInventory.js';
import { useInventoryItems, useInventoryStores } from '../../hooks/useInventory.js';

const TYPE_LABELS = { opening_balance: 'Opening Balance', receipt: 'Receipt', issue: 'Issue', transfer_out: 'Transfer Out', transfer_in: 'Transfer In', adjustment: 'Adjustment', return: 'Return' };

export default function InventoryMovementsPage() {
  const [itemFilter, setItemFilter] = useState('');
  const [storeFilter, setStoreFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [activeModal, setActiveModal] = useState(null);
  const { data, isLoading, error, refetch } = useInventoryMovements({ item_id: itemFilter || undefined, store_id: storeFilter || undefined, movement_type: typeFilter || undefined });
  const { data: itemsData } = useInventoryItems({ status: 'active' });
  const { data: storesData } = useInventoryStores({ status: 'active' });
  const movements = data?.data || [];
  const items = itemsData?.data || [];
  const stores = storesData?.data || [];

  return (
    <div>
      <PageHeader
        icon={ArrowLeftRight}
        title="Stock Movements"
        subtitle="Immutable movement history. Every balance is derived from this ledger."
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <Button icon={ArrowDownToLine} variant="secondary" onClick={() => setActiveModal('receive')}>Receive</Button>
              <Button icon={ArrowUpFromLine} variant="secondary" onClick={() => setActiveModal('issue')}>Issue</Button>
              <Button icon={Repeat} variant="secondary" onClick={() => setActiveModal('transfer')}>Transfer</Button>
              <Button icon={Undo2} variant="secondary" onClick={() => setActiveModal('return')}>Return</Button>
              <RoleGate roles={['admin']}><Button icon={PlayCircle} variant="secondary" onClick={() => setActiveModal('opening')}>Opening Balance</Button></RoleGate>
            </div>
          </RoleGate>
        }
      />

      <FilterBar searchValue="" onSearchChange={() => {}} searchPlaceholder="">
        <select value={itemFilter} onChange={(e) => setItemFilter(e.target.value)} style={selectStyle}>
          <option value="">All items</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <select value={storeFilter} onChange={(e) => setStoreFilter(e.target.value)} style={selectStyle}>
          <option value="">All stores</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selectStyle}>
          <option value="">All types</option>
          {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading} error={error?.message} onRetry={refetch}
        isEmpty={!isLoading && !error && movements.length === 0}
        emptyTitle="No movements yet"
        columns={[{ label: 'Date' }, { label: 'Item' }, { label: 'Store' }, { label: 'Type' }, { label: 'Quantity' }]}
      >
        {movements.map((m) => (
          <tr key={m.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{new Date(m.created_at).toLocaleString()}</td>
            <td style={cellStyle}>{m.item_name}</td>
            <td style={cellStyle}>{m.store_name}</td>
            <td style={cellStyle}>{TYPE_LABELS[m.movement_type] || m.movement_type}</td>
            <td style={cellStyle} className="tabular-nums" style2={{ color: m.quantity < 0 ? 'var(--danger)' : 'var(--success)' }}>
              {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
            </td>
          </tr>
        ))}
      </DataTable>

      <ReceiveModal open={activeModal === 'receive'} onClose={() => setActiveModal(null)} items={items} stores={stores} />
      <IssueModal open={activeModal === 'issue'} onClose={() => setActiveModal(null)} items={items} stores={stores} />
      <TransferModal open={activeModal === 'transfer'} onClose={() => setActiveModal(null)} items={items} stores={stores} />
      <ReturnModal open={activeModal === 'return'} onClose={() => setActiveModal(null)} items={items} stores={stores} />
      <OpeningBalanceModal open={activeModal === 'opening'} onClose={() => setActiveModal(null)} items={items} stores={stores} />
    </div>
  );
}

function ItemStoreSelects({ itemId, setItemId, storeId, setStoreId, items, stores, storeLabel = 'Store' }) {
  return (
    <>
      <label style={fieldStyle}>
        <span style={labelStyle}>Item</span>
        <select value={itemId} onChange={(e) => setItemId(e.target.value)} style={inputStyle}>
          <option value="">Select an item…</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      </label>
      <label style={fieldStyle}>
        <span style={labelStyle}>{storeLabel}</span>
        <select value={storeId} onChange={(e) => setStoreId(e.target.value)} style={inputStyle}>
          <option value="">Select a store…</option>
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
    </>
  );
}

function ReceiveModal({ open, onClose, items, stores }) {
  const [itemId, setItemId] = useState(''); const [storeId, setStoreId] = useState(''); const [quantity, setQuantity] = useState('');
  const [reference, setReference] = useState(''); const [error, setError] = useState('');
  const receive = useReceiveStock(); const toast = useToast();
  if (!open) return null;
  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    if (!itemId || !storeId) { setError('Item and store are required.'); return; }
    if (!(parseInt(quantity, 10) > 0)) { setError('Quantity must be greater than 0.'); return; }
    if (!reference.trim()) { setError('Reference is required.'); return; }
    try {
      await receive.mutateAsync({ item_id: parseInt(itemId, 10), store_id: parseInt(storeId, 10), quantity: parseInt(quantity, 10), reference: reference.trim() });
      toast.success('Stock received.'); setItemId(''); setStoreId(''); setQuantity(''); setReference(''); onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }
  return (
    <Modal open onClose={receive.isPending ? () => {} : onClose} title="Receive Stock"
      footer={<><Button variant="secondary" onClick={onClose} disabled={receive.isPending}>Cancel</Button><Button type="submit" form="receive-form" disabled={receive.isPending}>{receive.isPending ? 'Saving…' : 'Receive'}</Button></>}>
      <form id="receive-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <ItemStoreSelects itemId={itemId} setItemId={setItemId} storeId={storeId} setStoreId={setStoreId} items={items} stores={stores} />
        <label style={fieldStyle}><span style={labelStyle}>Quantity</span><input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Reference</span><input value={reference} onChange={(e) => setReference(e.target.value)} style={inputStyle} /></label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function IssueModal({ open, onClose, items, stores }) {
  const [itemId, setItemId] = useState(''); const [storeId, setStoreId] = useState(''); const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState(''); const [error, setError] = useState('');
  const issue = useIssueStock(); const toast = useToast();
  if (!open) return null;
  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    if (!itemId || !storeId) { setError('Item and store are required.'); return; }
    if (!(parseInt(quantity, 10) > 0)) { setError('Quantity must be greater than 0.'); return; }
    if (!reason.trim()) { setError('Reason is required.'); return; }
    try {
      await issue.mutateAsync({ item_id: parseInt(itemId, 10), store_id: parseInt(storeId, 10), quantity: parseInt(quantity, 10), reason: reason.trim() });
      toast.success('Stock issued.'); setItemId(''); setStoreId(''); setQuantity(''); setReason(''); onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }
  return (
    <Modal open onClose={issue.isPending ? () => {} : onClose} title="Issue Stock"
      footer={<><Button variant="secondary" onClick={onClose} disabled={issue.isPending}>Cancel</Button><Button type="submit" form="issue-form" disabled={issue.isPending}>{issue.isPending ? 'Saving…' : 'Issue'}</Button></>}>
      <form id="issue-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <ItemStoreSelects itemId={itemId} setItemId={setItemId} storeId={storeId} setStoreId={setStoreId} items={items} stores={stores} />
        <label style={fieldStyle}><span style={labelStyle}>Quantity</span><input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} /></label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function TransferModal({ open, onClose, items, stores }) {
  const [itemId, setItemId] = useState(''); const [sourceId, setSourceId] = useState(''); const [destId, setDestId] = useState(''); const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState(''); const [error, setError] = useState('');
  const transfer = useTransferStock(); const toast = useToast();
  if (!open) return null;
  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    if (!itemId || !sourceId || !destId) { setError('Item, source, and destination are required.'); return; }
    if (sourceId === destId) { setError('Source and destination must differ.'); return; }
    if (!(parseInt(quantity, 10) > 0)) { setError('Quantity must be greater than 0.'); return; }
    if (!reason.trim()) { setError('Reason is required.'); return; }
    try {
      await transfer.mutateAsync({ item_id: parseInt(itemId, 10), source_store_id: parseInt(sourceId, 10), destination_store_id: parseInt(destId, 10), quantity: parseInt(quantity, 10), reason: reason.trim() });
      toast.success('Stock transferred.'); setItemId(''); setSourceId(''); setDestId(''); setQuantity(''); setReason(''); onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }
  return (
    <Modal open onClose={transfer.isPending ? () => {} : onClose} title="Transfer Stock"
      footer={<><Button variant="secondary" onClick={onClose} disabled={transfer.isPending}>Cancel</Button><Button type="submit" form="transfer-form" disabled={transfer.isPending}>{transfer.isPending ? 'Saving…' : 'Transfer'}</Button></>}>
      <form id="transfer-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}><span style={labelStyle}>Item</span><select value={itemId} onChange={(e) => setItemId(e.target.value)} style={inputStyle}><option value="">Select an item…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
        <label style={fieldStyle}><span style={labelStyle}>Source store</span><select value={sourceId} onChange={(e) => setSourceId(e.target.value)} style={inputStyle}><option value="">Select…</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label style={fieldStyle}><span style={labelStyle}>Destination store</span><select value={destId} onChange={(e) => setDestId(e.target.value)} style={inputStyle}><option value="">Select…</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label style={fieldStyle}><span style={labelStyle}>Quantity</span><input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} /></label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function ReturnModal({ open, onClose, items, stores }) {
  const [itemId, setItemId] = useState(''); const [storeId, setStoreId] = useState(''); const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState(''); const [error, setError] = useState('');
  const ret = useReturnStock(); const toast = useToast();
  if (!open) return null;
  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    if (!itemId || !storeId) { setError('Item and store are required.'); return; }
    if (!(parseInt(quantity, 10) > 0)) { setError('Quantity must be greater than 0.'); return; }
    if (!reason.trim()) { setError('Reason is required.'); return; }
    try {
      await ret.mutateAsync({ item_id: parseInt(itemId, 10), destination_store_id: parseInt(storeId, 10), quantity: parseInt(quantity, 10), reason: reason.trim() });
      toast.success('Return recorded.'); setItemId(''); setStoreId(''); setQuantity(''); setReason(''); onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }
  return (
    <Modal open onClose={ret.isPending ? () => {} : onClose} title="Record Return"
      footer={<><Button variant="secondary" onClick={onClose} disabled={ret.isPending}>Cancel</Button><Button type="submit" form="return-form" disabled={ret.isPending}>{ret.isPending ? 'Saving…' : 'Record Return'}</Button></>}>
      <form id="return-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <ItemStoreSelects itemId={itemId} setItemId={setItemId} storeId={storeId} setStoreId={setStoreId} items={items} stores={stores} storeLabel="Destination store" />
        <label style={fieldStyle}><span style={labelStyle}>Quantity</span><input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} /></label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function OpeningBalanceModal({ open, onClose, items, stores }) {
  const [itemId, setItemId] = useState(''); const [storeId, setStoreId] = useState(''); const [quantity, setQuantity] = useState('');
  const [error, setError] = useState('');
  const opening = useRecordOpeningBalance(); const toast = useToast();
  if (!open) return null;
  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    if (!itemId || !storeId) { setError('Item and store are required.'); return; }
    if (!(parseInt(quantity, 10) > 0)) { setError('Quantity must be greater than 0.'); return; }
    try {
      await opening.mutateAsync({ item_id: parseInt(itemId, 10), store_id: parseInt(storeId, 10), quantity: parseInt(quantity, 10) });
      toast.success('Opening balance recorded.'); setItemId(''); setStoreId(''); setQuantity(''); onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }
  return (
    <Modal open onClose={opening.isPending ? () => {} : onClose} title="Record Opening Balance"
      footer={<><Button variant="secondary" onClick={onClose} disabled={opening.isPending}>Cancel</Button><Button type="submit" form="opening-form" disabled={opening.isPending}>{opening.isPending ? 'Saving…' : 'Record'}</Button></>}>
      <form id="opening-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>One-time only per item/store pair — this cannot be repeated once any movement exists.</p>
        <ItemStoreSelects itemId={itemId} setItemId={setItemId} storeId={storeId} setStoreId={setStoreId} items={items} stores={stores} />
        <label style={fieldStyle}><span style={labelStyle}>Quantity</span><input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} style={inputStyle} /></label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = { padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '13px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = { padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit' };
