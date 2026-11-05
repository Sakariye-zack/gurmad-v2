const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const JSZip = require('jszip');
const { api, db, setupWorld, createInvoice } = require('./helpers');

const LOGO_DIR = path.join(__dirname, '..', 'uploads', 'settings');
const LOGO_FILE = 'test-doc-logo.png';

async function useTestLogo() {
  fs.mkdirSync(LOGO_DIR, { recursive: true });
  // A green bar on a padded off-white square, like the real wordmark.
  const png = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#f4f8f2' } })
    .composite([{ input: await sharp({ create: { width: 300, height: 80, channels: 3, background: '#3DAA35' } }).png().toBuffer(), left: 50, top: 160 }])
    .png().toBuffer();
  fs.writeFileSync(path.join(LOGO_DIR, LOGO_FILE), png);
  await db.query(`INSERT INTO company_settings (id, company_name, logo_storage_path, logo_mime_type, phone)
                  VALUES (1, 'Gurmad Test Co', $1, 'image/png', '063-0000000')
                  ON CONFLICT (id) DO UPDATE SET company_name = EXCLUDED.company_name, logo_storage_path = EXCLUDED.logo_storage_path,
                    logo_mime_type = EXCLUDED.logo_mime_type, phone = EXCLUDED.phone`, [LOGO_FILE]);
}

after(() => { try { fs.unlinkSync(path.join(LOGO_DIR, LOGO_FILE)); } catch (_) { /* already gone */ } });

test('invoice .docx carries the company logo, name and the customer bill-to block', async () => {
  const w = await setupWorld();
  await useTestLogo();
  const inv = await createInvoice(w.tokens.admin, w.custA, 12);
  const res = await fetch(process.env.TEST_BASE + `/api/v2/invoices/${inv.id}/document.docx`, { headers: { Authorization: 'Bearer ' + w.tokens.admin } });
  assert.equal(res.status, 200);
  const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
  const media = Object.keys(zip.files).filter((f) => f.startsWith('word/media/'));
  assert.ok(media.length >= 1, 'logo image embedded');
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /Gurmad Test Co/);
  assert.match(xml, /BILL TO/);
  assert.match(xml, /AMOUNT DUE/);
  assert.ok(xml.includes(w.custA.customer_number || 'C-'), 'customer number shown');
});

test('invoice .docx still renders when no logo is set', async () => {
  const w = await setupWorld();
  await db.query(`UPDATE company_settings SET logo_storage_path = NULL WHERE id = 1`);
  const inv = await createInvoice(w.tokens.admin, w.custA, 7);
  const res = await fetch(process.env.TEST_BASE + `/api/v2/invoices/${inv.id}/document.docx`, { headers: { Authorization: 'Bearer ' + w.tokens.admin } });
  assert.equal(res.status, 200);
  const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
  assert.match(await zip.file('word/document.xml').async('string'), /INVOICE/);
});
