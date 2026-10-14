const { connect } = require('node:http2');
const { createPrivateKey, sign } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { check } = require('./http');

function jwt(header, claims, key, algorithm, encoding) {
  const unsigned = [header, claims].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  const signature = sign(algorithm, Buffer.from(unsigned), { key: createPrivateKey(key), ...(encoding ? { dsaEncoding: encoding } : {}) });
  return `${unsigned}.${signature.toString('base64url')}`;
}
function apnsSend(settings, device, payload) {
  const authorization = jwt({ alg: 'ES256', kid: settings.keyId }, { iss: settings.teamId, iat: Math.floor(Date.now() / 1000) }, readFileSync(settings.keyFile), 'sha256', 'ieee-p1363');
  return new Promise((resolve, reject) => {
    const client = connect(settings.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
    const finish = error => { client.destroy(); error ? reject(error) : resolve(); };
    client.on('error', () => finish(new Error('apns_unavailable')));
    const req = client.request({ ':method': 'POST', ':path': `/3/device/${device.token}`, authorization: `bearer ${authorization}`,
      'apns-topic': `${settings.bundleId}.voip`, 'apns-push-type': 'voip', 'apns-priority': '10',
      'apns-expiration': String(Math.floor(payload.expiresAt / 1000)), 'content-type': 'application/json' });
    let status;
    req.on('response', headers => { status = headers[':status']; });
    req.on('data', () => {});
    req.on('end', () => finish(status === 200 ? null : new Error('apns_rejected')));
    req.on('error', () => finish(new Error('apns_unavailable')));
    req.setTimeout(4000, () => finish(new Error('apns_timeout')));
    req.end(JSON.stringify({ aps: {}, ...payload }));
  });
}
function createPush(settings = {}) {
  let fcmAccess;
  async function fcmSend(device, payload) {
    const account = JSON.parse(readFileSync(settings.fcmServiceAccount, 'utf8'));
    if (!fcmAccess || fcmAccess.until < Date.now()) {
      const time = Math.floor(Date.now() / 1000);
      const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, { iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: time, exp: time + 3600 }, account.private_key, 'RSA-SHA256');
      const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(4000) });
      check(response.ok, 502, 'fcm_auth_failed');
      const auth = await response.json();
      fcmAccess = { token: auth.access_token, until: Date.now() + (auth.expires_in - 60) * 1000 };
    }
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
      method: 'POST', headers: { Authorization: `Bearer ${fcmAccess.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token: device.token, data: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, String(v)])), android: { priority: 'HIGH', ttl: `${Math.max(0, Math.ceil((payload.expiresAt - Date.now()) / 1000))}s` } } }), signal: AbortSignal.timeout(4000)
    });
    check(response.ok, 502, 'fcm_rejected');
  }
  return async (device, call) => {
    const payload = { callId: call.id, sipCallId: call.sipCallId, doorId: call.doorId, expiresAt: call.expiresAt, name: call.name };
    if (settings.demo) return { delivered: false, mode: 'demo' };
    await (device.platform === 'ios' ? apnsSend(settings.apns, device, payload) : fcmSend(device, payload));
    return { delivered: true };
  };
}
module.exports = { createPush, jwt };
