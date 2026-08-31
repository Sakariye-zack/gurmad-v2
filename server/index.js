require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { runMigrations } = require('./db');
const zonesRouter = require('./routes/zones');
const customersRouter = require('./routes/customers');

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
