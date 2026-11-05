import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessPromise, normalizeInput } from './assessment.js';
import { addDays, todayIso } from './lib/dates.js';
import { testDeps } from './fixtures.js';

const today = todayIso();
const deps = testDeps();
const assess = (input) => assessPromise(input, deps);

test('healthy stock is rated High with the requested date confirmed', async () => {
  const a = await assess({ material: '1000001', plant: '1000', quantity: 50, requestedDate: addDays(today, 7) });
  assert.equal(a.rating, 'High');
  assert.equal(a.outcome.coverage, 'full_on_time');
  assert.equal(a.outcome.confirmedDate, addDays(today, 7));
  assert.equal(a.dataSource, 'mock');
  assert.ok(a.assumptions.some((s) => s.includes('assumed EA')));
});

test('low stock gives Medium with a partial shipment split', async () => {
  const a = await assess({ material: '1000002', plant: '1000', quantity: 20, unit: 'EA', requestedDate: addDays(today, 5) });
  assert.equal(a.rating, 'Medium');
  assert.deepEqual(a.outcome.partialShipment, {
    nowQty: 8,
    nowDate: addDays(today, 5),
    laterQty: 12,
    laterDate: addDays(today, 12),
    unconfirmedQty: 0,
  });
  assert.equal(a.outcome.nextAvailable.date, addDays(today, 12));
  assert.match(a.recommendedAction, /Offer 8 EA/);
});

test('backordered material gives Medium with a later confirmed date', async () => {
  const a = await assess({ material: '1000003', plant: '1000', quantity: 10, requestedDate: addDays(today, 3) });
  assert.equal(a.rating, 'Medium');
  assert.equal(a.outcome.coverage, 'full_late');
  assert.equal(a.outcome.confirmedDate, addDays(today, 9));
});

test('product allocation cap is flagged as the constraint without inventing a date', async () => {
  const a = await assess({ material: '1000004', plant: '1000', quantity: 60, requestedDate: addDays(today, 4) });
  assert.equal(a.rating, 'Medium');
  assert.equal(a.outcome.confirmedOnTimeQty, 25);
  assert.equal(a.outcome.partialShipment.unconfirmedQty, 35);
  assert.equal(a.outcome.nextAvailable, null);
  assert.ok(a.drivers.some((d) => /product allocation/.test(d.text)));
});

test('no supply is Low and points to the OMP planned order as indicative', async () => {
  const a = await assess({ material: '1000005', plant: '1000', quantity: 5, requestedDate: addDays(today, 10) });
  assert.equal(a.rating, 'Low');
  assert.equal(a.outcome.coverage, 'none');
  assert.equal(a.outcome.nextAvailable.date, addDays(today, 45));
  assert.match(a.outcome.nextAvailable.source, /OMP/);
});

test('an unavailable aATP service fails safe to Low', async () => {
  const a = await assess({ material: '1000006', plant: '2000', quantity: 15, requestedDate: addDays(today, 6) });
  assert.equal(a.rating, 'Low');
  assert.equal(a.evidence.atp.ok, false);
  assert.equal(a.evidence.atp.error.status, 503);
});

test('a gap between availability and ATP needs a documented assumption (Medium)', async () => {
  const a = await assess({ material: '1000007', plant: '1000', quantity: 50, requestedDate: addDays(today, 5) });
  assert.equal(a.rating, 'Medium');
  assert.equal(a.outcome.coverage, 'full_on_time');
  assert.ok(a.assumptions.some((s) => /snapshot/.test(s)));
});

test('unknown material is Low with the SAP message', async () => {
  const a = await assess({ material: 'NOPE', plant: '1000', quantity: 1, requestedDate: addDays(today, 2) });
  assert.equal(a.rating, 'Low');
  assert.match(a.drivers[0].text, /does not exist in plant 1000/);
});

test('missing and invalid inputs are reported instead of assessed', async () => {
  const missing = await assess({ material: '1000001' });
  assert.equal(missing.status, 'needs_input');
  assert.deepEqual(missing.missing, ['plant', 'quantity', 'requestedDate']);

  const past = normalizeInput({ material: 'X', plant: '1000', quantity: 1, requestedDate: addDays(today, -1) }, { today });
  assert.match(past.errors[0], /in the past/);

  const badPlant = normalizeInput({ material: 'X', plant: '10000', quantity: 0, requestedDate: today }, { today });
  assert.equal(badPlant.errors.length, 2);
});

test('the audit log records each assessment with its API calls', async () => {
  const local = testDeps();
  await assessPromise({ material: '1000001', plant: '1000', quantity: 1, requestedDate: addDays(today, 1) }, local);
  const [entry] = local.audit.list(1);
  assert.equal(entry.type, 'assessment');
  assert.equal(entry.rating, 'High');
  assert.deepEqual(entry.calls.map((c) => c.api), ['API_PRODUCT_AVAILY_INFO', 'API_AVAIL_TO_PROMISE_CHECK', 'OMP_PROJECTED_INVENTORY']);
});
