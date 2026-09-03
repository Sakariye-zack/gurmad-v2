require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { runMigrations } = require('./db');
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

const app = express();
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

app.get('/api/v2/health', (req, res) => res.json({ ok: true, service: 'gurmad-v2-server' }));
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
  res.status(500).json({ error: { message: 'Unexpected server error.', code: 'INTERNAL' } });
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
