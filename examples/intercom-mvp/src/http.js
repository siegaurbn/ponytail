const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
function check(condition, status = 400, code = 'invalid_request') {
  if (!condition) throw new HttpError(status, code);
}
function equalToken(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function bearer(req) { return /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1]; }
async function body(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    check(Buffer.byteLength(data) <= 16384, 413, 'body_too_large');
  }
  let value;
  try { value = JSON.parse(data || '{}'); } catch { throw new HttpError(400, 'invalid_json'); }
  check(value && typeof value === 'object' && !Array.isArray(value));
  return value;
}
function server(handler) {
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const result = await handler(req, res);
      if (!res.writableEnded) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      }
    } catch (error) {
      res.statusCode = error.status || 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error.status ? error.message : 'internal_error' }));
    }
  });
}
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new HttpError(502, 'upstream_rejected');
  return response.json();
}
module.exports = { HttpError, check, equalToken, bearer, body, server, jsonFetch };
