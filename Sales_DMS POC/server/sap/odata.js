import { UpstreamError } from '../http/transport.js';

const CSRF_TTL_MS = 10 * 60 * 1000;

/** OData V4 key literal: Product='AB''C' (single quotes doubled, then URL-encoded). */
export function keyLiteral(value) {
  return `'${encodeURIComponent(String(value).replace(/'/g, "''"))}'`;
}

export function sapErrorMessage(data) {
  if (!data || typeof data !== 'object') return null;
  const err = data.error;
  if (!err) return null;
  const message = typeof err.message === 'string' ? err.message : err.message?.value;
  const details = Array.isArray(err.details) ? err.details.map((d) => d.message).filter(Boolean) : [];
  return [message, ...details].filter(Boolean).join(' | ') || err.code || null;
}

function describeFailure(res) {
  const sapMessage = sapErrorMessage(res.data);
  if (sapMessage) return sapMessage;
  if (typeof res.data === 'string' && /<html/i.test(res.data)) {
    return 'Received an HTML page instead of OData JSON - the call was likely intercepted by a login/SSO page.';
  }
  return `HTTP ${res.status}`;
}

function kindForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'request';
}

function ensureJson(res) {
  if (res.status >= 200 && res.status < 300 && res.data && typeof res.data === 'object') return res.data;
  throw new UpstreamError(describeFailure(res), {
    kind: res.status >= 200 && res.status < 300 ? 'bad_response' : kindForStatus(res.status),
    status: res.status,
    detail: typeof res.data === 'string' ? res.data.slice(0, 500) : res.data,
  });
}

export function createODataClient(transport, { csrf = true } = {}) {
  const csrfCache = new Map();

  async function fetchCsrf(servicePath, force = false) {
    if (!csrf) return null;
    const cached = csrfCache.get(servicePath);
    if (!force && cached && Date.now() - cached.at < CSRF_TTL_MS) return cached;
    const res = await transport.request({
      method: 'GET',
      path: servicePath,
      headers: { 'X-CSRF-Token': 'Fetch', Accept: 'application/json' },
    });
    const token = res.headers['x-csrf-token'];
    if (!token || token.toLowerCase() === 'required') return null;
    const entry = { token, cookie: res.setCookies.map((c) => c.split(';')[0]).join('; '), at: Date.now() };
    csrfCache.set(servicePath, entry);
    return entry;
  }

  async function get(servicePath, relativePath = '') {
    const res = await transport.request({
      method: 'GET',
      path: servicePath + relativePath,
      headers: { Accept: 'application/json' },
    });
    return ensureJson(res);
  }

  /** POST a bound/unbound action. Retries once on CSRF rejection and once with If-Match on 428. */
  async function postAction(servicePath, actionPath, body) {
    let token = await fetchCsrf(servicePath);
    let ifMatch = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token && { 'X-CSRF-Token': token.token }),
        ...(token?.cookie && { Cookie: token.cookie }),
        ...(ifMatch && { 'If-Match': '*' }),
      };
      const res = await transport.request({ method: 'POST', path: servicePath + actionPath, headers, body });
      if (res.status === 403 && String(res.headers['x-csrf-token']).toLowerCase() === 'required' && csrf) {
        token = await fetchCsrf(servicePath, true);
        continue;
      }
      if (res.status === 428 && !ifMatch) {
        ifMatch = true;
        continue;
      }
      return ensureJson(res);
    }
    throw new UpstreamError('Action call was rejected after CSRF/If-Match retries.', { kind: 'auth', status: 403 });
  }

  return { get, postAction };
}
