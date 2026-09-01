const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
  ShadingType, BorderStyle, HeadingLevel, AlignmentType,
} = require('docx');

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

function header(title, docNumber, meta) {
  return [
    new Paragraph({
      children: [new TextRun({ text: 'GURMAD', bold: true, size: 40, color: BRAND_GREEN })],
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
  const children = [
    ...header(
      'Cashout & Cash Reconciliation',
      cashout.cashout_number,
      `${cashout.zone_name} · ${new Date(cashout.period_start).toLocaleDateString()} – ${new Date(cashout.period_end).toLocaleDateString()} · Prepared ${new Date(cashout.created_at).toLocaleString()}`
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
    kvTable([
      ['Cashier (User ID)', `#${cashout.cashier_id}`], ['Head of Cashiers (User ID)', `#${cashout.head_of_cashiers_id}`],
      ['Prepared by', `#${cashout.created_by}`], ['Approved by', cashout.approved_by ? `#${cashout.approved_by}` : 'Not yet approved'],
    ]),
    sectionTitle('Signatures'),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({ children: [
        signatureCell('Cashier Signature'), signatureCell('Head of Cashiers Signature'), signatureCell('Collector Acknowledgement'),
      ] })],
    }),
    footer(`GURMAD Waste Management — System-generated Cashout document — ${cashout.cashout_number}`),
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
  const children = [
    ...header(
      'Invoice',
      invoice.invoice_number,
      `${invoice.customer_name} (${invoice.customer_number}) · Issued ${new Date(invoice.created_at).toLocaleString()}`
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
    footer(`GURMAD Waste Management — Invoice — ${invoice.invoice_number}`),
  ];
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

module.exports = { buildCashoutDocx, buildInvoiceDocx };
