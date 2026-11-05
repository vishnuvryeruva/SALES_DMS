import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { addDays, todayIso } from './lib/dates.js';
import { testConfig, testDeps } from './fixtures.js';

let server;
let url;

before(async () => {
  const { config, services, audit } = testDeps();
  server = createApp(config, { services, audit }).listen(0);
  await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(() => server.close());

const post = (path, body) =>
  fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

test('chat answers a full question with an assessment card and keeps context for follow-ups', async () => {
  const date = addDays(todayIso(), 5);
  const first = await post('/chat', { message: `How reliable is the promise for material 1000002, plant 1000, 20 EA, requested ${date}?` });
  assert.equal(first.status, 200);
  assert.equal(first.body.engine, 'rules');
  assert.equal(first.body.assessments[0].rating, 'Medium');
  assert.deepEqual(first.body.context, { material: '1000002', plant: '1000', quantity: 20, unit: 'EA', requestedDate: date });

  const followUp = await post('/chat', { message: 'what about 5?', context: first.body.context });
  assert.equal(followUp.body.assessments[0].rating, 'High');
  assert.equal(followUp.body.assessments[0].input.quantity, 5);
});

test('chat asks for missing inputs instead of guessing', async () => {
  const reply = await post('/chat', { message: 'is material 1000001 ok for 10 EA?' });
  assert.equal(reply.body.assessments.length, 0);
  assert.match(reply.body.responseText, /plant/);
  assert.match(reply.body.responseText, /requested date/);
});

test('assess endpoint validates and status reports the mock connection', async () => {
  const bad = await post('/assess', { material: '1000001' });
  assert.equal(bad.status, 400);
  const status = await fetch(`${url}/status`).then((r) => r.json());
  assert.equal(status.sap.mode, 'mock');
  assert.equal(status.sampleMaterials.length, 7);
});

test('connectivity diagnostic reads both service documents', async () => {
  const res = await post('/diagnostics/connectivity', {});
  assert.deepEqual(res.body.checks.map((c) => [c.api, c.ok]), [
    ['API_PRODUCT_AVAILY_INFO', true],
    ['API_AVAIL_TO_PROMISE_CHECK', true],
  ]);
  assert.deepEqual(res.body.checks[1].entitySets, ['RlvtProductPlant']);
});

test('basic auth gate protects everything except health', async () => {
  const config = testConfig({ top: { basicAuth: { user: 'jnj', password: 's3cret' } } });
  const gated = createApp(config).listen(0);
  await new Promise((r) => gated.once('listening', r));
  const base = `http://127.0.0.1:${gated.address().port}/api/v1`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/status`)).status, 401);
    const ok = await fetch(`${base}/status`, { headers: { Authorization: `Basic ${Buffer.from('jnj:s3cret').toString('base64')}` } });
    assert.equal(ok.status, 200);
  } finally {
    gated.close();
  }
});
