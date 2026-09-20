const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
  ShadingType, BorderStyle, HeadingLevel, AlignmentType,
} = require('docx');
const { pool } = require('../db');

// Generates real, downloadable .docx files for the two document-like V2
// outputs (Cashout, Invoice) — per explicit user request, additive to
// both modules, no schema/API-shape change to either. One shared style
// vocabulary so both documents look like the same company's paperwork,
// not two different tools.

const BRAND_GREEN = '2E7D32';
const MUTED = '6B7280';
const BORDER = 'D0D5DD';

function hairline() {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BRAND_GREEN } },
    spacing: { after: 200 },
  });
}
function sectionTitle(text) {
  return new Paragraph({
    children: [new TextRun({ text: text.toUpperCase(), bold: true, color: BRAND_GREEN, size: 20 })],
    spacing: { before: 240, after: 100 },
  });
}
function cell(text, { bold = false, width = 25, shaded = false } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    shading: shaded ? { type: ShadingType.CLEAR, fill: 'F2F4F7' } : undefined,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({ text: String(text ?? '—'), bold })] })],
  });
}
function kvTable(rows) {
  // rows: [[label, value], ...] rendered 2-per-line as a 4-column table.
  const trs = [];
  for (let i = 0; i < rows.length; i += 2) {
    const [l1, v1] = rows[i];
    const pair2 = rows[i + 1];
    trs.push(new TableRow({
      children: [
        cell(l1, { bold: true, width: 20, shaded: true }), cell(v1, { width: 30 }),
        ...(pair2 ? [cell(pair2[0], { bold: true, width: 20, shaded: true }), cell(pair2[1], { width: 30 })] : [cell('', { width: 20 }), cell('', { width: 30 })]),
      ],
    }));
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: trs });
}
function money(n) {
  return `$${parseFloat(n || 0).toFixed(2)}`;
}

// Company name — user-requested ('meel kasta oo magaca system ku ka soo
// muuqanayo waa in aan markan update gareeyo'): every generated document
// (Invoice .docx, Cashout .docx, the Customer Portal's own invoice HTML
// preview) had 'GURMAD' baked in as a literal string — a customer-facing
// letterhead is exactly the surface a stale hardcoded name matters most
// on. Queried once per document build, defaulting to 'GURMAD' only if no
// company_name was ever set — same fallback every other surface uses.
async function getCompanyNameForDocument() {
  try {
    const r = await pool.query('SELECT company_name FROM company_settings WHERE id = 1');
    return r.rows[0]?.company_name || 'GURMAD';
  } catch {
    return 'GURMAD'; // never block document generation on this lookup failing
  }
}

function header(title, docNumber, meta, companyName) {
  return [
    new Paragraph({
      children: [new TextRun({ text: companyName, bold: true, size: 40, color: BRAND_GREEN })],
    }),
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 24 })],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [new TextRun({ text: meta, size: 18, color: MUTED })],
      spacing: { after: 60 },
    }),
    new Paragraph({
      children: [new TextRun({ text: docNumber, bold: true, size: 20 })],
      alignment: AlignmentType.RIGHT,
      spacing: { after: 40 },
    }),
    hairline(),
  ];
}

function footer(text) {
  return new Paragraph({
    children: [new TextRun({ text, size: 16, color: MUTED, italics: true })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 300 },
  });
}

async function buildCashoutDocx(cashout, recon, shortage = null) {
  const companyName = await getCompanyNameForDocument();
  const children = [
    ...header(
      'Cashout & Cash Reconciliation',
      cashout.cashout_number,
      `${cashout.zone_name} · ${new Date(cashout.period_start).toLocaleDateString()} – ${new Date(cashout.period_end).toLocaleDateString()} · Prepared ${new Date(cashout.created_at).toLocaleString()}`,
      companyName
    ),
    sectionTitle('Collection Summary'),
    kvTable([
      ['Customers', recon.customerCount], ['Transactions', recon.transactionCount],
      ['Expected Amount', money(cashout.expected_amount)], ['Amount Cashed Out', money(cashout.actual_amount)],
      ['Currency', 'USD'], ['Status', cashout.status.toUpperCase()],
    ]),
    sectionTitle('Collection Source Breakdown'),
    ...(recon.sourceBreakdown.length === 0
      ? [new Paragraph({ children: [new TextRun({ text: 'No linked collection events in this period.', italics: true, color: MUTED })] })]
      : recon.sourceBreakdown.map((s) => new Paragraph({
          children: [new TextRun({ text: `${s.source === 'unlinked' ? 'Not linked to a collection event' : s.source.charAt(0).toUpperCase() + s.source.slice(1) + ' collections'}: ` }), new TextRun({ text: money(s.total), bold: true })],
        }))),
    sectionTitle('Payment Method Breakdown'),
    ...(recon.methodBreakdown.length === 0
      ? [new Paragraph({ children: [new TextRun({ text: 'No recorded payments in this period.', italics: true, color: MUTED })] })]
      : recon.methodBreakdown.map((m) => new Paragraph({
          children: [new TextRun({ text: `${m.method.toUpperCase()}: ` }), new TextRun({ text: money(m.total), bold: true })],
        }))),
    sectionTitle('Reconciliation'),
    kvTable([
      ['System Expected', money(cashout.expected_amount)], ['Physical/Received', money(cashout.actual_amount)],
      ['Difference', money(Math.abs(cashout.expected_amount - cashout.actual_amount))],
      ['Difference Type', parseFloat(cashout.shortage) > 0 ? 'Shortage' : parseFloat(cashout.surplus) > 0 ? 'Surplus' : 'Exact Match'],
    ]),
    // Cashout Shortage — cashier accountability/reconciliation liability,
    // explicitly NOT rendered as a "Customer Debt" (architecture decision,
    // this pass). Only shown when a shortage record actually exists.
    ...(shortage ? [
      new Paragraph({ children: [new TextRun({ text: 'Cashier Shortage', bold: true, color: BRAND_GREEN })], spacing: { before: 140, after: 60 } }),
      kvTable([
        ['Shortage Amount', money(shortage.shortage_amount)], ['Cashier Responsible', `#${shortage.cashier_id}`],
        ['Status', shortage.status.toUpperCase()], ['Resolved Amount', shortage.resolved_amount != null ? money(shortage.resolved_amount) : '—'],
      ]),
      new Paragraph({ children: [new TextRun({ text: 'Shortage reason: ', bold: true }), new TextRun({ text: shortage.reason })], spacing: { before: 80 } }),
      ...(shortage.resolution_notes ? [new Paragraph({ children: [new TextRun({ text: 'Resolution notes: ', bold: true }), new TextRun({ text: shortage.resolution_notes })] })] : []),
    ] : []),
    ...(cashout.remarks ? [new Paragraph({ children: [new TextRun({ text: 'Remarks: ', bold: true }), new TextRun({ text: cashout.remarks })] })] : []),
    sectionTitle('Accountability'),
    // User-reported gap (Phase 10 Billing audit, continued sweep): every
    // row here read as a bare numeric id ('#33'). The route now joins
    // each *_name — fall back to the id only if a user account was since
    // deleted (name join came back null), never silently blank.
    kvTable([
      ['Cashier', cashout.cashier_name || `#${cashout.cashier_id}`],
      ['Head of Cashiers', cashout.head_of_cashiers_name || `#${cashout.head_of_cashiers_id}`],
      ['Prepared by', cashout.created_by_name || `#${cashout.created_by}`],
      ['Approved by', cashout.approved_by ? (cashout.approved_by_name || `#${cashout.approved_by}`) : 'Not yet approved'],
    ]),
    sectionTitle('Signatures'),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({ children: [
        signatureCell('Cashier Signature'), signatureCell('Head of Cashiers Signature'), signatureCell('Collector Acknowledgement'),
      ] })],
    }),
    footer(`${companyName} — System-generated Cashout document — ${cashout.cashout_number}`),
  ];
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

function signatureCell(label) {
  return new TableCell({
    width: { size: 33, type: WidthType.PERCENTAGE },
    margins: { top: 400, bottom: 100, left: 100, right: 100 },
    children: [
      new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' } }, spacing: { after: 60 } }),
      new Paragraph({ children: [new TextRun({ text: label, size: 16, color: MUTED })] }),
    ],
  });
}

async function buildInvoiceDocx(invoice) {
  const balance = invoice.balance || {};
  const companyName = await getCompanyNameForDocument();
  const children = [
    ...header(
      'Invoice',
      invoice.invoice_number,
      `${invoice.customer_name} (${invoice.customer_number}) · Issued ${new Date(invoice.created_at).toLocaleString()}`,
      companyName
    ),
    sectionTitle('Invoice Summary'),
    kvTable([
      ['Invoice Total', money(invoice.invoice_total)], ['Discount', money(invoice.discount_amount)],
      ['Currency', invoice.currency], ['Status', invoice.status.toUpperCase()],
      ['Paid', money(balance.paid)], ['Outstanding', money(balance.outstanding)],
    ]),
    sectionTitle('Payment History'),
    ...(!invoice.payments || invoice.payments.length === 0
      ? [new Paragraph({ children: [new TextRun({ text: 'No payments recorded yet.', italics: true, color: MUTED })] })]
      : [new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: [cell('Amount', { bold: true, shaded: true }), cell('Method', { bold: true, shaded: true }), cell('USD Value', { bold: true, shaded: true }), cell('Status', { bold: true, shaded: true }), cell('Date', { bold: true, shaded: true })] }),
            ...invoice.payments.map((p) => new TableRow({ children: [
              cell(`${p.currency} ${parseFloat(p.amount).toFixed(2)}`), cell(p.method.toUpperCase()), cell(money(p.amount_usd)), cell(p.status.toUpperCase()), cell(new Date(p.created_at).toLocaleDateString()),
            ] })),
          ],
        })]),
    ...(invoice.status === 'voided' ? [
      sectionTitle('Void Information'),
      new Paragraph({ children: [new TextRun({ text: 'Voided reason: ', bold: true }), new TextRun({ text: invoice.voided_reason || '—' })] }),
      new Paragraph({ children: [new TextRun({ text: 'Voided at: ', bold: true }), new TextRun({ text: new Date(invoice.voided_at).toLocaleString() })] }),
    ] : []),
    footer(`${companyName} — Invoice — ${invoice.invoice_number}`),
  ];
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// Customer Portal Rebuild — Implementation Spec §11 (OD-5/Invoice
// Preview). A server-rendered HTML twin of the same data buildInvoiceDocx()
// already assembles — deliberately NOT a PDF-conversion pipeline and NOT a
// client-side .docx renderer (no new runtime dependency, no new failure
// mode, for a feature that only needs "see before download"). Every
// interpolated field is escaped explicitly — this function must never
// string-concatenate untrusted data straight into the HTML (customer
// name/notes are the two fields that could plausibly carry another
// customer's chosen text).
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function buildInvoiceHtml(invoice) {
  const balance = invoice.balance || {};
  const companyName = await getCompanyNameForDocument();
  const rows = (invoice.payments || []).map((p) => `
    <tr>
      <td>${escapeHtml(p.currency)} ${escapeHtml(parseFloat(p.amount).toFixed(2))}</td>
      <td>${escapeHtml(String(p.method).toUpperCase())}</td>
      <td>${escapeHtml(money(p.amount_usd))}</td>
      <td>${escapeHtml(String(p.status).toUpperCase())}</td>
      <td>${escapeHtml(new Date(p.created_at).toLocaleDateString())}</td>
    </tr>`).join('');

  return `
<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(invoice.invoice_number)}</title>
<style>
  /* Explicit color-scheme + background — without this, some browsers
     auto-dark-invert an iframe's default (white) background while leaving
     our own hardcoded dark text color untouched, rendering every value
     invisible (dark-on-dark). Found live via a screenshot during Hardening
     of this rebuild pass — the raw HTML was correct, only the rendered
     appearance was broken. */
  :root { color-scheme: light; }
  html, body { background: #ffffff; }
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; color: #1B1F16; padding: 24px; }
  h1 { color: #2F7D3E; font-size: 22px; margin: 0 0 4px; }
  .meta { color: #6B7280; font-size: 13px; margin-bottom: 16px; }
  .doc-number { text-align: right; font-weight: 700; margin-bottom: 8px; }
  hr { border: none; border-top: 3px solid #2F7D3E; margin: 12px 0 20px; }
  .section-title { color: #2F7D3E; text-transform: uppercase; font-size: 13px; font-weight: 800; margin: 20px 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #D0D5DD; }
  th { background: #F2F4F7; font-size: 11px; text-transform: uppercase; }
  .kv { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 24px; font-size: 13px; }
  .kv div span:first-child { color: #6B7280; display: block; font-size: 11px; text-transform: uppercase; }
</style></head>
<body>
  <h1>${escapeHtml(companyName)}</h1>
  <div class="meta">${escapeHtml(invoice.customer_name)} (${escapeHtml(invoice.customer_number)}) &middot; Issued ${escapeHtml(new Date(invoice.created_at).toLocaleString())}</div>
  <div class="doc-number">${escapeHtml(invoice.invoice_number)}</div>
  <hr>
  <div class="section-title">Invoice Summary</div>
  <div class="kv">
    <div><span>Invoice Total</span>${escapeHtml(money(invoice.invoice_total))}</div>
    <div><span>Discount</span>${escapeHtml(money(invoice.discount_amount))}</div>
    <div><span>Currency</span>${escapeHtml(invoice.currency)}</div>
    <div><span>Status</span>${escapeHtml(String(invoice.status).toUpperCase())}</div>
    <div><span>Paid</span>${escapeHtml(money(balance.paid))}</div>
    <div><span>Outstanding</span>${escapeHtml(money(balance.outstanding))}</div>
  </div>
  <div class="section-title">Payment History</div>
  ${rows ? `<table><thead><tr><th>Amount</th><th>Method</th><th>USD Value</th><th>Status</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table>` : '<p style="color:#6B7280;font-style:italic;">No payments recorded yet.</p>'}
</body></html>`;
}

module.exports = { buildCashoutDocx, buildInvoiceDocx, buildInvoiceHtml };
