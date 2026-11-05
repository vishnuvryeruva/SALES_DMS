/**
 * Deterministic reliability rules from the "Joule Backorder Reliability Agent" proposal.
 *
 *   High   - ATP confirms the requested quantity on/before the requested date, with no material
 *            gap between the availability and ATP responses.
 *   Medium - partial quantity, a later date, or a result that requires a documented assumption.
 *   Low    - no feasible confirmation, incomplete/inconsistent responses, an API is unavailable,
 *            or required inputs are missing.
 *
 * OMP planned supply is informational only and never raises a rating.
 */
import { availableOn, firstDateWithQty } from './sap/services.js';

export const ACTIONS = {
  High: 'Promise appears supportable; communicate the confirmed date with standard monitoring.',
  Medium: 'Communicate the constraint, propose the feasible quantity or date, and monitor for change.',
  Low: 'Escalate for planner or order-management review; do not communicate an unverified promise.',
};

const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 3 }));

function plannedSupplyDrivers(plannedSupply, unit) {
  if (!plannedSupply) return [];
  if (!plannedSupply.ok) {
    return [{ tone: 'info', text: `OMP planned supply not available (${plannedSupply.error?.message || 'not connected'}); rating uses SAP data only.` }];
  }
  if (plannedSupply.plannedOrders.length === 0) return [{ tone: 'info', text: 'OMP shows no planned orders in the horizon.' }];
  return plannedSupply.plannedOrders.slice(0, 2).map((p) => ({
    tone: 'info',
    text: `OMP planned order: ${fmt(p.quantity)} ${unit} available ${p.availabilityDate} (not yet in SAP execution).`,
  }));
}

function ompCoverageDate(plannedSupply, quantity, afterDate) {
  if (!plannedSupply?.ok) return null;
  const hit = plannedSupply.projection.find((p) => p.date > afterDate && p.projectedAvailableInventory >= quantity);
  return hit?.date || null;
}

/**
 * @param {object} args
 * @param {object} args.input        normalized request (material, plant, quantity, unit, requestedDate)
 * @param {object} args.availability result of the Product Availability call
 * @param {object} args.atp          result of the Advanced ATP check
 * @param {object} [args.plannedSupply] result of the OMP call
 * @param {{ gapTolerancePct: number }} args.rules
 */
export function evaluateReliability({ input, availability, atp, plannedSupply, rules }) {
  const { quantity: q, requestedDate: d, unit } = input;
  const drivers = [];
  const assumptions = [];
  const omp = plannedSupplyDrivers(plannedSupply, unit);

  const outcome = {
    requestedQty: q,
    requestedDate: d,
    unit,
    confirmedQty: atp.ok ? atp.totalConfirmed : null,
    confirmedOnTimeQty: atp.ok ? atp.confirmedByRequestedDate : null,
    confirmedDate: null,
    shortfallQty: null,
    availableOnRequestedDate: null,
    nextAvailable: null,
    partialShipment: null,
    coverage: 'unverified',
  };

  const low = (headline, reasons) => ({
    rating: 'Low',
    headline,
    drivers: [...reasons.map((text) => ({ tone: 'negative', text })), ...drivers, ...omp],
    assumptions,
    recommendedAction: ACTIONS.Low,
    outcome,
  });

  if (!atp.ok) return low('Promise cannot be verified', [`Advanced ATP check failed: ${atp.error.message}`]);
  if (!availability.ok) return low('Promise cannot be verified', [`Product availability call failed: ${availability.error.message}`]);
  if (atp.rowCount === 0 || atp.incomplete) return low('Promise cannot be verified', ['The ATP response is incomplete (missing confirmed quantity or date).']);
  if (availability.periods.length === 0) return low('Promise cannot be verified', ['The availability response contains no time series.']);
  if (availability.unit && atp.unit && availability.unit !== atp.unit) {
    return low('Responses are inconsistent', [`Availability is in ${availability.unit} but ATP confirmed in ${atp.unit}.`]);
  }
  if (atp.totalConfirmed > q * 1.000001) {
    return low('Responses are inconsistent', [`ATP confirmed ${fmt(atp.totalConfirmed)} ${unit}, more than the ${fmt(q)} ${unit} requested.`]);
  }

  const availableAtD = availableOn(availability.periods, d);
  outcome.availableOnRequestedDate = availableAtD;
  outcome.shortfallQty = Math.max(0, q - atp.totalConfirmed);

  if (atp.totalConfirmed <= 0) {
    outcome.coverage = 'none';
    const ompDate = ompCoverageDate(plannedSupply, q, d);
    if (ompDate) outcome.nextAvailable = { date: ompDate, source: 'OMP projection (planned supply, indicative)' };
    return low('No feasible confirmation', [
      `aATP cannot confirm any of the ${fmt(q)} ${unit} requested for ${d}.`,
      availableAtD !== null ? `Availability on ${d}: ${fmt(availableAtD)} ${unit}.` : `The availability time series does not cover ${d}.`,
    ]);
  }

  const onTime = atp.confirmedByRequestedDate;
  const expectedOnTime = availableAtD === null ? null : Math.min(q, availableAtD);
  const gapQty = expectedOnTime === null ? null : Math.abs(expectedOnTime - onTime);
  const materialGap = gapQty === null || gapQty > (q * rules.gapTolerancePct) / 100;
  const later = atp.confirmations.filter((c) => c.date > d);

  if (onTime >= q) {
    outcome.coverage = 'full_on_time';
    outcome.confirmedDate = atp.confirmations.filter((c) => c.date <= d).at(-1)?.date || d;
    drivers.push({ tone: 'positive', text: `aATP confirms the full ${fmt(q)} ${unit} by ${d}.` });
    if (!materialGap) {
      drivers.push({ tone: 'positive', text: `Availability on ${d} (${fmt(availableAtD)} ${unit}) is consistent with the ATP result.` });
      return { rating: 'High', headline: 'Promise appears supportable', drivers: [...drivers, ...omp], assumptions, recommendedAction: ACTIONS.High, outcome };
    }
    const gapText =
      availableAtD === null
        ? `The availability time series does not cover ${d}, so the ATP result cannot be cross-checked.`
        : `The availability snapshot shows only ${fmt(availableAtD)} ${unit} on ${d} - a gap of ${fmt(gapQty)} ${unit} versus the ATP confirmation.`;
    drivers.push({ tone: 'warning', text: gapText });
    assumptions.push('The ATP confirmation is relied on although the availability snapshot does not fully support it (for example a stale snapshot or different stock scope).');
    return {
      rating: 'Medium',
      headline: 'Supportable with a documented assumption',
      drivers: [...drivers, ...omp],
      assumptions,
      recommendedAction: `${ACTIONS.Medium} Treat ${outcome.confirmedDate} as provisional until the planner confirms the gap.`,
      outcome,
    };
  }

  // Partial or late
  if (atp.totalConfirmed >= q) {
    outcome.confirmedDate = atp.lastConfirmationDate;
    outcome.nextAvailable = { date: atp.lastConfirmationDate, source: 'aATP confirmation' };
  } else if (availableAtD === null || availableAtD < q) {
    const fromSeries = firstDateWithQty(availability.periods, q, d);
    const ompDate = ompCoverageDate(plannedSupply, q, d);
    if (fromSeries && fromSeries > d) outcome.nextAvailable = { date: fromSeries, source: 'availability time series (indicative)' };
    else if (ompDate) outcome.nextAvailable = { date: ompDate, source: 'OMP projection (planned supply, indicative)' };
  }

  if (onTime > 0) {
    outcome.coverage = 'partial';
    outcome.partialShipment = {
      nowQty: onTime,
      nowDate: d,
      laterQty: atp.totalConfirmed - onTime,
      laterDate: later.at(-1)?.date || null,
      unconfirmedQty: outcome.shortfallQty,
    };
    drivers.push({ tone: 'warning', text: `Only ${fmt(onTime)} of ${fmt(q)} ${unit} can be confirmed by ${d}.` });
  } else {
    outcome.coverage = atp.totalConfirmed >= q ? 'full_late' : 'partial';
    drivers.push({ tone: 'warning', text: `Nothing can be confirmed by ${d}; the first confirmation is ${atp.confirmations[0].date}.` });
  }
  for (const c of later) drivers.push({ tone: 'info', text: `${fmt(c.qty)} ${unit} confirmed for ${c.date}.` });
  if (outcome.shortfallQty > 0) {
    drivers.push({ tone: 'warning', text: `${fmt(outcome.shortfallQty)} ${unit} cannot be confirmed in the ATP horizon.` });
  }
  if (availableAtD !== null && availableAtD >= q && onTime < q) {
    drivers.push({
      tone: 'warning',
      text: `Availability shows ${fmt(availableAtD)} ${unit} on ${d}, but aATP confirms less - product allocation or supply protection is likely limiting the confirmation.`,
    });
  } else if (availableAtD !== null && onTime - availableAtD > (q * rules.gapTolerancePct) / 100) {
    drivers.push({ tone: 'warning', text: `aATP confirms more by ${d} than the availability snapshot shows (${fmt(availableAtD)} ${unit}).` });
    assumptions.push('The ATP confirmation is relied on although the availability snapshot shows less on the requested date.');
  }

  let action = ACTIONS.Medium;
  if (outcome.partialShipment) {
    const p = outcome.partialShipment;
    action += ` Offer ${fmt(p.nowQty)} ${unit} by ${d}`;
    if (p.laterQty > 0) action += ` and ${fmt(p.laterQty)} ${unit} on ${p.laterDate}`;
    if (p.unconfirmedQty > 0) action += `; ${fmt(p.unconfirmedQty)} ${unit} remain unconfirmed`;
    action += '.';
  } else if (outcome.confirmedDate) {
    action += ` Propose ${outcome.confirmedDate} for the full ${fmt(q)} ${unit}.`;
  } else {
    action += ` Offer ${fmt(atp.totalConfirmed)} ${unit} on ${atp.confirmations[0].date}; ${fmt(outcome.shortfallQty)} ${unit} remain unconfirmed.`;
  }

  return {
    rating: 'Medium',
    headline: outcome.partialShipment ? 'Partial quantity on the requested date' : 'Feasible on a later date',
    drivers: [...drivers, ...omp],
    assumptions,
    recommendedAction: action,
    outcome,
  };
}
