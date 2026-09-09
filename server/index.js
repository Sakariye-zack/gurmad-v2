require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { pool, runMigrations } = require('./db');
const logger = require('./lib/logger');
const zonesRouter = require('./routes/zones');
const customersRouter = require('./routes/customers');
const employeesRouter = require('./routes/employees');
const trucksRouter = require('./routes/trucks');
const cyclesRouter = require('./routes/cycles');
const batchesRouter = require('./routes/batches');
const invoicesRouter = require('./routes/invoices');
const paymentsRouter = require('./routes/payments');
const debtsRouter = require('./routes/debts');
const exchangeRatesRouter = require('./routes/exchangeRates');
const cashoutsRouter = require('./routes/cashouts');
const reportsRouter = require('./routes/reports');
const dashboardRouter = require('./routes/dashboard');
const customerPortalRouter = require('./routes/customerPortal');
const complaintsRouter = require('./routes/complaints');
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
// Group & Group-Based Collection — Change Request. Additive routers only —
// zero change to any existing router's mount line below.
const groupsRouter = require('./routes/groups');
const routesEntityRouter = require('./routes/routesEntity');
// Audit & Security Center — additive router, read-only over the existing
// v2_audit_log. Admin-only (enforced inside the router itself).
const auditRouter = require('./routes/audit');
// System Settings — additive router, Admin-only Company Settings.
const settingsRouter = require('./routes/settings');
// Offline/Sync — Wave 1. Additive router: assignments read + sync-submission
// write, reusing the canonical applyBatchCustomerStatusChange (commit 8e9ac5a).
const collectionSyncRouter = require('./routes/collectionSync');
// Staff Notifications — additive router. In-app only, trigger-created
// (task_resource.assign/remove, batch.cancel in routes/batches.js),
// recipient-scoped read/mark-read API.
const staffNotificationsRouter = require('./routes/staffNotifications');
// Operational Calendar — read-only projection of batches.start_date/end_date.
const calendarRouter = require('./routes/calendar');
// Route & GIS / Map — read-only projection of customers.lat/lng plus
// Group/Route membership. Never joins batch_customers (collection-event
// GPS remains a hard, out-of-band privacy boundary).
const mapRouter = require('./routes/map');
// Master Functional Completion Program — Phase 1: HR & Payroll.
const attendanceRouter = require('./routes/attendance');
const leaveTypesRouter = require('./routes/leaveTypes');
const leaveRequestsRouter = require('./routes/leaveRequests');
const payrollPeriodsRouter = require('./routes/payrollPeriods');
const payrollRecordsRouter = require('./routes/payrollRecords');
const hrReportsRouter = require('./routes/hrReports');
// Master Functional Completion Program — Phase 2: Fleet Management.
const fleetRouter = require('./routes/fleet');
// Master Functional Completion Program — Phase 3: Procurement.
const procurementRouter = require('./routes/procurement');
// Master Functional Completion Program — Phase 4: Inventory & Assets.
const inventoryRouter = require('./routes/inventory');

const app = express();

// Production Readiness (T) — O-7/Security Hardening, Implementation Spec
// §5/§9. Standard security-header set (CSP left at helmet's own safe
// default; this is an API-only backend serving JSON, not HTML, so the
// header set matters far more than a page-specific CSP policy would).
// ADDITIVE / CONTRACT-PRESERVING: applies to every route including every
// closed module's own — none of their response bodies, status codes, or
// route logic changes, only response headers gain a small, standard set.
app.use(helmet());

app.use(express.json());

// Same CORS-whitelist pattern as the reference backend (server/index.js) —
// explicit origins only, not open CORS.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// Production Readiness (T) — Security Hardening. General API-wide rate
// limiting, distinct from and IN ADDITION TO the existing per-account
// auth-route limiters (routes/auth.js, routes/customerPortal.js) —
// this one guards every OTHER route (previously entirely unprotected
// against a request flood from one IP). Deliberately generous (300/15min)
// so it never interferes with normal staff/customer use; its purpose is
// abuse/flood protection, not the tight per-account lockout auth already
// has. ADDITIVE — no existing route's own logic changes.
const generalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' } },
});
app.use('/api/v2', generalApiLimiter);

// Production Readiness (T) — Monitoring, Implementation Spec §5. Extends
// the previous liveness-only health check with an actual database-
// connectivity probe — the single most important gap named in every
// prior Gap Review pass on this exact endpoint. Still fast (a trivial
// SELECT 1), still safe to hit frequently from a monitoring tool.
app.get('/api/v2/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.json({ ok: true, service: 'gurmad-v2-server', database: 'connected' });
  } catch (err) {
    logger.error('health_check_db_failure', { message: err.message });
    return res.status(503).json({ ok: false, service: 'gurmad-v2-server', database: 'unreachable' });
  }
});
app.use('/api/v2/zones', zonesRouter);
app.use('/api/v2/customers', customersRouter);
app.use('/api/v2/employees', employeesRouter);
app.use('/api/v2/trucks', trucksRouter);
app.use('/api/v2/cycles', cyclesRouter);
app.use('/api/v2/batches', batchesRouter);
app.use('/api/v2/invoices', invoicesRouter);
app.use('/api/v2/payments', paymentsRouter);
app.use('/api/v2/debts', debtsRouter);
app.use('/api/v2/exchange-rates', exchangeRatesRouter);
app.use('/api/v2/cashouts', cashoutsRouter);
app.use('/api/v2/reports', reportsRouter);
app.use('/api/v2/dashboard', dashboardRouter);
app.use('/api/v2/customer-portal', customerPortalRouter);
app.use('/api/v2/complaints', complaintsRouter);
app.use('/api/v2/auth', authRouter);
app.use('/api/v2/users', usersRouter);
app.use('/api/v2/groups', groupsRouter);
app.use('/api/v2/routes', routesEntityRouter);
app.use('/api/v2/audit', auditRouter);
app.use('/api/v2/settings', settingsRouter);
app.use('/api/v2/collection-sync', collectionSyncRouter);
app.use('/api/v2/staff-notifications', staffNotificationsRouter);
app.use('/api/v2/calendar', calendarRouter);
app.use('/api/v2/map', mapRouter);
app.use('/api/v2/attendance', attendanceRouter);
app.use('/api/v2/leave-types', leaveTypesRouter);
app.use('/api/v2/leave-requests', leaveRequestsRouter);
app.use('/api/v2/payroll-periods', payrollPeriodsRouter);
app.use('/api/v2/payroll-records', payrollRecordsRouter);
app.use('/api/v2/hr-reports', hrReportsRouter);
app.use('/api/v2/fleet', fleetRouter);
app.use('/api/v2/procurement', procurementRouter);
app.use('/api/v2/inventory', inventoryRouter);

// Consistent error fallback for anything that slips past a route's own handling.
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(500).json({ error: { message: 'Not allowed by CORS', code: 'CORS' } });
  }
  // express.json() throws a SyntaxError for a malformed body — that's a
  // client error, not a server failure. Found during Phase 3 Module 1 QA
  // (was surfacing as a 500).
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: { message: 'Malformed JSON in request body.', code: 'VALIDATION' } });
  }
  // Multer's file-size limit throws a MulterError that otherwise falls
  // through to the generic 500 below — a client mistake (file too large),
  // not a server failure, same reasoning as the SyntaxError case above.
  // Found during Phase 5 Complaints QA (oversized attachment upload was
  // surfacing as a 500).
  if (err && err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: { message: 'File exceeds the maximum allowed size (10MB).', code: 'VALIDATION' } });
  }
  // Production Readiness (T) — API-error visibility, Implementation Spec
  // §5. Logs the EVENT (route, status, error message) — never request
  // bodies, headers, or query params, which could carry a password/token/
  // financial payload. This is the ONE place every otherwise-unhandled
  // route error already passes through, so this is the correct, single
  // choke point to add visibility at, not a change to any route's own logic.
  logger.error('unhandled_api_error', { path: req.path, method: req.method, message: err && err.message });
  res.status(500).json({ error: { message: 'Unexpected server error.', code: 'INTERNAL' } });
});

// Production Readiness (T) — Monitoring, Implementation Spec §5 ("critical
// application failures" — previously entirely unhandled, confirmed
// absent anywhere in this codebase). Logs and keeps the process alive for
// a normal request-level rejection; an uncaught synchronous exception is
// a genuinely unknown process state, so this still exits (matching the
// existing JWT_SECRET-missing fail-loud convention) rather than
// continuing to serve requests from a process that may be corrupted.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { message: reason && reason.message ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', { message: err.message });
  process.exit(1);
});

const PORT = process.env.PORT || 5001;

runMigrations()
  .then(() => {
    app.listen(PORT, () => console.log(`gurmad-v2-server listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('FATAL: V2 migrations failed to run.', err);
    process.exit(1);
  });
