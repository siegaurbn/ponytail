const { randomUUID } = require('node:crypto');
async function main() {
  const response = await fetch(`${process.env.API_URL || 'http://127.0.0.1:8090'}/internal/calls`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.INTERNAL_TOKEN || 'demo-sip-token-change-me-1234'}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId: randomUUID(), sipCallId: process.env.SIP_CALL_ID || `demo-${randomUUID()}`, userId: 'resident', doorId: process.argv[2] || 'entrance', expiresAt: Date.now() + 60000 })
  });
  console.log(response.status, await response.text());
  if (!response.ok) process.exitCode = 1;
}
main().catch(() => { console.error('Call request failed'); process.exitCode = 1; });
