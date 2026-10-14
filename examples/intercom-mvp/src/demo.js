const { createApi } = require('./api');
const { createEdge } = require('./edge');
const { createPush } = require('./push');
const { jsonFetch } = require('./http');
const token = 'demo-resident-token-change-me', edgeToken = 'demo-edge-token-change-me-123', internalToken = 'demo-sip-token-change-me-1234';
const doors = {
  entrance: { name: 'Вход · AKUVOX', vendor: 'akuvox', stream: 'entrance', dtmf: '#' },
  gate: { name: 'Калитка · DNAKE', vendor: 'dnake', stream: 'gate', dtmf: '0' },
  lobby: { name: 'Холл · BAS-IP', vendor: 'bas-ip', stream: 'lobby', dtmf: '*' }
};
const panels = Object.fromEntries(Object.entries(doors).map(([id, door]) => [id, { vendor: door.vendor, baseUrl: 'http://127.0.0.1/', relay: 1, profile: 'legacy', commissioned: true, token: 'demo-panel-token', httpEnabled: id !== 'gate' }]));
const edge = createEdge({ token: edgeToken, panels, transport: async () => new Response('OK') });
edge.listen(8091, '127.0.0.1', () => {
  const api = createApi({ users: [{ id: 'resident', token, doors: Object.keys(doors) }], doors, internalToken,
    portalUrl: 'https://example.com/', mediaUrl: 'http://127.0.0.1:8889/',
    edgeUnlock: (doorId, requestId) => jsonFetch('http://127.0.0.1:8091/unlock', { method: 'POST', headers: { Authorization: `Bearer ${edgeToken}` }, body: JSON.stringify({ doorId, requestId }) }), push: createPush({ demo: true }), audit: event => process.stdout.write(`${JSON.stringify(event)}\n`) });
  api.listen(8090, '127.0.0.1', () => console.log(`Demo: http://127.0.0.1:8090\nResident token: ${token}\nSimulated relays only. Create a call with scripts/ring.js.`));
  process.on('SIGINT', () => { api.close(); edge.close(); });
});
