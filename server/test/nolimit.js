// Preload for the TEST server only: replaces express-rate-limit with a
// pass-through so the suite is never throttled. Never used in production.
const Module = require('module');
const orig = Module._load;
Module._load = function (request) {
  if (request === 'express-rate-limit') return () => (req, res, next) => next();
  return orig.apply(this, arguments);
};
