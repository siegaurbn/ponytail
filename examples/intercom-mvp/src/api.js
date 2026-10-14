const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { server, body, check, equalToken, bearer, jsonFetch, HttpError } = require('./http');
const { createPush } = require('./push');

const idPattern = /^[a-zA-Z0-9-]{16,80}$/;
function createApi({ users, doors, internalToken, portalUrl, mediaUrl, mediaAuthorization, edgeUnlock, push, mode = 'integration', audit = () => {}, now = Date.now }) {
  check(internalToken?.length >= 24 && users.every(user => user.token?.length >= 24), 500, 'weak_api_token');
  const mediaBase = new URL(mediaUrl);
  const calls = new Map(), devices = new Map(), requests = new Map(), sessions = new Map(), limits = new Map();
  // shortcut: single-process stores; use transactional storage/outbox before multi-instance deployment.
  function prune() {
    for (const call of calls.values()) if (call.expiresAt <= now() && !['ended', 'expired'].includes(call.state)) call.state = 'expired';
    for (const [id, call] of calls) if (call.expiresAt + 600000 <= now()) calls.delete(id);
    for (const map of [requests, sessions, limits]) for (const [id, value] of map) if (value.until <= now()) map.delete(id);
  }
  function doorFor(user, id) {
    check(user.doors.includes(id) && Object.hasOwn(doors, id), 403, 'door_forbidden');
    return doors[id];
  }
  function callFor(user, id) {
    const call = calls.get(id);
    check(call?.userId === user.id, 404, 'call_not_found');
    doorFor(user, call.doorId);
    return call;
  }
  return server(async (req, res) => {
    prune();
    const url = new URL(req.url, 'http://localhost'), path = url.pathname;
    if (req.method === 'GET' && path === '/health') return { status: 'ok' };
    if (req.method === 'GET' && ['/', '/app.js', '/style.css', '/whep.js'].includes(path)) {
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'");
      res.end(readFileSync(join(__dirname, '../web', path === '/' ? 'index.html' : path.slice(1))));
      return;
    }
    if (path.startsWith('/internal/')) {
      check(equalToken(bearer(req), internalToken), 401, 'unauthorized');
      if (req.method === 'POST' && path === '/internal/calls') {
        const data = await body(req);
        check(typeof data.callId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(data.callId) && typeof data.sipCallId === 'string' && data.sipCallId.length > 0 && data.sipCallId.length <= 256);
        const user = users.find(x => x.id === data.userId);
        check(user, 404, 'unknown_user');
        const door = doorFor(user, data.doorId);
        check(Number.isSafeInteger(data.expiresAt) && data.expiresAt > now() && data.expiresAt <= now() + 90000);
        const previous = calls.get(data.callId);
        if (previous) {
          check(previous.sipCallId === data.sipCallId && previous.userId === user.id && previous.doorId === data.doorId, 409, 'call_id_reused');
          return { call: previous, duplicate: true };
        }
        check(calls.size < 1000, 503, 'calls_busy');
        const call = { id: data.callId, sipCallId: data.sipCallId, userId: user.id, doorId: data.doorId, name: door.name, state: 'ringing', expiresAt: data.expiresAt };
        calls.set(call.id, call);
        const targets = [...devices.values()].filter(x => x.userId === user.id);
        const deliveries = await Promise.allSettled(targets.map(device => push(device, call)));
        audit({ event: 'call_created', callId: call.id, userId: user.id, delivered: deliveries.filter(x => x.status === 'fulfilled' && x.value.delivered).length });
        return { call, pushes: deliveries.map(x => x.status === 'fulfilled' ? x.value : { delivered: false, error: 'push_failed' }) };
      }
      const match = /^\/internal\/calls\/([a-zA-Z0-9-]+)\/end$/.exec(path);
      if (req.method === 'POST' && match) {
        const call = calls.get(match[1]); check(call, 404, 'call_not_found');
        call.state = 'ended'; return { call };
      }
      throw new HttpError(404, 'not_found');
    }
    const user = users.find(x => equalToken(bearer(req), x.token));
    check(user, 401, 'unauthorized');
    const window = limits.get(user.id) || { count: 0, until: now() + 60000 };
    window.count++; limits.set(user.id, window); check(window.count <= 180, 429, 'rate_limited');
    if (req.method === 'GET' && path === '/api/bootstrap') return { mode, userId: user.id, portalUrl, doors: user.doors.map(id => ({ id, name: doors[id].name, vendor: doors[id].vendor })) };
    if (req.method === 'POST' && path === '/api/devices') {
      const data = await body(req);
      check(idPattern.test(data.deviceId) && ['ios', 'android'].includes(data.platform));
      check(typeof data.token === 'string' && /^[a-zA-Z0-9_:\-]{16,4096}$/.test(data.token));
      const previous = devices.get(data.deviceId);
      check(!previous || previous.userId === user.id, 409, 'device_id_in_use');
      check(devices.size < 1000 || previous, 503, 'devices_busy');
      devices.set(data.deviceId, { ...data, userId: user.id }); return { registered: true };
    }
    if (req.method === 'DELETE' && path.startsWith('/api/devices/')) {
      const id = path.slice('/api/devices/'.length);
      check(devices.get(id)?.userId === user.id, 404, 'device_not_found'); devices.delete(id); return { removed: true };
    }
    if (req.method === 'GET' && path === '/api/calls') return { calls: [...calls.values()].filter(x => x.userId === user.id && !['ended', 'expired'].includes(x.state)) };
    let match = /^\/api\/calls\/([a-zA-Z0-9-]+)(?:\/(answer|active|end))?$/.exec(path);
    if (match) {
      const call = callFor(user, match[1]);
      if (req.method === 'GET' && !match[2]) return { call };
      check(req.method === 'POST' && match[2], 405, 'method_not_allowed');
      const data = await body(req);
      check(idPattern.test(data.deviceId));
      if (match[2] === 'end') {
        check(!call.deviceId || call.deviceId === data.deviceId, 409, 'answered_elsewhere');
        call.state = 'ended';
      } else {
        check(!['ended', 'expired'].includes(call.state), 410, 'call_ended');
        check(!call.deviceId || call.deviceId === data.deviceId, 409, 'answered_elsewhere');
        if (match[2] === 'answer') { check(['ringing', 'answering'].includes(call.state), 409, 'invalid_call_state'); call.state = 'answering'; }
        else { check(['answering', 'active'].includes(call.state) && call.deviceId === data.deviceId, 409, 'invalid_call_state'); if (call.state === 'answering') call.expiresAt = now() + 300000; call.state = 'active'; }
        call.deviceId = data.deviceId;
      }
      return { call };
    }
    match = /^\/api\/doors\/([a-zA-Z0-9-]+)\/unlock$/.exec(path);
    if (req.method === 'POST' && match) {
      const doorId = match[1], door = doorFor(user, doorId), data = await body(req);
      check(idPattern.test(data.requestId));
      const key = `${user.id}:${data.requestId}`, fingerprint = JSON.stringify([doorId, data.callId || null, data.deviceId || null]);
      const previous = requests.get(key);
      if (previous) { check(previous.fingerprint === fingerprint, 409, 'request_id_reused'); return previous.result; }
      check(requests.size < 2000, 503, 'unlock_busy');
      const result = (async () => {
        let outcome;
        try { outcome = await edgeUnlock(doorId, createHash('sha256').update(JSON.stringify([user.id, data.requestId])).digest('hex')); }
        catch { outcome = { status: 'unknown' }; }
        audit({ event: 'unlock', userId: user.id, doorId, requestId: data.requestId, status: outcome.status });
        if (outcome.status === 'accepted') return { method: 'http', status: 'accepted', requestId: data.requestId };
        if (outcome.status === 'unavailable' && data.callId && door.dtmf) {
          const call = callFor(user, data.callId);
          check(call.doorId === doorId && call.state === 'active' && call.expiresAt > now() && call.deviceId === data.deviceId, 409, 'dtmf_requires_active_call');
          check(/^[0-9A-D*#]{1,16}$/.test(door.dtmf), 500, 'invalid_dtmf_config');
          return { method: 'dtmf', status: 'authorized', digits: door.dtmf, sipCallId: call.sipCallId, requestId: data.requestId };
        }
        throw new HttpError(outcome.status === 'rejected' ? 502 : 503, outcome.status === 'unavailable' ? 'http_unavailable' : 'unlock_outcome_unknown');
      })();
      requests.set(key, { fingerprint, result, until: now() + 600000 });
      return result;
    }
    match = /^\/api\/doors\/([a-zA-Z0-9-]+)\/whep$/.exec(path);
    if (req.method === 'POST' && match) {
      const door = doorFor(user, match[1]);
      check(/^[a-zA-Z0-9-]+$/.test(door.stream), 500, 'invalid_stream');
      check(sessions.size < 200, 503, 'video_busy');
      let sdp = '';
      for await (const chunk of req) { sdp += chunk; check(sdp.length <= 65536, 413, 'sdp_too_large'); }
      check(sdp.startsWith('v=0'), 400, 'invalid_sdp');
      let upstream;
      try { upstream = await fetch(new URL(`${door.stream}/whep`, mediaBase), { method: 'POST', body: sdp, headers: { 'Content-Type': 'application/sdp', ...(mediaAuthorization ? { Authorization: mediaAuthorization } : {}) }, redirect: 'error', signal: AbortSignal.timeout(8000) }); }
      catch { throw new HttpError(502, 'video_unavailable'); }
      check(upstream.status === 201, 502, 'video_unavailable');
      check(upstream.headers.get('location'), 502, 'invalid_media_location');
      const location = new URL(upstream.headers.get('location'), upstream.url);
      check(location.origin === mediaBase.origin, 502, 'invalid_media_location');
      const id = randomUUID(); sessions.set(id, { location, userId: user.id, until: now() + 300000 });
      res.statusCode = 201; res.setHeader('Location', `/api/video/${id}`); res.setHeader('Content-Type', 'application/sdp');
      res.end(await upstream.text()); return;
    }
    match = /^\/api\/video\/([a-zA-Z0-9-]+)$/.exec(path);
    if (req.method === 'DELETE' && match) {
      const session = sessions.get(match[1]); check(session?.userId === user.id, 404, 'video_not_found');
      const upstream = await fetch(session.location, { method: 'DELETE', headers: mediaAuthorization ? { Authorization: mediaAuthorization } : {}, redirect: 'error', signal: AbortSignal.timeout(4000) });
      check(upstream.ok || upstream.status === 404, 502, 'video_cleanup_failed'); sessions.delete(match[1]); return { removed: true };
    }
    throw new HttpError(404, 'not_found');
  });
}
if (require.main === module) {
  const config = JSON.parse(readFileSync(process.env.INTERCOM_API_CONFIG, 'utf8'));
  config.users.forEach(user => { user.token = process.env[user.tokenEnv]; });
  const edgeUnlock = (doorId, requestId) => jsonFetch(new URL('/unlock', config.edges[config.doors[doorId].edge]), { method: 'POST', headers: { Authorization: `Bearer ${process.env.EDGE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ doorId, requestId }) });
  createApi({ ...config, internalToken: process.env.INTERNAL_TOKEN, mediaAuthorization: process.env.MEDIA_AUTHORIZATION, edgeUnlock, push: createPush(config.push), audit: event => process.stdout.write(`${JSON.stringify(event)}\n`) }).listen(config.port || 8090, config.host || '127.0.0.1');
}
module.exports = { createApi };
