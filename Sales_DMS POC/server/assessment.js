import { randomUUID } from 'node:crypto';
import { isIsoDate, toIsoDate, todayIso } from './lib/dates.js';
import { evaluateReliability } from './reliability.js';
import { availableOn } from './sap/services.js';
import { callSummary } from './audit.js';

export const DISCLAIMER = 'Decision-support assessment based on a read-only ATP simulation - not a guaranteed customer promise.';

const UNIT_SYNONYMS = { EACH: 'EA', PC: 'EA', PCS: 'EA', PIECE: 'EA', PIECES: 'EA', UNIT: 'EA', UNITS: 'EA' };
const OPTIONAL_FIELDS = ['mrpArea', 'shippingPoint', 'shipToCustomer', 'customerGroup', 'salesDocumentType', 'distributionChannel', 'atpCheckingRule'];
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Validates and normalizes request inputs.
 * @returns {{ input: object, missing: string[], errors: string[] }}
 */
export function normalizeInput(raw = {}, { defaultUnit = 'EA', today = todayIso(), requireQuantity = true, requireDate = true } = {}) {
  const missing = [];
  const errors = [];
  const assumptions = [];

  const material = clean(raw.material).toUpperCase();
  const plant = clean(raw.plant).toUpperCase();
  if (!material) missing.push('material');
  else if (material.length > 40) errors.push('Material number can be at most 40 characters.');
  if (!plant) missing.push('plant');
  else if (plant.length > 4) errors.push(`Plant "${plant}" is longer than 4 characters.`);

  let quantity = null;
  if (clean(raw.quantity) === '') {
    if (requireQuantity) missing.push('quantity');
  } else {
    quantity = Number(String(raw.quantity).replace(/,/g, ''));
    if (!Number.isFinite(quantity) || quantity <= 0) errors.push('Quantity must be a positive number.');
  }

  let unit = clean(raw.unit).toUpperCase();
  unit = UNIT_SYNONYMS[unit] || unit;
  if (!unit) {
    unit = defaultUnit;
    if (requireQuantity) assumptions.push(`Unit of measure not given - assumed ${defaultUnit}.`);
  }

  let requestedDate = null;
  if (clean(raw.requestedDate) === '') {
    if (requireDate) missing.push('requestedDate');
  } else {
    requestedDate = toIsoDate(clean(raw.requestedDate));
    if (!requestedDate || !isIsoDate(requestedDate)) errors.push(`Requested date "${raw.requestedDate}" is not a valid date (use YYYY-MM-DD).`);
    else if (requestedDate < today) errors.push(`Requested date ${requestedDate} is in the past (today is ${today}).`);
  }

  const input = { material, plant, quantity, unit, requestedDate };
  for (const field of OPTIONAL_FIELDS) if (clean(raw[field])) input[field] = clean(raw[field]).toUpperCase();
  if (requireDate) assumptions.push('Requested date is used as the material availability date (no transit or loading offset).');
  if (!input.mrpArea) assumptions.push(`MRP area assumed equal to plant ${plant || '?'}.`);
  input.assumptions = assumptions;
  return { input, missing, errors };
}

/**
 * Full workflow: Product Availability + Advanced ATP simulation + OMP planned supply -> rules.
 * @returns {Promise<object>} an assessment, or { status: 'needs_input', missing, errors }
 */
export async function assessPromise(rawInput, { services, config, audit, channel = 'api' }) {
  const today = todayIso();
  const { input, missing, errors } = normalizeInput(rawInput, { defaultUnit: config.atp.defaultUnit, today });
  if (missing.length || errors.length) return { status: 'needs_input', missing, errors, input };

  const [availability, atp, plannedSupply] = await Promise.all([
    services.availability.getTimeSeries(input),
    services.atp.check(input),
    services.plannedSupply.getPlannedSupply({ material: input.material, plant: input.plant, fromDate: today }),
  ]);

  const evaluation = evaluateReliability({ input, availability, atp, plannedSupply, rules: config.rules });
  const assessment = {
    id: randomUUID(),
    status: 'assessed',
    createdAt: new Date().toISOString(),
    dataSource: services.sapMode === 'mock' ? 'mock' : 'live',
    system: config.systemLabel,
    input,
    ...evaluation,
    assumptions: [...input.assumptions, ...evaluation.assumptions],
    evidence: { availability, atp, plannedSupply },
    disclaimer: DISCLAIMER,
  };

  audit?.record({
    type: 'assessment',
    correlationId: assessment.id,
    channel,
    dataSource: assessment.dataSource,
    input: { material: input.material, plant: input.plant, quantity: input.quantity, unit: input.unit, requestedDate: input.requestedDate },
    rating: assessment.rating,
    headline: assessment.headline,
    drivers: assessment.drivers.map((d) => d.text),
    recommendedAction: assessment.recommendedAction,
    outcome: assessment.outcome,
    calls: [callSummary(availability), callSummary(atp), callSummary(plannedSupply)],
  });
  return assessment;
}

/** "How much is available?" - time series only, no quantity or date required. */
export async function lookupAvailability(rawInput, { services, config, audit, channel = 'api' }) {
  const today = todayIso();
  const { input, missing, errors } = normalizeInput(rawInput, {
    defaultUnit: config.atp.defaultUnit,
    today,
    requireQuantity: false,
    requireDate: false,
  });
  if (missing.length || errors.length) return { status: 'needs_input', missing, errors, input };
  const result = await services.availability.getTimeSeries(input);
  const response = {
    id: randomUUID(),
    status: result.ok ? 'ok' : 'error',
    createdAt: new Date().toISOString(),
    dataSource: services.sapMode === 'mock' ? 'mock' : 'live',
    input,
    availableToday: result.ok ? availableOn(result.periods, today) : null,
    evidence: result,
  };
  audit?.record({ type: 'availability', correlationId: response.id, channel, input: { material: input.material, plant: input.plant }, calls: [callSummary(result)] });
  return response;
}

export async function lookupPlannedSupply(rawInput, { services, config, audit, channel = 'api' }) {
  const today = todayIso();
  const { input, missing, errors } = normalizeInput(rawInput, { defaultUnit: config.atp.defaultUnit, today, requireQuantity: false, requireDate: false });
  if (missing.length || errors.length) return { status: 'needs_input', missing, errors, input };
  const result = await services.plannedSupply.getPlannedSupply({ material: input.material, plant: input.plant, fromDate: today });
  const response = {
    id: randomUUID(),
    status: result.ok ? 'ok' : 'error',
    createdAt: new Date().toISOString(),
    dataSource: services.ompMode === 'mock' ? 'mock' : 'live',
    input,
    evidence: result,
  };
  audit?.record({ type: 'planned_supply', correlationId: response.id, channel, input: { material: input.material, plant: input.plant }, calls: [callSummary(result)] });
  return response;
}

const n = (v) => (v === null || v === undefined ? '-' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 }));

/** Plain-language summary used when AI Core is not configured, and given to the LLM as ground truth. */
export function summarizeAssessment(a) {
  const { input: i, outcome: o } = a;
  const subject = `${n(i.quantity)} ${i.unit} of material ${i.material} at plant ${i.plant} for ${i.requestedDate}`;
  const lines = [`**${a.rating} reliability - ${a.headline}.** ${subject}.`];
  if (o.coverage === 'full_on_time') lines.push(`aATP confirms the full quantity by ${o.confirmedDate}.`);
  else if (o.partialShipment) {
    const p = o.partialShipment;
    let text = `${n(p.nowQty)} ${i.unit} can ship by ${i.requestedDate}`;
    if (p.laterQty > 0) text += `, ${n(p.laterQty)} ${i.unit} on ${p.laterDate}`;
    if (p.unconfirmedQty > 0) text += `; ${n(p.unconfirmedQty)} ${i.unit} unconfirmed`;
    lines.push(`${text}.`);
  } else if (o.confirmedDate) lines.push(`The full quantity is confirmed for ${o.confirmedDate}, after the requested date.`);
  else if (a.drivers[0]) lines.push(a.drivers[0].text);
  lines.push(`**Recommended action:** ${a.recommendedAction}`);
  return lines.join('\n\n');
}
