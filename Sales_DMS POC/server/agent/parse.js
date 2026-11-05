/**
 * Deterministic extraction of material / plant / quantity / unit / requested date from a chat
 * message. Used when AI Core is not configured (and as a safety net when it fails).
 */
import { addDays } from '../lib/dates.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const UNIT_PATTERN = 'EA|EACH|PCS?|PIECES?|UNITS?|CS|CASES?|BX|BOX(?:ES)?|KG|PAL';

const pad = (n) => String(n).padStart(2, '0');

function isoFrom(year, month, day) {
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Year for a month/day given without one: this year, or next year if that date already passed. */
function inferYear(month, day, today) {
  const year = Number(today.slice(0, 4));
  const candidate = isoFrom(year, month, day);
  return candidate && candidate < today ? year + 1 : year;
}

function extractDate(text, today) {
  const rules = [
    [/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, (m) => isoFrom(+m[1], +m[2], +m[3])],
    [/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/, (m) => isoFrom(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2])],
    [/\b(\d{1,2})\/(\d{1,2})\b/, (m) => isoFrom(inferYear(+m[1], +m[2], today), +m[1], +m[2])],
    [
      new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i'),
      (m) => {
        const month = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)) + 1;
        return isoFrom(m[3] ? +m[3] : inferYear(month, +m[2], today), month, +m[2]);
      },
    ],
    [
      new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})[a-z]*\\.?(?:,?\\s+(\\d{4}))?\\b`, 'i'),
      (m) => {
        const month = MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)) + 1;
        return isoFrom(m[3] ? +m[3] : inferYear(month, +m[1], today), month, +m[1]);
      },
    ],
    [/\btoday\b/i, () => today],
    [/\btomorrow\b/i, () => addDays(today, 1)],
    [/\bin\s+(\d{1,3})\s+days?\b/i, (m) => addDays(today, +m[1])],
    [/\bin\s+(\d{1,2})\s+weeks?\b/i, (m) => addDays(today, 7 * +m[1])],
    [/\bnext\s+week\b/i, () => addDays(today, 7)],
    [
      new RegExp(`\\b(?:next|this|on)\\s+(${WEEKDAYS.join('|')})\\b`, 'i'),
      (m) => {
        const target = WEEKDAYS.indexOf(m[1].toLowerCase());
        const current = new Date(`${today}T00:00:00Z`).getUTCDay();
        return addDays(today, ((target - current + 7) % 7) || 7);
      },
    ],
  ];
  for (const [pattern, toIso] of rules) {
    const m = text.match(pattern);
    if (m) {
      const iso = toIso(m);
      if (iso) return { value: iso, span: m[0] };
    }
  }
  return null;
}

function take(state, pattern, group = 1) {
  const m = state.text.match(pattern);
  if (!m) return null;
  state.text = state.text.replace(m[0], ' ');
  return m[group];
}

export function detectIntent(message, fields = {}) {
  const t = message.toLowerCase();
  if (/^\s*(help|\?|what can you do|how does this work)/.test(t)) return 'help';
  if (/\b(sample|demo|test)\s+(materials?|data|scenarios?)\b|\bwhich materials\b|\blist materials\b/.test(t)) return 'catalog';
  if (/\b(omp|planned orders?|planned supply|projected (available )?inventory|future supply|pipeline)\b/.test(t)) return 'planned_supply';
  const asksAvailability = /\b(availability|available|how much|how many|stock|on hand|time series)\b/.test(t);
  const asksPromise = /\b(reliab\w*|promise\w*|confirm\w*|backorder\w*)\b/.test(t);
  if (asksAvailability && !asksPromise && fields.quantity === undefined) return 'availability';
  return 'assess';
}

/**
 * @returns {{ intent: string, fields: { material?, plant?, quantity?, unit?, requestedDate? } }}
 */
export function parseRequest(message, { today }) {
  const state = { text: ` ${message} ` };
  const fields = {};

  const date = extractDate(state.text, today);
  if (date) {
    fields.requestedDate = date.value;
    state.text = state.text.replace(date.span, ' ');
  }

  const material = take(state, /\b(?:material|matnr|product|item|sku|part)\s*(?:no\.?|number|#|:|=)?\s*([A-Z0-9][A-Z0-9\-_./]{2,39})/i);
  if (material) fields.material = material.toUpperCase();

  const plant = take(state, /\b(?:plant|dc|site|warehouse|werks)\s*(?:#|:|=)?\s*([A-Z0-9]{2,4})\b/i);
  if (plant) fields.plant = plant.toUpperCase();

  const qtyWithUnit = state.text.match(new RegExp(`\\b(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})\\b`, 'i'));
  if (qtyWithUnit) {
    fields.quantity = Number(qtyWithUnit[1].replace(/,/g, ''));
    fields.unit = qtyWithUnit[2].toUpperCase();
    state.text = state.text.replace(qtyWithUnit[0], ' ');
  } else {
    const qty = take(state, /\b(?:qty|quantity|quantities)\s*(?:of|:|=|is)?\s*(\d[\d,]*(?:\.\d+)?)/i);
    if (qty) fields.quantity = Number(qty.replace(/,/g, ''));
  }

  if (!fields.material) {
    const bare = take(state, /\b(\d{6,18})\b/);
    if (bare) fields.material = bare;
  }
  if (!fields.plant) {
    const atPlant = take(state, /\bat\s+([A-Z]{0,2}\d{2,4})\b/i);
    if (atPlant) fields.plant = atPlant.toUpperCase();
  }
  if (fields.quantity === undefined) {
    const forQty = take(state, /\b(?:for|of|need|needs|order|ordering|about|what about|what if)\s+(\d[\d,]*(?:\.\d+)?)\b/i);
    if (forQty) fields.quantity = Number(forQty.replace(/,/g, ''));
  }

  return { intent: detectIntent(message, fields), fields };
}
