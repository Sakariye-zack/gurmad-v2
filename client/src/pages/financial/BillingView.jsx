import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wallet, Search, Receipt, Smartphone } from 'lucide-react';
import { PageHeader, Button, Card, StatusBadge, LoadingState, useToast, StatCard, Modal } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useInvoices, useInvoice, useRecordPayment, useRequestZaadPayment } from '../../hooks/useFinancial.js';

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
  // ZAAD push payment — user-requested ('customerka numberkiisa galiyo
  // si loogu diro'): a dedicated flow, not just another payment method
  // in the existing form, since it needs the customer's phone number and
  // a distinct "Send Request" action/pending state (the request can take
  // several seconds while the customer approves on their own phone).
  const requestZaad = useRequestZaadPayment();
  const [zaadOpen, setZaadOpen] = useState(false);
  const toast = useToast();
  // User-requested ('hlkan debtga iyo partialkaba iigu soo dar intanan
  // lacagta record garayn') — split into two amount fields recorded
  // together in one action, instead of one 'Amount' field: 'Amount
  // Paid' (real money — Payment method applies to this portion only)
  // and 'Amount as Debt'. Each becomes its own payment row (the debt
  // portion with method='debt') — the already-existing auto-debt
  // tracking (payments.js POST /) picks up the debt-method one exactly
  // like any other and reflects it on the Debts screen; no backend
  // change was needed for this, the pieces were already there.
  const [amountPaid, setAmountPaid] = useState('');
  const [amountDebt, setAmountDebt] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [method, setMethod] = useState('cash');
  const [error, setError] = useState('');
  const invoice = data?.data;

  if (isLoading || !invoice) return <LoadingState label="Loading invoice…" />;
  const balance = invoice.balance || {};

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const paidAmt = parseFloat(amountPaid) || 0;
    const debtAmt = parseFloat(amountDebt) || 0;
    if (paidAmt <= 0 && debtAmt <= 0) { setError('Enter an amount paid, an amount as debt, or both.'); return; }
    if (paidAmt < 0 || debtAmt < 0) { setError('Amounts cannot be negative.'); return; }
    try {
      // Two rows, one user action — the server itself still enforces
      // each individually (row-locked, overpayment-blocked), so a
      // combined total exceeding the outstanding balance is rejected
      // exactly like a single payment would be, just on whichever call
      // hits the limit first.
      if (paidAmt > 0) await recordPayment.mutateAsync({ invoice_id: invoiceId, amount: paidAmt, currency, method });
      if (debtAmt > 0) await recordPayment.mutateAsync({ invoice_id: invoiceId, amount: debtAmt, currency, method: 'debt' });
      toast.success(paidAmt > 0 && debtAmt > 0 ? 'Payment recorded — remainder recorded as debt.' : debtAmt > 0 ? 'Recorded as debt.' : 'Payment recorded.');
      setAmountPaid('');
      setAmountDebt('');
      refetch();
      onRecorded?.();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
      refetch(); // one of the two calls may have already succeeded
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
          {/* ZAAD push payment — user-requested: send a real payment
              request straight to the customer's phone instead of only
              recording a payment someone already collected in person. */}
          <Button variant="secondary" icon={Smartphone} onClick={() => setZaadOpen(true)} style={{ marginBottom: '14px' }}>
            Send ZAAD Payment Request
          </Button>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', gap: '10px' }}>
              <label style={fieldStyle}>
                <span style={labelStyle}>Amount Paid ({currency})</span>
                <input type="number" min="0" step="0.01" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} style={inputStyle} placeholder="0.00" />
              </label>
              <label style={fieldStyle}>
                <span style={labelStyle}>Payment method</span>
                <select value={method} onChange={(e) => setMethod(e.target.value)} style={inputStyle}>
                  <option value="cash">Cash</option>
                  <option value="zaad">ZAAD</option>
                  <option value="edahab">eDahab</option>
                  <option value="slsh">SLSH</option>
                </select>
              </label>
            </div>
            <label style={fieldStyle}>
              <span style={labelStyle}>Amount as Debt ({currency}) — optional</span>
              <input type="number" min="0" step="0.01" value={amountDebt} onChange={(e) => setAmountDebt(e.target.value)} style={inputStyle} placeholder="0.00" />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>Currency</span>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
                <option value="USD">USD</option>
                <option value="SLSH">SLSH</option>
              </select>
            </label>
            {(parseFloat(amountPaid) > 0 || parseFloat(amountDebt) > 0) && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Total this action: {currency} {((parseFloat(amountPaid) || 0) + (parseFloat(amountDebt) || 0)).toFixed(2)}
                {parseFloat(amountDebt) > 0 && ` — ${currency} ${parseFloat(amountDebt).toFixed(2)} will show as an unpaid Debt for this customer.`}
              </div>
            )}
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

      <ZaadRequestModal
        open={zaadOpen}
        onClose={() => setZaadOpen(false)}
        invoice={invoice}
        requestZaad={requestZaad}
        onDone={() => { refetch(); onRecorded?.(); }}
      />
    </Card>
  );
}

// ZAAD push payment modal — user-requested ('customerka numberkiisa
// galiyo si loogu diro'): enter the customer's phone (prefilled from the
// customer's own record), send the request, wait for the customer to
// approve on their own phone (synchronous — see zaadService.js's own
// comment), then reflect the resulting payment/invoice state immediately.
function ZaadRequestModal({ open, onClose, invoice, requestZaad, onDone }) {
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState('');
  const toast = useToast();

  React.useEffect(() => {
    if (open && invoice) {
      setPhone(invoice.customer_phone || '');
      setAmount(invoice.balance?.outstanding ? String(invoice.balance.outstanding.toFixed?.(2) ?? invoice.balance.outstanding) : '');
      setCurrency('USD');
      setError('');
    }
  }, [open, invoice]);

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!phone.trim()) { setError('A phone number is required.'); return; }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setError('Amount must be a positive number.'); return; }
    try {
      await requestZaad.mutateAsync({ invoice_id: invoice.id, phone: phone.trim(), amount: amt, currency });
      toast.success('ZAAD payment received and recorded.');
      onClose();
      onDone?.();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={requestZaad.isPending ? () => {} : onClose}
      title="Send ZAAD Payment Request"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={requestZaad.isPending}>Cancel</Button>
        <Button type="submit" form="zaad-request-form" disabled={requestZaad.isPending}>
          {requestZaad.isPending ? 'Waiting for customer…' : 'Send Request'}
        </Button>
      </>}
    >
      <form id="zaad-request-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
          A payment confirmation prompt is sent straight to this phone number. This screen waits until the customer approves it — that can take a few seconds.
        </p>
        <label style={fieldStyle}>
          <span style={labelStyle}>Customer's ZAAD phone number</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} placeholder="e.g. 0634259981" disabled={requestZaad.isPending} />
        </label>
        <div style={{ display: 'flex', gap: '10px' }}>
          <label style={fieldStyle}>
            <span style={labelStyle}>Amount ({currency})</span>
            <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={inputStyle} disabled={requestZaad.isPending} />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>Currency</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle} disabled={requestZaad.isPending}>
              <option value="USD">USD</option>
              <option value="SLSH">SLSH</option>
            </select>
          </label>
        </div>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
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
