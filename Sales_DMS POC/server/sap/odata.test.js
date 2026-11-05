/**
 * Exercises the live (direct) code path over real HTTP against a fake S/4HANA gateway that enforces
 * Basic auth or OAuth bearer tokens, sap-client, and the CSRF token + session cookie handshake.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMockTransport } from './mock-dms.js';
import { createServices } from '../services.js';
import { assessPromise } from '../assessment.js';
import { createAuditLog } from '../audit.js';
import { addDays, todayIso } from '../lib/dates.js';
import { testConfig } from '../fixtures.js';

const base = testConfig();
const mock = createMockTransport(
  { availabilityServicePath: base.sap.availabilityServicePath, atpServicePath: base.sap.atpServicePath, ompProjectionPath: base.ompProjectionPath },
  { latencyMs: 0 }
);
const seen = [];
let server;
let baseUrl;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://localhost');
    seen.push({ method: req.method, path: url.pathname, headers: req.headers });

    if (url.pathname === '/oauth/token') {
      const ok = req.headers.authorization === `Basic ${Buffer.from('cid:secret').toString('base64')}`;
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok ? { access_token: 'tok-123', expires_in: 3600 } : { error: 'invalid_client' }));
    }
    const basicOk = req.headers.authorization === `Basic ${Buffer.from('ATP_USER:pw').toString('base64')}`;
    const bearerOk = req.headers.authorization === 'Bearer tok-123';
    if (!basicOk && !bearerOk) {
      res.writeHead(401, { 'content-type': 'text/html' });
      return res.end('<html>login</html>');
    }
    if (url.searchParams.get('sap-client') !== '100') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'CLIENT', message: 'sap-client missing' } }));
    }
    if (req.method === 'POST' && !String(req.headers.cookie || '').includes('SAP_SESSIONID_MOCK=mock-session')) {
      res.writeHead(403, { 'x-csrf-token': 'Required' });
      return res.end('CSRF token validation failed');
    }
    url.searchParams.delete('sap-client');
    const result = await mock.request({
      method: req.method,
      path: url.pathname + (url.search || ''),
      headers: req.headers,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined,
    });
    const headers = { ...result.headers };
    if (result.setCookies.length) headers['set-cookie'] = result.setCookies;
    res.writeHead(result.status, headers);
    res.end(typeof result.data === 'string' ? result.data : JSON.stringify(result.data));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function liveDeps(auth) {
  const config = testConfig({ sap: { mode: 'direct', baseUrl, defaultQuery: { 'sap-client': '100' }, auth } });
  return { config, services: createServices(config, { mockOptions: { latencyMs: 0 } }), audit: createAuditLog(config.audit) };
}

test('direct mode with basic auth performs the CSRF handshake and calls both actions', async () => {
  seen.length = 0;
  const deps = liveDeps({ type: 'basic', username: 'ATP_USER', password: 'pw' });
  const a = await assessPromise({ material: '1000002', plant: '1000', quantity: 20, requestedDate: addDays(todayIso(), 5) }, deps);

  assert.equal(a.dataSource, 'live');
  assert.equal(a.rating, 'Medium');
  const actionCalls = seen.filter((s) => s.method === 'POST').map((s) => decodeURIComponent(s.path));
  assert.ok(actionCalls.some((p) => p.endsWith("ProductMRPArea(Product='1000002',MRPArea='1000')/SAP__self.DetmAvailabilityTimeSeries")));
  assert.ok(actionCalls.some((p) => p.endsWith("RlvtProductPlant(Product='1000002',Plant='1000')/SAP__self.CheckAvailabilityWithoutResvn")));
  assert.ok(seen.some((s) => s.method === 'GET' && s.headers['x-csrf-token'] === 'Fetch'));
  assert.equal(a.evidence.atp.request.body.ProductAvailabilityUTCDateTime, `${addDays(todayIso(), 5)}T18:00:00Z`);
  assert.equal(a.evidence.atp.request.body._DocumentAttributes._Characteristics.length, 4);
});

test('direct mode with OAuth2 client credentials (CPI-style) fetches and uses a bearer token', async () => {
  const deps = liveDeps({ type: 'oauth2_client_credentials', tokenUrl: `${baseUrl}/oauth/token`, clientId: 'cid', clientSecret: 'secret' });
  const a = await assessPromise({ material: '1000001', plant: '1000', quantity: 5, requestedDate: addDays(todayIso(), 2) }, deps);
  assert.equal(a.rating, 'High');
});

test('wrong credentials surface as an auth failure and a Low rating', async () => {
  const deps = liveDeps({ type: 'basic', username: 'ATP_USER', password: 'wrong' });
  const a = await assessPromise({ material: '1000001', plant: '1000', quantity: 5, requestedDate: addDays(todayIso(), 2) }, deps);
  assert.equal(a.rating, 'Low');
  assert.equal(a.evidence.atp.error.kind, 'auth');
  assert.match(a.evidence.atp.error.message, /HTML page/);
});

test('connectivity to an unreachable host is reported as a network error', async () => {
  const config = testConfig({ sap: { mode: 'direct', baseUrl: 'http://127.0.0.1:1', auth: { type: 'none' }, timeoutMs: 2000 } });
  const services = createServices(config);
  await assert.rejects(services.odata.get(config.sap.atpServicePath), (err) => err.kind === 'network');
});
