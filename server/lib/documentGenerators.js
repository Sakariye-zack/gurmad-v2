const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
  ShadingType, BorderStyle, AlignmentType, ImageRun, VerticalAlign,
} = require('docx');
const { pool } = require('../db');
const { getCompanyBranding } = require('./companyBranding');

// Generates the downloadable company paperwork (Invoice .docx, Cashout
// .docx, and the Customer Portal's HTML invoice preview). Every document
// shares one letterhead: the uploaded logo, company name, tagline and
// contact lines (Settings > Company Information), in the logo's own
// green/orange.

const BRAND_GREEN = '3DAA35';
const BRAND_ORANGE = 'F5A623';
const INK = '1B1F16';
const MUTED = '6B7280';
const BORDER = 'E3E8E1';
const SOFT = 'F3F8F1';
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
// Sans-serif to match the on-screen preview (Word's default is a serif).
const DOC_STYLES = { default: { document: { run: { font: 'Segoe UI', size: 19, color: INK } } } };
const PAGE = { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } };

function hairline(color = BRAND_GREEN, size = 12) {
  return new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size, color } }, spacing: { after: 200 } });
}
function sectionTitle(text) {
  return new Paragraph({
    children: [new TextRun({ text: text.toUpperCase(), bold: true, color: BRAND_GREEN, size: 18, characterSpacing: 40 })],
    spacing: { before: 280, after: 100 },
  });
}
function cell(text, { bold = false, width = 25, shaded = false, align = AlignmentType.LEFT, color = INK, sub = null } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    shading: shaded ? { type: ShadingType.CLEAR, fill: SOFT } : undefined,
    margins: { top: 90, bottom: 90, left: 120, right: 120 },
    children: [
      new Paragraph({ alignment: align, children: [new TextRun({ text: String(text ?? '—'), bold, color, size: 19 })] }),
      ...(sub ? [new Paragraph({ alignment: align, children: [new TextRun({ text: sub, color: MUTED, size: 16 })] })] : []),
    ],
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
        cell(l1, { bold: true, width: 20, shaded: true, color: MUTED }), cell(v1, { width: 30 }),
        ...(pair2 ? [cell(pair2[0], { bold: true, width: 20, shaded: true, color: MUTED }), cell(pair2[1], { width: 30 })] : [cell('', { width: 20 }), cell('', { width: 30 })]),
      ],
    }));
  }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE }, rows: trs,
    borders: { top: NONE, left: NONE, right: NONE, bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, insideVertical: NONE },
  });
}
function money(n, currency = 'USD') {
  const v = parseFloat(n || 0);
  return currency === 'SLSH' ? `${Math.round(v).toLocaleString('en-US')} SLSH` : `$${v.toFixed(2)}`;
}
function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// '2026-11' -> 'Nov 2026'
function periodLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}
function serviceDescription(invoice) {
  return invoice.billing_period ? `Waste collection — ${periodLabel(invoice.billing_period)}` : 'Waste collection service';
}
// '2026-11-03' -> '03 Nov'
function dayLabel(iso) {
  return `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}
// Secondary-currency figures + exchange rate (null when no rate is configured).
function dualInfo(invoice) {
  const b = invoice.balance || {};
  const cur = invoice.currency === 'SLSH' ? 'SLSH' : 'USD';
  const other = cur === 'SLSH' ? 'USD' : 'SLSH';
  const sec = other === 'USD' ? b.usd : b.slsh;
  if (!sec || !b.rate || !(Number(b.rate.rate) > 0)) return null;
  const rate = Number(b.rate.rate);
  const rateText = `1 USD = ${rate.toLocaleString('en-US', { maximumFractionDigits: 2 })} SLSH`;
  return { other, sec, rateText };
}
// The invoice total is shown gross of discount; scale the secondary (net) figure to match.
function secondaryTotal(invoice, d) {
  const net = Number((invoice.balance || {}).netTotal || 0);
  const gross = parseFloat(invoice.invoice_total || 0);
  return net > 0 ? d.sec.netTotal * (gross / net) : gross * 0;
}

const STATUS_COLORS = { paid: BRAND_GREEN, partial: BRAND_ORANGE, unpaid: 'D14343', voided: MUTED };

// Letterhead: logo + company block on the left, document title block on the right.
function letterhead(branding, { title, number, lines = [], status }) {
  const left = [];
  if (branding.logo) {
    const h = 56;
    const w = Math.round((branding.logo.width / branding.logo.height) * h);
    left.push(new Paragraph({ children: [new ImageRun({ type: 'png', data: branding.logo.png, transformation: { width: Math.min(w, 220), height: h } })], spacing: { after: 80 } }));
  }
  left.push(new Paragraph({ children: [new TextRun({ text: branding.name, bold: true, size: 30, color: INK })] }));
  left.push(new Paragraph({ children: [new TextRun({ text: branding.tagline, size: 17, color: BRAND_GREEN })] }));
  for (const line of branding.contact) left.push(new Paragraph({ children: [new TextRun({ text: line, size: 16, color: MUTED })] }));

  const right = [
    new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: title.toUpperCase(), bold: true, size: 40, color: BRAND_GREEN, characterSpacing: 60 })] }),
    new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: number, bold: true, size: 22, color: INK })], spacing: { after: 60 } }),
    ...lines.map((l) => new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: l, size: 17, color: MUTED })] })),
  ];
  if (status) {
    right.push(new Paragraph({
      alignment: AlignmentType.RIGHT, spacing: { before: 80 },
      children: [new TextRun({ text: ` ${status.toUpperCase()} `, bold: true, size: 18, color: 'FFFFFF', shading: { type: ShadingType.CLEAR, fill: STATUS_COLORS[status] || MUTED } })],
    }));
  }
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE }, borders: NO_BORDERS,
      rows: [new TableRow({ children: [
        new TableCell({ width: { size: 55, type: WidthType.PERCENTAGE }, borders: NO_BORDERS, verticalAlign: VerticalAlign.TOP, children: left }),
        new TableCell({ width: { size: 45, type: WidthType.PERCENTAGE }, borders: NO_BORDERS, verticalAlign: VerticalAlign.TOP, children: right }),
      ] })],
    }),
    new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: BRAND_GREEN } }, spacing: { before: 160, after: 0 } }),
    new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: BRAND_ORANGE } }, spacing: { after: 240 } }),
  ];
}

function footer(branding, text) {
  return [
    new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER } }, spacing: { before: 400, after: 120 } }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${branding.name} · ${branding.tagline}`, bold: true, size: 16, color: BRAND_GREEN })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, size: 15, color: MUTED, italics: true })] }),
  ];
}

// Customer details for the "Bill To" block: phone, door and the
// Group › District › Zone › Sub Zone path. Optional — documents still
// render if the lookup fails.
async function customerContext(customerId) {
  if (!customerId) return null;
  try {
    const r = await pool.query(
      `SELECT c.phone, c.door_number, c.address_line, z.name AS district, g.name AS group_name, g.code AS group_code,
              gz.name AS zone_name, gz.code AS zone_code, r.name AS route_name, r.code AS route_code
         FROM customers c
         LEFT JOIN zones z ON z.id = c.zone_id
         LEFT JOIN groups g ON g.id = c.group_id
         LEFT JOIN routes r ON r.id = c.route_id
         LEFT JOIN group_zones gz ON gz.id = r.group_zone_id
        WHERE c.id = $1`, [customerId]);
    const row = r.rows[0];
    if (!row) return null;
    const pathParts = [row.group_name || row.group_code, row.district, row.zone_name || row.zone_code, row.route_name || row.route_code].filter(Boolean);
    return { phone: row.phone, door: row.door_number, address: row.address_line, path: pathParts.join(' › ') };
  } catch {
    return null;
  }
}

const GRID_BORDERS = { top: NONE, left: NONE, right: NONE, bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, insideVertical: NONE };
function gridTable(headers, rows, widths) {
  const w = (i) => widths[i] ?? Math.floor(100 / headers.length);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE }, borders: GRID_BORDERS,
    rows: [
      new TableRow({ children: headers.map((h, i) => cell(h, { bold: true, shaded: true, color: MUTED, width: w(i), align: i === 0 ? AlignmentType.LEFT : AlignmentType.RIGHT })) }),
      ...rows.map((r) => new TableRow({ children: r.map((v, i) => (v && typeof v === 'object' && v.text !== undefined
        ? cell(v.text, { width: w(i), bold: !!v.bold, color: v.color || INK, align: i === 0 ? AlignmentType.LEFT : AlignmentType.RIGHT })
        : cell(v, { width: w(i), align: i === 0 ? AlignmentType.LEFT : AlignmentType.RIGHT }))) })),
    ],
  });
}
const METHOD_LABEL = { cash: 'Cash (counted)', zaad: 'ZAAD', edahab: 'eDahab' };
const diffText = (d, cur) => (d === null || d === undefined ? '—' : d === 0 ? 'Exact' : `${d > 0 ? '+' : '−'}${money(Math.abs(d), cur)}`);
const diffColor = (d) => (d > 0 ? '2563A8' : d < 0 ? 'C0392B' : INK);

// Cashout V2 sections: per-currency / per-method breakdown, cash count,
// electronic transaction codes, deposits. Each renders only when its data
// exists, so a legacy cashout's document looks exactly as before plus a
// short "expected per currency" table.
function cashoutV2Sections(cashout, extras) {
  const out = [];
  const b = cashout.breakdown;
  if (b && b.currencies) {
    out.push(sectionTitle('Per-currency reconciliation'));
    for (const cur of ['USD', 'SLSH']) {
      const lines = b.currencies[cur];
      const rows = ['cash', 'zaad', 'edahab'].filter((m) => lines[m].expected || lines[m].actual).map((m) => [
        METHOD_LABEL[m], money(lines[m].expected, cur), lines[m].actual === null ? '—' : money(lines[m].actual, cur),
        { text: diffText(lines[m].diff, cur), color: diffColor(lines[m].diff), bold: !!lines[m].diff },
      ]);
      if (!rows.length) continue;
      const tot = b.totals[cur];
      rows.push([{ text: `Total ${cur}`, bold: true }, { text: money(tot.expected, cur), bold: true }, { text: tot.actual === null ? '—' : money(tot.actual, cur), bold: true }, { text: diffText(tot.diff, cur), bold: true, color: diffColor(tot.diff) }]);
      out.push(new Paragraph({ children: [new TextRun({ text: cur, bold: true, color: BRAND_GREEN })], spacing: { before: 100, after: 60 } }));
      out.push(gridTable(['Method', 'Expected', 'Actual', 'Difference'], rows, [40, 20, 20, 20]));
    }
    if (b.debt && b.debt.count > 0) {
      out.push(new Paragraph({ spacing: { before: 80 }, children: [new TextRun({ text: `Debt-marked payments (no money received): ${b.debt.count} · ${[b.debt.USD ? money(b.debt.USD, 'USD') : null, b.debt.SLSH ? money(b.debt.SLSH, 'SLSH') : null].filter(Boolean).join(' + ')}`, size: 17, color: MUTED, italics: true })] }));
    }
    if (b.control) {
      out.push(new Paragraph({ spacing: { before: 80 }, children: [new TextRun({ text: `Result: ${String(b.control.status).toUpperCase()} · tolerance ${money(b.control.tolerance_usd)} · admin threshold ${money(b.control.admin_threshold_usd)}${cashout.needs_admin ? ' · REQUIRES ADMIN APPROVAL' : ''}`, size: 17, bold: true, color: cashout.needs_admin ? 'C0392B' : INK })] }));
    }
    if (b.rate) out.push(new Paragraph({ children: [new TextRun({ text: `Exchange rate used for the SLSH difference: 1 USD = ${Number(b.rate).toLocaleString('en-US')} SLSH`, size: 16, color: MUTED, italics: true })] }));
  }
  const cd = cashout.count_detail;
  if (cd) {
    out.push(sectionTitle('Cash count'));
    for (const cur of ['USD', 'SLSH']) {
      const e = cd[cur];
      if (!e) continue;
      if (e.mode === 'manual') {
        out.push(new Paragraph({ children: [new TextRun({ text: `${cur}: ${money(e.total, cur)} entered manually — `, bold: true }), new TextRun({ text: e.remark || '' })] }));
        continue;
      }
      const notes = Object.entries(e.notes || {}).sort((a, b2) => Number(b2[0]) - Number(a[0]));
      if (!notes.length) { out.push(new Paragraph({ children: [new TextRun({ text: `${cur}: no notes counted`, color: MUTED, italics: true })] })); continue; }
      out.push(gridTable([`${cur} note`, 'Count', 'Subtotal'],
        [...notes.map(([d, n]) => [money(Number(d), cur), String(n), money(Number(d) * n, cur)]), [{ text: `Total ${cur}`, bold: true }, '', { text: money(e.total, cur), bold: true }]],
        [40, 25, 35]));
    }
  }
  const el = extras.electronic || [];
  if (el.length) {
    out.push(sectionTitle('Electronic payments'));
    out.push(gridTable(['Transaction / reference', 'Method', 'Verified by', 'Amount'],
      el.map((p) => [p.reference_code || '—', String(p.method).toUpperCase(), p.gateway_verified ? 'ZAAD gateway' : 'Statement (head)', money(p.amount, p.currency)]), [36, 16, 24, 24]));
  }
  if (cashout.status === 'approved') {
    out.push(sectionTitle('Deposit'));
    const req = extras.deposit_required || { USD: 0, SLSH: 0 };
    const dep = extras.deposited || { USD: 0, SLSH: 0 };
    out.push(kvTable([
      ['Cash to deposit', [req.USD ? money(req.USD, 'USD') : null, req.SLSH ? money(req.SLSH, 'SLSH') : null].filter(Boolean).join(' + ') || '—'],
      ['Deposited', [dep.USD ? money(dep.USD, 'USD') : null, dep.SLSH ? money(dep.SLSH, 'SLSH') : null].filter(Boolean).join(' + ') || '—'],
      ['Deposit status', String(extras.deposit_status || '—').replace(/_/g, ' ').toUpperCase()], ['Deposits', String((extras.deposits || []).filter((d) => !d.voided_at).length)],
    ]));
    const live = (extras.deposits || []).filter((d) => !d.voided_at);
    if (live.length) {
      out.push(new Paragraph({ spacing: { after: 60 } }));
      out.push(gridTable(['Account', 'Date', 'Amount', 'Verified'],
        live.map((d) => [d.account_name, fmtDate(d.deposited_at), money(d.amount, d.currency), d.verified_at ? `${d.verified_by_name || d.verified_by_username || ''} ${fmtDate(d.verified_at)}`.trim() : 'Not yet']), [34, 20, 22, 24]));
    }
  }
  return out;
}

async function buildCashoutDocx(cashout, recon, shortage = null, extras = {}) {
  const branding = await getCompanyBranding();
  const children = [
    ...letterhead(branding, {
      title: 'Cashout',
      number: cashout.cashout_number,
      lines: [
        cashout.zone_name,
        `${fmtDate(cashout.period_start)} – ${fmtDate(cashout.period_end)}`,
        `Prepared ${new Date(cashout.created_at).toLocaleString()}`,
      ],
    }),
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
    // explicitly NOT rendered as a "Customer Debt". Only shown when a
    // shortage record actually exists.
    ...(shortage ? [
      new Paragraph({ children: [new TextRun({ text: 'Cashier Shortage', bold: true, color: BRAND_GREEN })], spacing: { before: 140, after: 60 } }),
      kvTable([
        ['Shortage Amount', money(shortage.shortage_amount)], ['Cashier Responsible', cashout.cashier_name || `#${shortage.cashier_id}`],
        ['Status', shortage.status.toUpperCase()], ['Resolved Amount', shortage.resolved_amount != null ? money(shortage.resolved_amount) : '—'],
      ]),
      new Paragraph({ children: [new TextRun({ text: 'Shortage reason: ', bold: true }), new TextRun({ text: shortage.reason })], spacing: { before: 80 } }),
      ...(shortage.resolution_notes ? [new Paragraph({ children: [new TextRun({ text: 'Resolution notes: ', bold: true }), new TextRun({ text: shortage.resolution_notes })] })] : []),
    ] : []),
    ...(cashout.remarks ? [new Paragraph({ children: [new TextRun({ text: 'Remarks: ', bold: true }), new TextRun({ text: cashout.remarks })] })] : []),
    ...cashoutV2Sections(cashout, extras),
    sectionTitle('Accountability'),
    // Names come from the route's joins; fall back to the id only if a
    // user account was since deleted, never silently blank.
    kvTable([
      ['Cashier', cashout.cashier_name || `#${cashout.cashier_id}`],
      ['Head of Cashiers', cashout.head_of_cashiers_name || `#${cashout.head_of_cashiers_id}`],
      ['Prepared by', cashout.created_by_name || `#${cashout.created_by}`],
      ['Approved by', cashout.approved_by ? (cashout.approved_by_name || `#${cashout.approved_by}`) : 'Not yet approved'],
    ]),
    sectionTitle('Signatures'),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE }, borders: NO_BORDERS,
      rows: [new TableRow({ children: [
        signatureCell('Cashier Signature'), signatureCell('Head of Cashiers Signature'), signatureCell('Collector Acknowledgement'),
      ] })],
    }),
    ...footer(branding, `System-generated cashout document · ${cashout.cashout_number}`),
  ];
  const doc = new Document({ styles: DOC_STYLES, sections: [{ properties: PAGE, children }] });
  return Packer.toBuffer(doc);
}

function signatureCell(label) {
  return new TableCell({
    width: { size: 33, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    margins: { top: 500, bottom: 100, left: 120, right: 120 },
    children: [
      new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: INK } }, spacing: { after: 60 } }),
      new Paragraph({ children: [new TextRun({ text: label, size: 16, color: MUTED })] }),
    ],
  });
}

function invoiceFigures(invoice) {
  const balance = invoice.balance || {};
  const total = parseFloat(invoice.invoice_total || 0);
  const discount = parseFloat(invoice.discount_amount || 0);
  return { total, discount, paid: parseFloat(balance.paid || 0), outstanding: parseFloat(balance.outstanding ?? (total - discount)) };
}

async function buildInvoiceDocx(invoice) {
  const branding = await getCompanyBranding();
  const ctx = await customerContext(invoice.customer_id);
  const cur = invoice.currency || 'USD';
  const f = invoiceFigures(invoice);

  const billTo = [
    new Paragraph({ children: [new TextRun({ text: 'BILL TO', bold: true, size: 16, color: MUTED, characterSpacing: 40 })], spacing: { after: 60 } }),
    new Paragraph({ children: [new TextRun({ text: invoice.customer_name || '—', bold: true, size: 26, color: INK })] }),
    new Paragraph({ children: [new TextRun({ text: `Customer # ${invoice.customer_number}`, size: 19, color: BRAND_GREEN, bold: true })] }),
    ...(ctx?.phone ? [new Paragraph({ children: [new TextRun({ text: ctx.phone, size: 18, color: MUTED })] })] : []),
    ...(ctx?.path ? [new Paragraph({ children: [new TextRun({ text: ctx.path, size: 18, color: MUTED })] })] : []),
    ...(ctx?.door ? [new Paragraph({ children: [new TextRun({ text: `Door # ${ctx.door}`, size: 18, color: MUTED })] })] : []),
  ];
  const dual = dualInfo(invoice);
  const dueBox = [
    new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'AMOUNT DUE', bold: true, size: 16, color: MUTED, characterSpacing: 40 })] }),
    new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: money(f.outstanding, cur), bold: true, size: 44, color: f.outstanding > 0 ? BRAND_GREEN : MUTED })] }),
    ...(dual ? [
      new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `≈ ${money(dual.sec.outstanding, dual.other)}`, bold: true, size: 22, color: MUTED })] }),
      new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `Exchange rate: ${dual.rateText}`, size: 15, color: MUTED })] }),
    ] : []),
    new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: invoice.status === 'paid' ? 'Paid in full' : 'Balance outstanding', size: 16, color: MUTED })] }),
  ];

  const approx = (v) => (dual ? `≈ ${money(v, dual.other)}` : null);
  const lineRows = [
    [serviceDescription(invoice), money(f.total, cur), dual ? approx(secondaryTotal(invoice, dual)) : null],
    ...(f.discount > 0 ? [['Discount', `− ${money(f.discount, cur)}`, null]] : []),
    ['Paid to date', `− ${money(f.paid, cur)}`, dual ? approx(dual.sec.paid) : null],
  ];
  const workedDays = Array.isArray(invoice.worked_days) ? invoice.worked_days : null;

  const children = [
    ...letterhead(branding, {
      title: 'Invoice',
      number: invoice.invoice_number,
      lines: [`Issued ${fmtDate(invoice.created_at)}`],
      status: invoice.status,
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE }, borders: NO_BORDERS,
      rows: [new TableRow({ children: [
        new TableCell({ width: { size: 60, type: WidthType.PERCENTAGE }, borders: NO_BORDERS, children: billTo }),
        new TableCell({ width: { size: 40, type: WidthType.PERCENTAGE }, borders: NO_BORDERS, shading: { type: ShadingType.CLEAR, fill: SOFT }, margins: { top: 160, bottom: 160, left: 200, right: 200 }, verticalAlign: VerticalAlign.CENTER, children: dueBox }),
      ] })],
    }),
    sectionTitle('Details'),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: NONE, left: NONE, right: NONE, bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, insideVertical: NONE },
      rows: [
        new TableRow({ children: [cell('Description', { bold: true, width: 70, shaded: true, color: MUTED }), cell('Amount', { bold: true, width: 30, shaded: true, color: MUTED, align: AlignmentType.RIGHT })] }),
        ...lineRows.map(([d, a, sb]) => new TableRow({ children: [cell(d, { width: 70 }), cell(a, { width: 30, align: AlignmentType.RIGHT, sub: sb })] })),
        new TableRow({ children: [cell('Balance due', { bold: true, width: 70 }), cell(money(f.outstanding, cur), { bold: true, width: 30, align: AlignmentType.RIGHT, color: BRAND_GREEN, sub: dual ? approx(dual.sec.outstanding) : null })] }),
      ],
    }),
    ...(dual ? [new Paragraph({ spacing: { before: 60 }, children: [new TextRun({ text: `Exchange rate: ${dual.rateText}`, size: 16, color: MUTED, italics: true })] })] : []),
    ...(workedDays ? [
      sectionTitle('Service days'),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: NONE, left: NONE, right: NONE, bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, insideVertical: NONE },
        rows: [
          new TableRow({ children: [cell('Week', { bold: true, width: 25, shaded: true, color: MUTED }), cell('Dates', { bold: true, width: 75, shaded: true, color: MUTED })] }),
          ...workedDays.map((wk) => new TableRow({ children: [cell(`Week ${wk.week} (${wk.range})`, { width: 25 }), cell(wk.dates.length ? wk.dates.map(dayLabel).join(', ') : '—', { width: 75 })] })),
        ],
      }),
    ] : []),
    sectionTitle('Payment History'),
    ...(!invoice.payments || invoice.payments.length === 0
      ? [new Paragraph({ children: [new TextRun({ text: 'No payments recorded yet.', italics: true, color: MUTED, size: 18 })] })]
      : [new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: { top: NONE, left: NONE, right: NONE, bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: BORDER }, insideVertical: NONE },
          rows: [
            new TableRow({ children: ['Date', 'Method', 'Amount', 'USD Value', 'Status'].map((h) => cell(h, { bold: true, shaded: true, width: 20, color: MUTED })) }),
            ...invoice.payments.map((p) => new TableRow({ children: [
              cell(fmtDate(p.created_at), { width: 20 }), cell(String(p.method).toUpperCase(), { width: 20 }), cell(money(p.amount, p.currency), { width: 20 }), cell(money(p.amount_usd), { width: 20 }), cell(String(p.status).toUpperCase(), { width: 20 }),
            ] })),
          ],
        })]),
    ...(invoice.status === 'voided' ? [
      sectionTitle('Void Information'),
      new Paragraph({ children: [new TextRun({ text: 'Voided reason: ', bold: true }), new TextRun({ text: invoice.voided_reason || '—' })] }),
      new Paragraph({ children: [new TextRun({ text: 'Voided at: ', bold: true }), new TextRun({ text: new Date(invoice.voided_at).toLocaleString() })] }),
    ] : []),
    new Paragraph({ spacing: { before: 360 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Mahadsanid — Thank you for keeping our city clean.', size: 20, color: INK, bold: true })] }),
    ...footer(branding, `Invoice ${invoice.invoice_number} · Generated ${fmtDate(new Date())}`),
  ];
  const doc = new Document({ styles: DOC_STYLES, sections: [{ properties: PAGE, children }] });
  return Packer.toBuffer(doc);
}

// HTML twin of the invoice for the Customer Portal preview — same layout
// as the .docx. Every interpolated value is escaped: customer name/notes
// can carry arbitrary text.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function buildInvoiceHtml(invoice) {
  const branding = await getCompanyBranding();
  const ctx = await customerContext(invoice.customer_id);
  const cur = invoice.currency || 'USD';
  const f = invoiceFigures(invoice);
  const dual = dualInfo(invoice);
  const status = String(invoice.status || '');
  const sub = (v) => (dual ? `<div class="sub">≈ ${escapeHtml(money(v, dual.other))}</div>` : '');
  const workedDays = Array.isArray(invoice.worked_days) ? invoice.worked_days : null;
  const daysHtml = workedDays ? `<h2>Service days</h2><div class="scroll"><table><thead><tr><th>Week</th><th>Dates</th></tr></thead><tbody>${
    workedDays.map((wk) => `<tr><td>Week ${wk.week} (${escapeHtml(wk.range)})</td><td>${wk.dates.length ? escapeHtml(wk.dates.map(dayLabel).join(', ')) : '—'}</td></tr>`).join('')}</tbody></table></div>` : '';
  const logo = branding.logo ? `<img class="logo" alt="" src="data:image/png;base64,${branding.logo.png.toString('base64')}">` : '';
  const payRows = (invoice.payments || []).map((p) => `
      <tr><td>${escapeHtml(fmtDate(p.created_at))}</td><td>${escapeHtml(String(p.method).toUpperCase())}</td>
      <td class="num">${escapeHtml(money(p.amount, p.currency))}</td><td class="num">${escapeHtml(money(p.amount_usd))}</td>
      <td>${escapeHtml(String(p.status).toUpperCase())}</td></tr>`).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(invoice.invoice_number)}</title>
<style>
  /* Explicit light scheme + background: some browsers auto-darken an
     iframe's default white background while leaving our dark text alone. */
  :root { color-scheme: light; --green: #${BRAND_GREEN}; --orange: #${BRAND_ORANGE}; --ink: #${INK}; --muted: #${MUTED}; --line: #${BORDER}; --soft: #${SOFT}; }
  html, body { background: #ffffff; margin: 0; }
  body { font-family: "Segoe UI", -apple-system, Roboto, Arial, sans-serif; color: var(--ink); font-size: 14px; }
  .sheet { max-width: 760px; margin: 0 auto; padding: 32px 28px 24px; }
  .top { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
  .logo { height: 56px; width: auto; display: block; margin-bottom: 8px; }
  .co-name { font-size: 20px; font-weight: 800; }
  .tagline { color: var(--green); font-size: 13px; }
  .contact { color: var(--muted); font-size: 12px; }
  .doc { text-align: right; }
  .doc h1 { margin: 0; color: var(--green); font-size: 30px; letter-spacing: .12em; }
  .doc .no { font-weight: 700; font-size: 15px; }
  .doc .date { color: var(--muted); font-size: 12px; }
  .badge { display: inline-block; margin-top: 8px; padding: 3px 10px; border-radius: 999px; color: #fff; font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
  .badge.paid { background: var(--green); } .badge.partial { background: var(--orange); } .badge.unpaid { background: #D14343; } .badge.voided { background: var(--muted); }
  .rule { height: 4px; background: var(--green); margin: 20px 0 2px; border-radius: 2px; }
  .rule2 { height: 2px; background: var(--orange); margin-bottom: 24px; border-radius: 2px; }
  .billing { display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; align-items: stretch; }
  .label { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 6px; }
  .cust { font-size: 18px; font-weight: 800; }
  .custno { color: var(--green); font-weight: 700; }
  .small { color: var(--muted); font-size: 13px; }
  .due { background: var(--soft); border-radius: 12px; padding: 16px 20px; text-align: right; min-width: 200px; }
  .due .amt { font-size: 28px; font-weight: 800; color: var(--green); font-variant-numeric: tabular-nums; }
  h2 { color: var(--green); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; margin: 28px 0 8px; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); }
  th { background: var(--soft); color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .due .sec { font-size: 16px; font-weight: 700; color: var(--muted); font-variant-numeric: tabular-nums; }
  .due .rate { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .sub { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  tr.total td { font-weight: 800; color: var(--green); border-bottom: none; }
  .empty { color: var(--muted); font-style: italic; }
  .thanks { text-align: center; font-weight: 700; margin-top: 32px; }
  .foot { text-align: center; color: var(--muted); font-size: 11px; border-top: 1px solid var(--line); margin-top: 16px; padding-top: 10px; }
  .foot b { color: var(--green); }
</style></head>
<body><div class="sheet">
  <div class="top">
    <div>${logo}
      <div class="co-name">${escapeHtml(branding.name)}</div>
      <div class="tagline">${escapeHtml(branding.tagline)}</div>
      ${branding.contact.map((l) => `<div class="contact">${escapeHtml(l)}</div>`).join('')}
    </div>
    <div class="doc">
      <h1>INVOICE</h1>
      <div class="no">${escapeHtml(invoice.invoice_number)}</div>
      <div class="date">Issued ${escapeHtml(fmtDate(invoice.created_at))}</div>
      <span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>
    </div>
  </div>
  <div class="rule"></div><div class="rule2"></div>
  <div class="billing">
    <div>
      <div class="label">Bill to</div>
      <div class="cust">${escapeHtml(invoice.customer_name)}</div>
      <div class="custno">Customer # ${escapeHtml(invoice.customer_number)}</div>
      ${ctx?.phone ? `<div class="small">${escapeHtml(ctx.phone)}</div>` : ''}
      ${ctx?.path ? `<div class="small">${escapeHtml(ctx.path)}</div>` : ''}
      ${ctx?.door ? `<div class="small">Door # ${escapeHtml(ctx.door)}</div>` : ''}
    </div>
    <div class="due"><div class="label">Amount due</div><div class="amt">${escapeHtml(money(f.outstanding, cur))}</div>${dual ? `<div class="sec">≈ ${escapeHtml(money(dual.sec.outstanding, dual.other))}</div><div class="rate">Exchange rate: ${escapeHtml(dual.rateText)}</div>` : ''}<div class="small">${status === 'paid' ? 'Paid in full' : 'Balance outstanding'}</div></div>
  </div>
  <h2>Details</h2>
  <div class="scroll"><table>
    <thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
    <tbody>
      <tr><td>${escapeHtml(serviceDescription(invoice))}</td><td class="num">${escapeHtml(money(f.total, cur))}${dual ? sub(secondaryTotal(invoice, dual)) : ''}</td></tr>
      ${f.discount > 0 ? `<tr><td>Discount</td><td class="num">− ${escapeHtml(money(f.discount, cur))}</td></tr>` : ''}
      <tr><td>Paid to date</td><td class="num">− ${escapeHtml(money(f.paid, cur))}${dual ? sub(dual.sec.paid) : ''}</td></tr>
      <tr class="total"><td>Balance due</td><td class="num">${escapeHtml(money(f.outstanding, cur))}${dual ? sub(dual.sec.outstanding) : ''}</td></tr>
    </tbody>
  </table></div>
  ${dual ? `<p class="small" style="margin:6px 0 0">Exchange rate: ${escapeHtml(dual.rateText)}</p>` : ''}
  ${daysHtml}
  <h2>Payment history</h2>
  ${payRows ? `<div class="scroll"><table><thead><tr><th>Date</th><th>Method</th><th class="num">Amount</th><th class="num">USD value</th><th>Status</th></tr></thead><tbody>${payRows}</tbody></table></div>` : '<p class="empty">No payments recorded yet.</p>'}
  ${status === 'voided' ? `<h2>Void information</h2><p>${escapeHtml(invoice.voided_reason || '—')}</p>` : ''}
  <div class="thanks">Mahadsanid — Thank you for keeping our city clean.</div>
  <div class="foot"><b>${escapeHtml(branding.name)}</b> · ${escapeHtml(branding.tagline)} · Invoice ${escapeHtml(invoice.invoice_number)}</div>
</div></body></html>`;
}

module.exports = { buildCashoutDocx, buildInvoiceDocx, buildInvoiceHtml, customerContext };
