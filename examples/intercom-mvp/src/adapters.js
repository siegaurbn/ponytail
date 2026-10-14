const { createHash } = require('node:crypto');
const { check } = require('./http');

// Profiles are commissioned per model/firmware; panel credentials never leave the edge.
const paths = {
  akuvox: panel => `/fcgi/OpenDoor?action=OpenDoor&DoorNum=${panel.relay}`,
  dnake: panel => panel.profile === 'webapi'
    ? `/cgi-bin/webapi.cgi?api=unlock&index=${panel.relay}&username=${encodeURIComponent(panel.username)}&password=${createHash('md5').update(panel.password).digest('hex').toUpperCase()}`
    : '/cgi-bin/ext/control.cgi?op=unlock',
  'bas-ip': panel => `/api/v1/access/general/lock/open/remote/accepted/${panel.relay}`
};
function validatePanel(panel) {
  check(Object.hasOwn(paths, panel.vendor), 500, 'unknown_vendor');
  check(Number.isInteger(panel.relay) && panel.relay >= 0 && panel.relay <= 8, 500, 'invalid_relay');
  const base = new URL(panel.baseUrl);
  check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/', 500, 'invalid_panel_url');
  check(panel.httpEnabled === false || panel.commissioned === true, 500, 'profile_not_commissioned');
  check(panel.vendor !== 'dnake' || ['legacy', 'webapi'].includes(panel.profile), 500, 'invalid_dnake_profile');
  return base;
}
async function unlock(panel, transport = fetch) {
  const base = validatePanel(panel);
  if (panel.httpEnabled === false) return { status: 'unavailable' };
  const headers = {};
  if (panel.vendor === 'bas-ip') {
    check(panel.token, 500, 'missing_panel_token');
    headers.Authorization = `Bearer ${panel.token}`;
  } else if (panel.username && !(panel.vendor === 'dnake' && panel.profile === 'webapi')) {
    headers.Authorization = `Basic ${Buffer.from(`${panel.username}:${panel.password}`).toString('base64')}`;
  }
  try {
    const response = await transport(new URL(paths[panel.vendor](panel), base), {
      method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(2500)
    });
    // A timeout/5xx may have happened AFTER activation: never automatically open twice.
    if (!response.ok) return { status: [401, 403].includes(response.status) ? 'rejected' : 'unknown' };
    const text = await response.text();
    if (panel.successPattern && !new RegExp(panel.successPattern).test(text)) return { status: 'unknown' };
    return { status: 'accepted' };
  } catch { return { status: 'unknown' }; }
}
module.exports = { validatePanel, unlock };
