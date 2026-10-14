const { readFileSync } = require('node:fs');
const { server, body, check, equalToken, bearer } = require('./http');
const { validatePanel, unlock } = require('./adapters');

function createEdge({ token, panels, transport, now = Date.now }) {
  check(token?.length >= 24, 500, 'weak_edge_token');
  Object.values(panels).forEach(validatePanel);
  // shortcut: in-memory deduplication lasts one process; persist before controlling real relays.
  const requests = new Map();
  return server(async req => {
    check(equalToken(bearer(req), token), 401, 'unauthorized');
    check(req.method === 'POST' && req.url === '/unlock', 404, 'not_found');
    const { doorId, requestId } = await body(req);
    check(typeof requestId === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(requestId));
    check(Object.hasOwn(panels, doorId), 404, 'unknown_door');
    for (const [id, entry] of requests) if (entry.until <= now()) requests.delete(id);
    const previous = requests.get(requestId);
    if (previous) { check(previous.doorId === doorId, 409, 'request_id_reused'); return previous.result; }
    check(requests.size < 2000, 503, 'edge_busy');
    const result = unlock(panels[doorId], transport);
    requests.set(requestId, { doorId, result, until: now() + 600000 });
    return result;
  });
}
if (require.main === module) {
  const config = JSON.parse(readFileSync(process.env.INTERCOM_EDGE_CONFIG, 'utf8'));
  for (const panel of Object.values(config.panels)) {
    panel.password = process.env[panel.passwordEnv]; panel.token = process.env[panel.tokenEnv];
  }
  createEdge({ ...config, token: process.env.EDGE_TOKEN }).listen(config.port || 8091, config.host || '127.0.0.1');
}
module.exports = { createEdge };
