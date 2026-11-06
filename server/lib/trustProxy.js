// Account security — opt-in proxy trust. Only when TRUST_PROXY=1 does
// Express derive req.ip from X-Forwarded-For, and then only across
// loopback hops (nginx -> http://localhost:5001). Default OFF: until the
// nginx config overwrites X-Forwarded-For with $remote_addr, a client-sent
// header would otherwise be trusted. Enable only after nginx is updated
// (deploy/nginx_gurmad_v2.conf).
function configureTrustProxy(app, env = process.env) {
  const enabled = env.TRUST_PROXY === '1';
  if (enabled) app.set('trust proxy', 'loopback');
  return enabled;
}

module.exports = { configureTrustProxy };
