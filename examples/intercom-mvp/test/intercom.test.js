const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync, verify } = require('node:crypto');
const { createApi } = require('../src/api');
const { createEdge } = require('../src/edge');
const { unlock } = require('../src/adapters');
const { jwt } = require('../src/push');

const resident = 'resident-token-for-tests-only', stranger = 'stranger-token-for-tests-only', internal = 'internal-token-for-tests-only';
async function fixture(t, outcome = { status: 'accepted' }, mediaUrl = 'http://127.0.0.1:1/') {
  let time = Date.now(), attempts = 0, pushes = 0;
  const audit = [];
  const api = createApi({ users: [{ id: 'resident', token: resident, doors: ['door'] }, { id: 'other', token: stranger, doors: [] }],
    doors: { door: { name: 'Door', vendor: 'akuvox', stream: 'door', dtmf: '#' } }, internalToken: internal,
    mediaUrl, mediaAuthorization: 'Basic internal-media-only', portalUrl: 'https://example.com/', now: () => time,
    edgeUnlock: async (doorId, requestId) => { assert.equal(requestId.length, 64); attempts++; await new Promise(resolve => setTimeout(resolve, 10)); return outcome; },
    push: async () => { pushes++; return { delivered: true }; }, audit: event => audit.push(event) });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => api.close(resolve)));
  async function request(path, data, token = resident, method = data === undefined ? 'GET' : 'POST') {
    const response = await fetch(`http://127.0.0.1:${api.address().port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  }
  const deviceId = randomUUID();
  async function ring() {
    const callId = randomUUID();
    const result = await request('/internal/calls', { callId, sipCallId: `sip-${callId}`, userId: 'resident', doorId: 'door', expiresAt: time + 60000 }, internal);
    assert.equal(result.status, 200); return result.data.call;
  }
  return { base: `http://127.0.0.1:${api.address().port}`, request, ring, deviceId, attempts: () => attempts, pushes: () => pushes, audit, advance: n => { time += n; } };
}
test('unauthorized residents cannot enumerate doors, invoke relays, or submit SIP events', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/bootstrap', undefined, 'bad')).status, 401);
  assert.equal((await f.request('/api/doors/door/unlock', { requestId: randomUUID() }, stranger)).status, 403);
  assert.equal((await f.request('/internal/calls', {}, resident)).status, 401);
  assert.equal(f.attempts(), 0);
  const bootstrap = await f.request('/api/bootstrap');
  assert.equal(bootstrap.data.doors[0].id, 'door');
  assert.ok(!JSON.stringify(bootstrap.data).includes('dtmf'));
});
test('concurrent HTTP unlocks execute once; reusing an ID for another payload fails', async t => {
  const f = await fixture(t), requestId = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => f.request('/api/doors/door/unlock', { requestId })));
  assert.ok(results.every(x => x.status === 200 && x.data.method === 'http'));
  assert.equal(f.attempts(), 1);
  assert.equal((await f.request('/api/doors/door/unlock', { requestId, callId: randomUUID() })).status, 409);
  assert.equal((await f.request('/api/doors/door/unlock', { requestId: 'a'.repeat(80) })).status, 200);
  assert.ok(!JSON.stringify(f.audit).includes(resident));
});
test('DTMF requires the authorized active call and the answering device', async t => {
  const f = await fixture(t, { status: 'unavailable' }), call = await f.ring();
  const open = (deviceId = f.deviceId) => f.request('/api/doors/door/unlock', { requestId: randomUUID(), callId: call.id, deviceId });
  assert.equal((await open()).status, 409);
  assert.equal((await f.request(`/api/calls/${call.id}/active`, { deviceId: f.deviceId })).status, 409);
  assert.equal((await f.request(`/api/calls/${call.id}/answer`, { deviceId: f.deviceId })).status, 200);
  assert.equal((await f.request(`/api/calls/${call.id}/answer`, { deviceId: randomUUID() })).status, 409);
  assert.equal((await f.request(`/api/calls/${call.id}/active`, { deviceId: f.deviceId })).status, 200);
  assert.equal((await open(randomUUID())).status, 409);
  const result = await open(); assert.equal(result.data.method, 'dtmf'); assert.equal(result.data.digits, '#'); assert.equal(result.data.sipCallId, call.sipCallId);
  await f.request(`/api/calls/${call.id}/end`, { deviceId: f.deviceId }); assert.equal((await open()).status, 409);
});
test('unknown outcomes and authentication failure never authorize DTMF', async t => {
  for (const status of ['unknown', 'rejected']) {
    const f = await fixture(t, { status }), call = await f.ring();
    await f.request(`/api/calls/${call.id}/answer`, { deviceId: f.deviceId }); await f.request(`/api/calls/${call.id}/active`, { deviceId: f.deviceId });
    const result = await f.request('/api/doors/door/unlock', { requestId: randomUUID(), callId: call.id, deviceId: f.deviceId });
    assert.ok([502, 503].includes(result.status)); assert.equal(result.data.method, undefined);
  }
});
test('push registration, webhook replay, expiry, and user isolation', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/devices', { deviceId: f.deviceId, platform: 'ios', token: 'test-token-123456789' })).status, 200);
  assert.equal((await f.request('/api/devices', { deviceId: f.deviceId, platform: 'android', token: 'test-token-123456789' }, stranger)).status, 409);
  const call = await f.ring(); assert.equal(f.pushes(), 1);
  await f.request('/internal/calls', { callId: call.id, sipCallId: call.sipCallId, userId: 'resident', doorId: 'door', expiresAt: call.expiresAt }, internal);
  assert.equal(f.pushes(), 1);
  assert.equal((await f.request(`/api/calls/${call.id}`, undefined, stranger)).status, 404);
  assert.equal((await f.request('/api/devices/' + f.deviceId, undefined, stranger, 'DELETE')).status, 404);
  f.advance(61000);
  assert.equal((await f.request(`/api/calls/${call.id}/answer`, { deviceId: f.deviceId })).status, 410);
  assert.deepEqual((await f.request('/api/calls')).data.calls, []);
});
test('malformed JSON, oversized bodies, and excessive requests are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/devices', [])).status, 400);
  assert.equal((await f.request('/api/devices', { token: 'a'.repeat(17000) })).status, 413);
  for (let i = 0; i < 180; i++) await f.request('/api/bootstrap');
  assert.equal((await f.request('/api/bootstrap')).status, 429);
  f.advance(60001); assert.equal((await f.request('/api/bootstrap')).status, 200);
});
test('vendor profiles send only commissioned LAN requests and recognize uncertain responses', async () => {
  for (const [vendor, profile, path] of [
    ['akuvox', undefined, '/fcgi/OpenDoor?action=OpenDoor&DoorNum=1'],
    ['dnake', 'legacy', '/cgi-bin/ext/control.cgi?op=unlock'],
    ['dnake', 'webapi', '/cgi-bin/webapi.cgi?api=unlock&index=1&username=admin&password=098F6BCD4621D373CADE4E832627B4F6'],
    ['bas-ip', undefined, '/api/v1/access/general/lock/open/remote/accepted/1']
  ]) {
    const panel = { vendor, profile, baseUrl: 'http://192.168.1.5/', relay: 1, commissioned: true, username: 'admin', password: 'test', token: 'edge-only-token', successPattern: '^OK$' };
    const result = await unlock(panel, async (url, options) => { assert.equal(url.pathname + url.search, path); assert.equal(options.redirect, 'error'); return new Response('OK'); });
    assert.equal(result.status, 'accepted');
    assert.equal((await unlock(panel, async () => new Response('error'))).status, 'unknown');
    assert.equal((await unlock(panel, async () => new Response('', { status: 403 }))).status, 'rejected');
    assert.equal((await unlock(panel, async () => { throw new Error('timeout'); })).status, 'unknown');
    assert.equal((await unlock({ ...panel, httpEnabled: false }, () => assert.fail())).status, 'unavailable');
    await assert.rejects(unlock({ ...panel, commissioned: false }), /profile_not_commissioned/);
  }
});
test('edge authenticates and deduplicates before invoking a panel', async t => {
  let count = 0;
  const token = 'edge-token-for-tests-only-123';
  const edge = createEdge({ token, panels: { door: { vendor: 'akuvox', relay: 1, baseUrl: 'http://127.0.0.1/', commissioned: true } }, transport: async () => { count++; await new Promise(resolve => setTimeout(resolve, 20)); return new Response('OK'); } });
  await new Promise(resolve => edge.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => edge.close(resolve)));
  const send = (authorization, data) => fetch(`http://127.0.0.1:${edge.address().port}/unlock`, { method: 'POST', headers: { Authorization: `Bearer ${authorization}` }, body: JSON.stringify(data) });
  assert.equal((await send('bad', {})).status, 401);
  const data = { requestId: randomUUID(), doorId: 'door' };
  const result = await Promise.all([send(token, data), send(token, data)]); assert.ok(result.every(x => x.status === 200)); assert.equal(count, 1);
  assert.equal((await send(token, { ...data, doorId: '__proto__' })).status, 404);
});
test('APNs JWT uses the required raw ES256 signature', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const token = jwt({ alg: 'ES256', kid: 'test' }, { iss: 'team', iat: 1 }, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'sha256', 'ieee-p1363');
  const [header, claims, signature] = token.split('.'); assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});
test('WHEP keeps camera credentials private and scopes session deletion to its resident', async t => {
  let mode = 'valid', posts = 0, deletes = 0;
  const media = require('node:http').createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Basic internal-media-only');
    if (req.method === 'POST') { posts++; res.writeHead(201, { 'Location': mode === 'valid' ? '/sessions/one' : 'https://untrusted.example/session', 'Content-Type': 'application/sdp' }); res.end('v=0\r\n'); }
    else { deletes++; res.writeHead(204); res.end(); }
  });
  await new Promise(resolve => media.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => media.close(resolve)));
  const f = await fixture(t, { status: 'accepted' }, `http://127.0.0.1:${media.address().port}/`);
  const watch = token => fetch(f.base + '/api/doors/door/whep', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' });
  assert.equal((await watch(stranger)).status, 403); assert.equal(posts, 0);
  const response = await watch(resident); assert.equal(response.status, 201); assert.equal(await response.text(), 'v=0\r\n');
  const location = response.headers.get('location'); assert.ok(location.startsWith('/api/video/'));
  assert.equal((await f.request(location, undefined, stranger, 'DELETE')).status, 404); assert.equal(deletes, 0);
  assert.equal((await f.request(location, undefined, resident, 'DELETE')).status, 200); assert.equal(deletes, 1);
  mode = 'malicious'; assert.equal((await watch(resident)).status, 502);
});
test('duplicate active reports cannot extend a call beyond the lab time limit', async t => {
  const f = await fixture(t), call = await f.ring();
  await f.request(`/api/calls/${call.id}/answer`, { deviceId: f.deviceId });
  const active = await f.request(`/api/calls/${call.id}/active`, { deviceId: f.deviceId });
  f.advance(60000);
  const duplicate = await f.request(`/api/calls/${call.id}/active`, { deviceId: f.deviceId });
  assert.equal(duplicate.data.call.expiresAt, active.data.call.expiresAt);
  f.advance(240001); assert.equal((await f.request(`/api/calls/${call.id}/active`, { deviceId: f.deviceId })).status, 410);
});
