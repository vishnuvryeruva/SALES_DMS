import { keyLiteral } from './odata.js';
import { toIsoDate } from '../lib/dates.js';

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

function characteristicsPayload(names, values) {
  return names.map((name) => ({ CharcCatalogCharacteristicName: name, CharcCatalogCharcValue: values[name] ?? '' }));
}

/** Maps request fields to the characteristic catalog names used by aATP (supply protection / allocation). */
export function characteristicValues(input) {
  return {
    'SD-CUSTOMERGROUP': input.customerGroup || '',
    'SD_I-SHIPPINGPOINT': input.shippingPoint || '',
    'SD-SALESDOCUMENTTYPE': input.salesDocumentType || '',
    'SD_I_PAR_PF.WE-CUSTOMER': input.shipToCustomer || '',
    'SD-DISTRIBUTIONCHANNEL': input.distributionChannel || '',
  };
}

async function timed(api, request, fn) {
  const started = Date.now();
  try {
    const data = await fn();
    return { api, ok: true, durationMs: Date.now() - started, retrievedAt: new Date().toISOString(), request, data };
  } catch (err) {
    return {
      api,
      ok: false,
      durationMs: Date.now() - started,
      retrievedAt: new Date().toISOString(),
      request,
      error: { kind: err.kind || 'internal', status: err.status ?? null, message: err.message },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// API_PRODUCT_AVAILY_INFO - "How much is available?"
// ---------------------------------------------------------------------------------------------

export function normalizeTimeSeries(data) {
  const rows = Array.isArray(data?.value) ? data.value : [];
  return rows
    .map((r) => ({
      start: toIsoDate(r.ProdAvailyPerdStrtUTCDteTme ?? r.PeriodStartUTCDateTime),
      end: toIsoDate(r.ProdAvailyPerdEndUTCDteTme ?? r.PeriodEndUTCDateTime),
      availableQty: num(r.AvailableQuantityInBaseUnit),
      unit: r.BaseUnit || null,
    }))
    .filter((p) => p.start && Number.isFinite(p.availableQty))
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** Available quantity in the period containing `date`; null when the series does not cover it. */
export function availableOn(periods, date) {
  const period = periods.find((p) => p.start <= date && (!p.end || date < p.end));
  return period ? period.availableQty : null;
}

/** First date (>= fromDate) on which the series shows at least `qty`; null if never within the series. */
export function firstDateWithQty(periods, qty, fromDate) {
  for (const p of periods) {
    if (p.end && p.end <= fromDate) continue;
    if (p.availableQty >= qty) return p.start > fromDate ? p.start : fromDate;
  }
  return null;
}

export function createAvailabilityService({ odata, servicePath, atpConfig }) {
  const api = 'API_PRODUCT_AVAILY_INFO';
  return {
    api,
    async getTimeSeries(input) {
      const mrpArea = input.mrpArea || input.plant;
      const actionPath = `ProductMRPArea(Product=${keyLiteral(input.material)},MRPArea=${keyLiteral(mrpArea)})/SAP__self.DetmAvailabilityTimeSeries`;
      const body = { ATPCheckingRule: input.atpCheckingRule || atpConfig.checkingRule };
      if (atpConfig.availabilityCharacteristicNames.length > 0) {
        body._DocumentAttributes = {
          ATPRelevantDocumentPurpose: atpConfig.documentPurpose,
          _Characteristics: characteristicsPayload(atpConfig.availabilityCharacteristicNames, characteristicValues(input)),
        };
      }
      const result = await timed(api, { method: 'POST', path: servicePath + actionPath, body }, () =>
        odata.postAction(servicePath, actionPath, body)
      );
      if (!result.ok) return result;
      const periods = normalizeTimeSeries(result.data);
      return { ...result, raw: result.data, data: undefined, mrpArea, periods, unit: periods[0]?.unit || null };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// API_AVAIL_TO_PROMISE_CHECK - "How much could I get?" (simulation, no reservation)
// ---------------------------------------------------------------------------------------------

export function normalizeConfirmations(data) {
  const rows = Array.isArray(data?.value) ? data.value : data && typeof data === 'object' && !data.error ? [data] : [];
  const parsed = rows.map((r) => ({
    qty: num(r.ConfirmedQuantityInBaseUnit ?? r.ConfirmedQuantity),
    date: toIsoDate(r.ConfdProdAvailabilityUTCDteTme ?? r.ConfirmedProdAvailabilityUTCDateTime ?? r.ConfirmedDate),
    unit: r.BaseUnit || null,
  }));
  return {
    rowCount: rows.length,
    incomplete: parsed.some((c) => !Number.isFinite(c.qty) || (c.qty > 0 && !c.date)),
    confirmations: parsed.filter((c) => Number.isFinite(c.qty) && c.qty > 0 && c.date).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function createAtpService({ odata, servicePath, atpConfig }) {
  const api = 'API_AVAIL_TO_PROMISE_CHECK';
  return {
    api,
    async check(input) {
      const actionPath = `RlvtProductPlant(Product=${keyLiteral(input.material)},Plant=${keyLiteral(input.plant)})/SAP__self.CheckAvailabilityWithoutResvn`;
      const body = {
        ATPCheckingRule: input.atpCheckingRule || atpConfig.checkingRule,
        RequestedQuantityInBaseUnit: input.quantity,
        BaseUnit: input.unit,
        ProdAllocIsToBeConsidered: atpConfig.considerProductAllocation,
        ProductAvailabilityUTCDateTime: `${input.requestedDate}T${atpConfig.requestTimeUtc}Z`,
        _DocumentAttributes: {
          ATPRelevantDocumentPurpose: atpConfig.documentPurpose,
          _Characteristics: characteristicsPayload(atpConfig.characteristicNames, characteristicValues(input)),
        },
      };
      const result = await timed(api, { method: 'POST', path: servicePath + actionPath, body }, () =>
        odata.postAction(servicePath, actionPath, body)
      );
      if (!result.ok) return result;
      const normalized = normalizeConfirmations(result.data);
      const confirmations = normalized.confirmations;
      const total = confirmations.reduce((s, c) => s + c.qty, 0);
      const onTime = confirmations.filter((c) => c.date <= input.requestedDate).reduce((s, c) => s + c.qty, 0);
      return {
        ...result,
        raw: result.data,
        data: undefined,
        rowCount: normalized.rowCount,
        incomplete: normalized.incomplete,
        confirmations,
        totalConfirmed: total,
        confirmedByRequestedDate: onTime,
        lastConfirmationDate: confirmations.at(-1)?.date || null,
        unit: confirmations[0]?.unit || input.unit,
      };
    },
  };
}
