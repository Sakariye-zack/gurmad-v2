const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { pool } = require('../db');

// Company letterhead data for every generated document (invoice, cashout,
// portal preview): name, contact lines and the uploaded logo, trimmed of
// its padding and flattened onto white so it prints cleanly on paper.

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'settings');
const DEFAULT_NAME = 'GURMAD';

// Logos are often a wordmark floating in a large padded square. Trim the
// uniform border (colour sampled from the logo's own corner); callers add
// back whatever margin they want.
async function trimmedLogo(filePath) {
  const flat = await sharp(filePath).flatten({ background: { r: 255, g: 255, b: 255 } }).toBuffer();
  const corner = await sharp(flat).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  const bg = { r: corner[0], g: corner[1], b: corner[2], alpha: 1 };
  const trimmed = await sharp(flat).trim({ background: bg, threshold: 40 }).toBuffer();
  return { buffer: trimmed, bg };
}

const logoCache = new Map(); // storage path -> { png, width, height }

async function documentLogo(storagePath) {
  if (!storagePath) return null;
  if (logoCache.has(storagePath)) return logoCache.get(storagePath);
  const filePath = path.join(UPLOAD_DIR, storagePath);
  if (!fs.existsSync(filePath)) return null;
  const { buffer } = await trimmedLogo(filePath);
  // Recolour the sampled background to pure white so the logo sits on the
  // page instead of on a tinted rectangle.
  const png = await sharp(buffer)
    .resize({ width: 600, withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
  const meta = await sharp(png).metadata();
  const logo = { png, width: meta.width, height: meta.height };
  if (logoCache.size > 5) logoCache.clear();
  logoCache.set(storagePath, logo);
  return logo;
}

// Never blocks document generation: any failure falls back to the name only.
async function getCompanyBranding() {
  try {
    const r = await pool.query('SELECT company_name, logo_storage_path, address, phone, email FROM company_settings WHERE id = 1');
    const row = r.rows[0] || {};
    let logo = null;
    try { logo = await documentLogo(row.logo_storage_path); } catch { logo = null; }
    return {
      name: row.company_name || DEFAULT_NAME,
      tagline: 'Shirkadda Nadaafadda',
      contact: [row.address, row.phone, row.email].filter(Boolean),
      logo,
    };
  } catch {
    return { name: DEFAULT_NAME, tagline: 'Shirkadda Nadaafadda', contact: [], logo: null };
  }
}

module.exports = { getCompanyBranding, trimmedLogo, UPLOAD_DIR };
