import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wallet, Search, Receipt } from 'lucide-react';
import { PageHeader, Button, Card, StatusBadge, LoadingState, useToast, StatCard } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useInvoices, useInvoice, useRecordPayment } from '../../hooks/useFinancial.js';

const STATUS_MAP = { unpaid: 'danger', partial: 'warning', paid: 'success', voided: 'info' };

// Billing — the money-collection workflow. Deliberately NOT a duplicate
// Invoice management page (per the approved architecture): this page only
// ever selects an outstanding invoice and records a payment against it —
// it never edits an invoice's own document fields, never shows a create-
// invoice form, and performs zero balance/status calculation itself.
export default function BillingView() {
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(null);
  // Search box — user-reported gap (Phase 10): a cashier had no way to
  // find a specific customer's invoice quickly, only a flat scroll list.
  // Reuses the existing, already-wired ?q= backend param (invoice
  // number / customer name / customer number, ILIKE, 2-char minimum) —
  // useInvoices already forwards it, no hook change needed.
  const [q, setQ] = useState('');
  const { data, isLoading, error, refetch } = useInvoices({ q: q.trim().length >= 2 ? q.trim() : undefined });
  const invoices = (data?.data || []).filter((i) => i.status !== 'voided' && i.status !== 'paid');
  // User-reported gap ('qaybtan billing kayga waxba ka dhiman'): every
  // comparable list screen (InvoicesListPage, DebtsView) opens with
  // at-a-glance stat cards — Billing, the busiest daily-use screen for a
  // cashier, had none. Counts only (not a $ total) — invoice_total alone
  // would overstate a partial invoice's true remaining balance, which
  // isn't in this list response, so a misleading number is never shown.
  const unpaidCount = invoices.filter((i) => i.status === 'unpaid').length;
  const partialCount = invoices.filter((i) => i.status === 'partial').length;

  return (
    <div>
      <PageHeader icon={Wallet} title="Billing" subtitle="Record payments against outstanding invoices." />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <StatCard label="Outstanding Invoices" value={error ? '—' : invoices.length} icon={Wallet} />
        <StatCard label="Unpaid" value={error ? '—' : unpaidCount} icon={Wallet} accent="var(--danger)" />
        <StatCard label="Partial" value={error ? '—' : partialCount} icon={Wallet} accent="var(--warning)" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px', alignItems: 'flex-start' }}>
        <div>
          <span style={sectionLabelStyle}>Outstanding Invoices</span>
          <div style={{ position: 'relative', marginBottom: '10px' }}>
            <Search size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by customer name or number…"
              style={{
                width: '100%', padding: '11px 12px 11px 36px', borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
                fontSize: '14px', fontFamily: 'inherit', minHeight: '44px',
              }}
            />
          </div>
          {isLoading && <LoadingState label="Loading…" />}
          {error && <Card style={{ padding: '16px' }}><p style={{ margin: 0, color: 'var(--danger)', fontSize: '13px' }}>{error.message}</p></Card>}
          {!isLoading && !error && invoices.length === 0 && (
            <Card style={{ padding: '16px' }}><p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>{q.trim().length >= 2 ? 'No match for that search.' : 'Nothing outstanding.'}</p></Card>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {invoices.map((inv) => (
              <Card
                key={inv.id}
                onClick={() => setSelectedInvoiceId(inv.id)}
                style={{ padding: '12px 14px', cursor: 'pointer', border: selectedInvoiceId === inv.id ? '1px solid var(--brand)' : '1px solid var(--border)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>{inv.invoice_number}</strong>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{inv.customer_name} ({inv.customer_number})</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="tabular-nums" style={{ fontWeight: 700 }}>{inv.currency} {parseFloat(inv.invoice_total).toFixed(2)}</div>
                    <StatusBadge status={inv.status} map={STATUS_MAP} />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>

        <div>
          <span style={sectionLabelStyle}>Record Payment</span>
          {selectedInvoiceId ? (
            <PaymentPanel invoiceId={selectedInvoiceId} onRecorded={refetch} />
          ) : (
            <Card style={{ padding: '20px' }}>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>
                <Search size={14} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                Select an outstanding invoice to record a payment against it.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function PaymentPanel({ invoiceId, onRecorded }) {
  const navigate = useNavigate();
  const { data, isLoading, refetch } = useInvoice(invoiceId);
  const recordPayment = useRecordPayment();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [method, setMethod] = useState('cash');
  const [error, setError] = useState('');
  const invoice = data?.data;

  if (isLoading || !invoice) return <LoadingState label="Loading invoice…" />;
  const balance = invoice.balance || {};

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setError('Enter a valid payment amount.'); return; }
    try {
      await recordPayment.mutateAsync({ invoice_id: invoiceId, amount: amt, currency, method });
      toast.success('Payment recorded.');
      setAmount('');
      refetch();
      onRecorded?.();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Card style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <strong style={{ fontSize: '14px' }}>{invoice.invoice_number}</strong>
        {/* User-reported gap ('qaybtan billing kayga waxba ka dhiman'):
            after collecting cash here, a cashier had no way to reach the
            printable receipt/document — had to know to navigate to
            Invoices separately. Direct link to the same invoice's full
            detail page (Print / Download .docx already live there). */}
        <Button variant="secondary" icon={Receipt} onClick={() => navigate(`/financial/invoices/${invoiceId}`)} style={{ padding: '6px 10px', fontSize: '12px' }}>
          View / Print Receipt
        </Button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '16px' }}>
        <StatCard label="Invoice Total" value={`$${parseFloat(invoice.invoice_total).toFixed(2)}`} />
        <StatCard label="Paid" value={`$${(balance.paid ?? 0).toFixed?.(2) ?? balance.paid}`} accent="var(--success)" />
        <StatCard label="Outstanding" value={`$${(balance.outstanding ?? 0).toFixed?.(2) ?? balance.outstanding}`} accent={balance.outstanding > 0 ? 'var(--danger)' : 'var(--success)'} />
      </div>

      {invoice.status === 'paid' ? (
        <p style={{ margin: 0, color: 'var(--success)', fontSize: '13px', fontWeight: 700 }}>This invoice is fully paid.</p>
      ) : (
        <RoleGate roles={['admin', 'cashier']} fallback={<p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)' }}>View-only — your role cannot record payments.</p>}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', gap: '10px' }}>
              <label style={fieldStyle}>
                <span style={labelStyle}>Amount ({currency})</span>
                <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={inputStyle} />
              </label>
              <label style={fieldStyle}>
                <span style={labelStyle}>Currency</span>
                <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
                  <option value="USD">USD</option>
                  <option value="SLSH">SLSH</option>
                </select>
              </label>
            </div>
            <label style={fieldStyle}>
              <span style={labelStyle}>Payment method</span>
              <select value={method} onChange={(e) => setMethod(e.target.value)} style={inputStyle}>
                <option value="cash">Cash</option>
                <option value="zaad">ZAAD</option>
                <option value="edahab">eDahab</option>
                <option value="slsh">SLSH</option>
                <option value="debt">Debt</option>
              </select>
            </label>
            {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
            <Button type="submit" disabled={recordPayment.isPending}>{recordPayment.isPending ? 'Recording…' : 'Record Payment'}</Button>
          </form>
        </RoleGate>
      )}

      <div style={{ marginTop: '20px' }}>
        <span style={sectionLabelStyle}>Payment History</span>
        {(invoice.payments || []).length === 0 && <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>None yet.</p>}
        {(invoice.payments || []).map((p) => (
          <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <span style={{ textTransform: 'capitalize' }}>{p.method} — {p.currency} {parseFloat(p.amount).toFixed(2)}</span>
            <StatusBadge status={p.status} map={{ recorded: 'success', reversed: 'danger' }} />
          </div>
        ))}
      </div>
    </Card>
  );
}

const sectionLabelStyle = {
  display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)', margin: '0 0 10px',
};
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
