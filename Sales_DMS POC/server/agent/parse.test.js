import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from './parse.js';

const today = '2026-11-05'; // Thursday

test('extracts all fields from the proposal-style question', () => {
  const { intent, fields } = parseRequest('How reliable is the promise for material 1000002, plant 1000, quantity 20 EA, requested date 2026-11-20?', { today });
  assert.equal(intent, 'assess');
  assert.deepEqual(fields, { material: '1000002', plant: '1000', quantity: 20, unit: 'EA', requestedDate: '2026-11-20' });
});

test('handles bare numbers, "at" plant and relative dates', () => {
  const { fields } = parseRequest('can we ship 1000003 at 1000 for 10 units by next friday', { today });
  assert.deepEqual(fields, { material: '1000003', plant: '1000', quantity: 10, unit: 'UNITS', requestedDate: '2026-11-06' });
});

test('handles US dates and month names, rolling into next year when needed', () => {
  assert.equal(parseRequest('need it 11/30/2026', { today }).fields.requestedDate, '2026-11-30');
  assert.equal(parseRequest('need it Jan 15', { today }).fields.requestedDate, '2027-01-15');
  assert.equal(parseRequest('by 3rd December', { today }).fields.requestedDate, '2026-12-03');
  assert.equal(parseRequest('in 2 weeks', { today }).fields.requestedDate, '2026-11-19');
});

test('follow-ups only carry the changed field', () => {
  assert.deepEqual(parseRequest('what about 50?', { today }).fields, { quantity: 50 });
  assert.deepEqual(parseRequest('and tomorrow?', { today }).fields, { requestedDate: '2026-11-06' });
});

test('detects availability, planned supply and help intents', () => {
  assert.equal(parseRequest('how much of material 1000001 is available at plant 1000', { today }).intent, 'availability');
  assert.equal(parseRequest('show OMP planned orders for 1000005 plant 1000', { today }).intent, 'planned_supply');
  assert.equal(parseRequest('help', { today }).intent, 'help');
  assert.equal(parseRequest('list sample materials', { today }).intent, 'catalog');
});
