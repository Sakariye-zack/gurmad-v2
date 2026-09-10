const { pool } = require('../db');

// Master Functional Completion Program — Phase 6: Import/Export + Master
// Data Governance. This is THE explicit entity allowlist (Implementation
// Specification §4/§29 of Decisions) — a new entity is added by adding
// its own explicit definition here, never by a generic pass-through.
// Field lists below are copied verbatim from each entity's own existing,
// unchanged POST create endpoint (cited per field group) — never guessed.

const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

// ============================================================
// IMPORT entities (exactly 5 — Decisions §3, Spec §16)
// ============================================================

const IMPORT_ENTITIES = {
  zones: {
    table: 'zones',
    canonicalKey: 'zone_code',
    importRoles: ['admin'], // routes/zones.js:121
    zoneScoped: false,
    importFields: [
      { csvColumn: 'name', dbField: 'name', required: true, type: 'string' },
      { csvColumn: 'zone_code', dbField: 'zone_code', required: true, type: 'string' },
      { csvColumn: 'sub_zone', dbField: 'sub_zone', required: false, type: 'string' },
      { csvColumn: 'area', dbField: 'area', required: false, type: 'string' },
      { csvColumn: 'collection_days', dbField: 'collection_days', required: false, type: 'json' },
    ],
    async businessRuleCheck() { return { ok: true }; },
    async insert(client, row, ctx) {
      const dup = await client.query('SELECT id FROM zones WHERE zone_code = $1', [row.zone_code]);
      if (dup.rows.length) return { ok: false, code: 'DUPLICATE_IN_DATABASE', field: 'zone_code', message: `zone_code "${row.zone_code}" already exists.` };
      const r = await client.query(
        `INSERT INTO zones (name, zone_code, sub_zone, area, collection_days, status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`,
        [row.name, row.zone_code, row.sub_zone || null, row.area || null, row.collection_days ? JSON.stringify(row.collection_days) : null]
      );
      return { ok: true, id: r.rows[0].id };
    },
  },

  customers: {
    table: 'customers',
    canonicalKey: null, // customer_number is server-generated — see §Decisions §15, never client-supplied, so there is no client-facing canonical key to validate at layer 4; duplicate detection (layer 5) is not applicable to this entity for the same reason (a fresh sequence number cannot collide)
    importRoles: ['admin', 'gudoomiye'], // routes/customers.js:364
    zoneScoped: true,
    importFields: [
      { csvColumn: 'customer_type', dbField: 'customer_type', required: true, type: 'string' },
      { csvColumn: 'name', dbField: 'name', required: true, type: 'string' },
      { csvColumn: 'business_name', dbField: 'business_name', required: false, type: 'string' },
      { csvColumn: 'phone', dbField: 'phone', required: true, type: 'string' },
      { csvColumn: 'alternate_phone', dbField: 'alternate_phone', required: false, type: 'string' },
      { csvColumn: 'whatsapp', dbField: 'whatsapp', required: false, type: 'string' },
      { csvColumn: 'email', dbField: 'email', required: false, type: 'string' },
      { csvColumn: 'address_line', dbField: 'address_line', required: false, type: 'string' },
      { csvColumn: 'sub_zone', dbField: 'sub_zone', required: false, type: 'string' },
      { csvColumn: 'lat', dbField: 'lat', required: false, type: 'number' },
      { csvColumn: 'lng', dbField: 'lng', required: false, type: 'number' },
      { csvColumn: 'commercial_shift', dbField: 'commercial_shift', required: false, type: 'string' },
      { csvColumn: 'collection_frequency', dbField: 'collection_frequency', required: false, type: 'string' },
      { csvColumn: 'collection_mode', dbField: 'collection_mode', required: false, type: 'string' },
      { csvColumn: 'fee', dbField: 'fee', required: false, type: 'number' },
      // group_code/route_code are lookup values (existing group/route NAME),
      // not raw DB IDs and not new columns — Spec §16.2's explicitly-flagged
      // resolution. Groups/Routes are themselves excluded from import
      // (Decisions §23); this only lets an imported customer REFERENCE an
      // already-existing group/route, exactly as manual creation already can.
      { csvColumn: 'group_code', dbField: 'group_id', required: false, type: 'lookup:groups.name' },
      { csvColumn: 'route_code', dbField: 'route_id', required: false, type: 'lookup:routes.name' },
    ],
    async businessRuleCheck() { return { ok: true }; },
    async resolveGroupRoute(client, row, zoneId) {
      let groupId = null, routeId = null;
      if (row.group_code) {
        const g = await client.query('SELECT id, status FROM groups WHERE name = $1 AND zone_id = $2', [row.group_code, zoneId]);
        if (g.rows.length === 0) return { ok: false, code: 'NOT_FOUND', field: 'group_code', message: `No group named "${row.group_code}" exists in the target zone.` };
        if (g.rows.length > 1) return { ok: false, code: 'AMBIGUOUS_REFERENCE', field: 'group_code', message: `More than one group named "${row.group_code}" exists in the target zone.` };
        if (g.rows[0].status !== 'active') return { ok: false, code: 'INACTIVE_REFERENCE', field: 'group_code', message: `Group "${row.group_code}" is not active.` };
        groupId = g.rows[0].id;
      }
      if (row.route_code) {
        const params = groupId ? [row.route_code, groupId] : [row.route_code];
        const sql = groupId ? 'SELECT id, status FROM routes WHERE name = $1 AND group_id = $2' : 'SELECT id, status FROM routes WHERE name = $1';
        const rt = await client.query(sql, params);
        if (rt.rows.length === 0) return { ok: false, code: 'NOT_FOUND', field: 'route_code', message: `No route named "${row.route_code}" exists${groupId ? ' under the resolved group' : ''}.` };
        if (rt.rows.length > 1) return { ok: false, code: 'AMBIGUOUS_REFERENCE', field: 'route_code', message: `More than one route named "${row.route_code}" matches.` };
        if (rt.rows[0].status !== 'active') return { ok: false, code: 'INACTIVE_REFERENCE', field: 'route_code', message: `Route "${row.route_code}" is not active.` };
        routeId = rt.rows[0].id;
      }
      return { ok: true, groupId, routeId };
    },
    async generateCustomerNumber(client) {
      const seq = await client.query(`SELECT nextval('customer_number_seq') AS n`);
      return `CUST-${String(seq.rows[0].n).padStart(6, '0')}`;
    },
    async insert(client, row, ctx) {
      const gr = await this.resolveGroupRoute(client, row, ctx.zoneId);
      if (!gr.ok) return gr;
      const customerNumber = await this.generateCustomerNumber(client);
      const r = await client.query(
        `INSERT INTO customers (customer_number, customer_type, name, business_name, phone, alternate_phone, whatsapp, email,
           address_line, zone_id, sub_zone, lat, lng, commercial_shift, collection_frequency, collection_mode, fee, registered_by, group_id, route_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
        [customerNumber, row.customer_type, row.name, row.business_name || null, row.phone, row.alternate_phone || null,
         row.whatsapp || null, row.email || null, row.address_line || null, ctx.zoneId, row.sub_zone || null,
         row.lat || null, row.lng || null, row.commercial_shift || null, row.collection_frequency || null,
         row.collection_mode || null, row.fee || null, ctx.actorId, gr.groupId, gr.routeId]
      );
      return { ok: true, id: r.rows[0].id };
    },
  },

  trucks: {
    table: 'trucks',
    canonicalKey: 'plate_number',
    importRoles: ['admin', 'gudoomiye'], // routes/trucks.js:217 WRITE_ROLES
    zoneScoped: true,
    importFields: [
      { csvColumn: 'plate_number', dbField: 'plate_number', required: true, type: 'string' },
      { csvColumn: 'model', dbField: 'model', required: false, type: 'string' },
      { csvColumn: 'capacity', dbField: 'capacity', required: false, type: 'number' },
      { csvColumn: 'driver_employee_id', dbField: 'driver_id', required: false, type: 'fk:employees:driver' },
      { csvColumn: 'collector_employee_id', dbField: 'collector_id', required: false, type: 'fk:employees:collector' },
      { csvColumn: 'insurance_expiry', dbField: 'insurance_expiry', required: false, type: 'date' },
      { csvColumn: 'registration_expiry', dbField: 'registration_expiry', required: false, type: 'date' },
      { csvColumn: 'road_tax_expiry', dbField: 'road_tax_expiry', required: false, type: 'date' },
    ],
    async validateEmployeeRole(client, employeeId, requiredType) {
      if (!employeeId) return { ok: true, id: null };
      const r = await client.query('SELECT id, employee_type, status FROM employees WHERE id = $1', [employeeId]);
      if (r.rows.length === 0) return { ok: false, code: 'NOT_FOUND', message: `No employee with id ${employeeId} exists.` };
      if (r.rows[0].employee_type !== requiredType) return { ok: false, code: 'VALIDATION', message: `Employee #${employeeId} is not employee_type "${requiredType}".` };
      // Decisions §14 — inactive references always rejected. Stricter than
      // the manual-creation endpoint (which has no status check), by
      // explicit import-specific design.
      if (r.rows[0].status !== 'active') return { ok: false, code: 'INACTIVE_REFERENCE', message: `Employee #${employeeId} is not active.` };
      return { ok: true, id: employeeId };
    },
    async businessRuleCheck(client, row) {
      const driver = await this.validateEmployeeRole(client, row.driver_employee_id ? parseInt(row.driver_employee_id, 10) : null, 'driver');
      if (!driver.ok) return { ...driver, field: 'driver_employee_id' };
      const collector = await this.validateEmployeeRole(client, row.collector_employee_id ? parseInt(row.collector_employee_id, 10) : null, 'collector');
      if (!collector.ok) return { ...collector, field: 'collector_employee_id' };
      return { ok: true, driverId: driver.id, collectorId: collector.id };
    },
    async insert(client, row, ctx) {
      const dup = await client.query('SELECT id FROM trucks WHERE plate_number = $1', [row.plate_number]);
      if (dup.rows.length) return { ok: false, code: 'DUPLICATE_IN_DATABASE', field: 'plate_number', message: `plate_number "${row.plate_number}" already exists.` };
      const biz = await this.businessRuleCheck(client, row);
      if (!biz.ok) return biz;
      const r = await client.query(
        `INSERT INTO trucks (plate_number, model, capacity, zone_id, driver_id, collector_id, status, insurance_expiry, registration_expiry, road_tax_expiry)
         VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9) RETURNING id`,
        [row.plate_number, row.model || null, row.capacity || null, ctx.zoneId, biz.driverId, biz.collectorId,
         row.insurance_expiry || null, row.registration_expiry || null, row.road_tax_expiry || null]
      );
      return { ok: true, id: r.rows[0].id };
    },
  },

  'leave-types': {
    table: 'leave_types',
    canonicalKey: 'code',
    importRoles: ['admin'], // routes/leaveTypes.js:20
    zoneScoped: false,
    importFields: [
      { csvColumn: 'code', dbField: 'code', required: true, type: 'string' },
      { csvColumn: 'label', dbField: 'label', required: true, type: 'string' },
      { csvColumn: 'is_paid', dbField: 'is_paid', required: false, type: 'boolean' },
    ],
    async businessRuleCheck() { return { ok: true }; },
    async insert(client, row, ctx) {
      const code = String(row.code).trim().toLowerCase();
      const dup = await client.query('SELECT id FROM leave_types WHERE code = $1', [code]);
      if (dup.rows.length) return { ok: false, code: 'DUPLICATE_IN_DATABASE', field: 'code', message: `Leave type code "${code}" already exists.` };
      const isPaid = row.is_paid === undefined || row.is_paid === '' ? true : ['true', '1', 'yes'].includes(String(row.is_paid).toLowerCase());
      const r = await client.query(`INSERT INTO leave_types (code, label, is_paid) VALUES ($1,$2,$3) RETURNING id`, [code, row.label, isPaid]);
      return { ok: true, id: r.rows[0].id };
    },
  },

  'inventory-items': {
    table: 'inventory_items',
    canonicalKey: 'sku', // mandatory FOR IMPORT ONLY — Decisions §22; global column remains nullable, unchanged
    importRoles: ['admin'], // routes/inventory.js:80 ADMIN_ONLY
    zoneScoped: false,
    importFields: [
      { csvColumn: 'sku', dbField: 'sku', required: true, type: 'string' }, // required for import only
      { csvColumn: 'name', dbField: 'name', required: true, type: 'string' },
      { csvColumn: 'category', dbField: 'category', required: false, type: 'string' },
      { csvColumn: 'unit_of_measure', dbField: 'unit_of_measure', required: true, type: 'string' },
      { csvColumn: 'description', dbField: 'description', required: false, type: 'string' },
      { csvColumn: 'reorder_level', dbField: 'reorder_level', required: false, type: 'number' },
    ],
    async businessRuleCheck(client, row) {
      if (row.reorder_level !== undefined && row.reorder_level !== '' && (isNaN(parseInt(row.reorder_level, 10)) || parseInt(row.reorder_level, 10) < 0)) {
        return { ok: false, code: 'VALIDATION', field: 'reorder_level', message: 'reorder_level must be a non-negative integer.' };
      }
      return { ok: true };
    },
    async insert(client, row, ctx) {
      const dup = await client.query('SELECT id FROM inventory_items WHERE sku = $1', [row.sku]);
      if (dup.rows.length) return { ok: false, code: 'DUPLICATE_IN_DATABASE', field: 'sku', message: `SKU "${row.sku}" already exists.` };
      const biz = await this.businessRuleCheck(client, row);
      if (!biz.ok) return biz;
      const r = await client.query(
        `INSERT INTO inventory_items (sku, name, category, unit_of_measure, description, reorder_level) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [row.sku, row.name, row.category || null, row.unit_of_measure, row.description || null, row.reorder_level ? parseInt(row.reorder_level, 10) : null]
      );
      return { ok: true, id: r.rows[0].id };
    },
  },
};

// ============================================================
// EXPORT entities (11 — Decisions §4, Spec §17)
// ============================================================

const EXPORT_ENTITIES = {
  zones: {
    zoneScoped: false,
    exportRoles: ['admin', 'gudoomiye', 'zone_accountant'],
    columns: [
      { key: 'name', label: 'Name' }, { key: 'zone_code', label: 'Zone Code' }, { key: 'sub_zone', label: 'Sub Zone' },
      { key: 'area', label: 'Area' }, { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Created At' },
    ],
    async query(client, { zoneId, filters }) {
      const params = []; const where = [];
      if (filters.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
      const sql = `SELECT name, zone_code, sub_zone, area, status, created_at FROM zones ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name ASC`;
      return (await client.query(sql, params)).rows;
    },
  },
  customers: {
    zoneScoped: true,
    exportRoles: ['admin', 'gudoomiye', 'zone_accountant'],
    columns: [
      { key: 'customer_number', label: 'Customer Number' }, { key: 'customer_type', label: 'Type' }, { key: 'name', label: 'Name' },
      { key: 'business_name', label: 'Business Name' }, { key: 'phone', label: 'Phone' }, { key: 'alternate_phone', label: 'Alternate Phone' },
      { key: 'whatsapp', label: 'WhatsApp' }, { key: 'email', label: 'Email' }, { key: 'address_line', label: 'Address' },
      { key: 'sub_zone', label: 'Sub Zone' }, { key: 'lat', label: 'Lat' }, { key: 'lng', label: 'Lng' },
      { key: 'commercial_shift', label: 'Commercial Shift' }, { key: 'collection_frequency', label: 'Collection Frequency' },
      { key: 'collection_mode', label: 'Collection Mode' }, { key: 'fee', label: 'Fee' }, { key: 'status', label: 'Status' },
      { key: 'zone_name', label: 'Zone' }, { key: 'group_name', label: 'Group' },
      { key: 'route_name', label: 'Route' }, { key: 'created_at', label: 'Created At' },
    ],
    async query(client, { zoneId, filters }) {
      const params = []; const where = [];
      if (zoneId !== null) { params.push(zoneId); where.push(`c.zone_id = $${params.length}`); }
      if (filters.status) { params.push(filters.status); where.push(`c.status = $${params.length}`); }
      if (filters.customer_type) { params.push(filters.customer_type); where.push(`c.customer_type = $${params.length}`); }
      const sql = `SELECT c.customer_number, c.customer_type, c.name, c.business_name, c.phone, c.alternate_phone, c.whatsapp, c.email,
        c.address_line, c.sub_zone, c.lat, c.lng, c.commercial_shift, c.collection_frequency, c.collection_mode, c.fee, c.status,
        z.name AS zone_name, g.name AS group_name, r.name AS route_name, c.created_at
        FROM customers c LEFT JOIN zones z ON c.zone_id = z.id LEFT JOIN groups g ON c.group_id = g.id LEFT JOIN routes r ON c.route_id = r.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.name ASC`;
      return (await client.query(sql, params)).rows;
    },
  },
  trucks: {
    zoneScoped: true,
    exportRoles: ['admin', 'gudoomiye', 'zone_accountant'],
    columns: [
      { key: 'plate_number', label: 'Plate Number' }, { key: 'model', label: 'Model' }, { key: 'capacity', label: 'Capacity' },
      { key: 'driver_name', label: 'Driver' }, { key: 'collector_name', label: 'Collector' }, { key: 'status', label: 'Status' },
      { key: 'insurance_expiry', label: 'Insurance Expiry' }, { key: 'registration_expiry', label: 'Registration Expiry' },
      { key: 'road_tax_expiry', label: 'Road Tax Expiry' }, { key: 'zone_name', label: 'Zone' }, { key: 'created_at', label: 'Created At' },
    ],
    async query(client, { zoneId, filters }) {
      const params = []; const where = [];
      if (zoneId !== null) { params.push(zoneId); where.push(`t.zone_id = $${params.length}`); }
      if (filters.status) { params.push(filters.status); where.push(`t.status = $${params.length}`); }
      const sql = `SELECT t.plate_number, t.model, t.capacity, d.name AS driver_name, col.name AS collector_name, t.status,
        t.insurance_expiry, t.registration_expiry, t.road_tax_expiry, z.name AS zone_name, t.created_at
        FROM trucks t LEFT JOIN zones z ON t.zone_id = z.id LEFT JOIN employees d ON t.driver_id = d.id LEFT JOIN employees col ON t.collector_id = col.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.plate_number ASC`;
      return (await client.query(sql, params)).rows;
    },
  },
  'leave-types': {
    zoneScoped: false,
    exportRoles: ['admin', 'gudoomiye', 'zone_accountant'],
    columns: [{ key: 'code', label: 'Code' }, { key: 'label', label: 'Label' }, { key: 'is_paid', label: 'Paid' }, { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Created At' }],
    async query(client, { filters }) {
      const params = []; const where = [];
      if (filters.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
      return (await client.query(`SELECT code, label, is_paid, status, created_at FROM leave_types ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY code ASC`, params)).rows;
    },
  },
  'inventory-items': {
    zoneScoped: false,
    exportRoles: ['admin', 'gudoomiye', 'zone_accountant'],
    columns: [
      { key: 'sku', label: 'SKU' }, { key: 'name', label: 'Name' }, { key: 'category', label: 'Category' },
      { key: 'unit_of_measure', label: 'Unit' }, { key: 'description', label: 'Description' }, { key: 'reorder_level', label: 'Reorder Level' },
      { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Created At' },
    ],
    async query(client, { filters }) {
      const params = []; const where = [];
      if (filters.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
      if (filters.category) { params.push(filters.category); where.push(`category = $${params.length}`); }
      return (await client.query(`SELECT sku, name, category, unit_of_measure, description, reorder_level, status, created_at FROM inventory_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name ASC`, params)).rows;
    },
  },
  suppliers: {
    zoneScoped: false,
    exportRoles: ['admin', 'gudoomiye', 'zone_accountant'],
    columns: [
      { key: 'name', label: 'Name' }, { key: 'contact', label: 'Contact' }, { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' }, { key: 'address', label: 'Address' }, { key: 'category', label: 'Category' },
      { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Created At' },
    ],
    async query(client, { filters }) {
      const params = []; const where = [];
      if (filters.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
      return (await client.query(`SELECT name, contact, phone, email, address, category, status, created_at FROM suppliers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name ASC`, params)).rows;
    },
  },
  'inventory-stores': {
    zoneScoped: true,
    exportRoles: ['admin', 'gudoomiye', 'zone_accountant'],
    columns: [{ key: 'name', label: 'Name' }, { key: 'zone_name', label: 'Zone' }, { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Created At' }],
    async query(client, { zoneId, filters }) {
      const params = []; const where = [];
      if (zoneId !== null) { params.push(zoneId); where.push(`s.zone_id = $${params.length}`); }
      if (filters.status) { params.push(filters.status); where.push(`s.status = $${params.length}`); }
      const sql = `SELECT s.name, z.name AS zone_name, s.status, s.created_at FROM inventory_stores s LEFT JOIN zones z ON s.zone_id = z.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.name ASC`;
      return (await client.query(sql, params)).rows;
    },
  },
  employees: {
    zoneScoped: true,
    exportRoles: ['admin', 'gudoomiye', 'zone_accountant'],
    // SENSITIVE_FIELDS excluded VERBATIM (routes/employees.js:35): photo,
    // id_document, guarantor_name, guarantor_phone, notes. `salary` is
    // NOT in that list but is flagged in the Implementation Specification
    // §17 as needing confirmation — included provisionally here per the
    // Specification's own stated conservative default, not silently added.
    columns: [
      { key: 'name', label: 'Name' }, { key: 'job_role', label: 'Job Role' }, { key: 'employee_type', label: 'Employee Type' },
      { key: 'collector_type', label: 'Collector Type' }, { key: 'commercial_shift', label: 'Commercial Shift' }, { key: 'phone', label: 'Phone' },
      { key: 'zone_name', label: 'Zone' }, { key: 'status', label: 'Status' }, { key: 'salary', label: 'Salary' },
      { key: 'join_date', label: 'Join Date' }, { key: 'created_at', label: 'Created At' },
    ],
    async query(client, { zoneId, filters }) {
      const params = []; const where = [];
      if (zoneId !== null) { params.push(zoneId); where.push(`e.zone_id = $${params.length}`); }
      if (filters.status) { params.push(filters.status); where.push(`e.status = $${params.length}`); }
      if (filters.employee_type) { params.push(filters.employee_type); where.push(`e.employee_type = $${params.length}`); }
      const sql = `SELECT e.name, e.job_role, e.employee_type, e.collector_type, e.commercial_shift, e.phone, z.name AS zone_name,
        e.status, e.salary, e.join_date, e.created_at FROM employees e LEFT JOIN zones z ON e.zone_id = z.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.name ASC`;
      return (await client.query(sql, params)).rows;
    },
  },
  groups: {
    zoneScoped: true,
    exportRoles: ['admin', 'gudoomiye', 'zone_accountant'],
    columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'zone_name', label: 'Zone' }, { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Created At' }],
    async query(client, { zoneId, filters }) {
      const params = []; const where = [];
      if (zoneId !== null) { params.push(zoneId); where.push(`g.zone_id = $${params.length}`); }
      if (filters.status) { params.push(filters.status); where.push(`g.status = $${params.length}`); }
      const sql = `SELECT g.code, g.name, z.name AS zone_name, g.status, g.created_at FROM groups g LEFT JOIN zones z ON g.zone_id = z.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.name ASC`;
      return (await client.query(sql, params)).rows;
    },
  },
  routes: {
    zoneScoped: true, // via group -> zone
    exportRoles: ['admin', 'gudoomiye', 'zone_accountant'],
    columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'group_name', label: 'Group' }, { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Created At' }],
    async query(client, { zoneId, filters }) {
      const params = []; const where = [];
      if (zoneId !== null) { params.push(zoneId); where.push(`g.zone_id = $${params.length}`); }
      if (filters.status) { params.push(filters.status); where.push(`r.status = $${params.length}`); }
      if (filters.group_id) { params.push(filters.group_id); where.push(`r.group_id = $${params.length}`); }
      const sql = `SELECT r.code, r.name, g.name AS group_name, r.status, r.created_at FROM routes r LEFT JOIN groups g ON r.group_id = g.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.name ASC`;
      return (await client.query(sql, params)).rows;
    },
  },
  'asset-register': {
    zoneScoped: true,
    exportRoles: ['admin', 'gudoomiye', 'zone_accountant'],
    columns: [
      { key: 'asset_tag', label: 'Asset Tag' }, { key: 'name', label: 'Name' }, { key: 'category', label: 'Category' },
      { key: 'serial_number', label: 'Serial Number' }, { key: 'acquisition_date', label: 'Acquisition Date' },
      { key: 'acquisition_cost', label: 'Acquisition Cost' }, { key: 'condition', label: 'Condition' }, { key: 'status', label: 'Status' },
      { key: 'zone_name', label: 'Zone' }, { key: 'store_location_name', label: 'Store Location' },
      { key: 'assigned_employee_name', label: 'Assigned To' }, { key: 'created_at', label: 'Created At' },
    ],
    async query(client, { zoneId, filters }) {
      const params = []; const where = [];
      if (zoneId !== null) { params.push(zoneId); where.push(`a.zone_id = $${params.length}`); }
      if (filters.status) { params.push(filters.status); where.push(`a.status = $${params.length}`); }
      if (filters.category) { params.push(filters.category); where.push(`a.category = $${params.length}`); }
      const sql = `SELECT a.asset_tag, a.name, a.category, a.serial_number, a.acquisition_date, a.acquisition_cost, a.condition, a.status,
        z.name AS zone_name, s.name AS store_location_name, e.name AS assigned_employee_name, a.created_at
        FROM asset_register a LEFT JOIN zones z ON a.zone_id = z.id LEFT JOIN inventory_stores s ON a.store_location_id = s.id
        LEFT JOIN employees e ON a.assigned_employee_id = e.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.name ASC`;
      return (await client.query(sql, params)).rows;
    },
  },
};

module.exports = { IMPORT_ENTITIES, EXPORT_ENTITIES, resolveUserZoneId, ZONE_SCOPED_ROLES };
