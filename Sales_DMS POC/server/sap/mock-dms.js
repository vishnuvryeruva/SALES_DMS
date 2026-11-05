/**
 * Simulated DMS OTC MT2 system for local development and demos.
 *
 * Exposed as a transport so mock mode runs the same OData client, CSRF handling and response
 * normalizers as live mode. Responses use the field names of the S/4HANA services:
 *   API_PRODUCT_AVAILY_INFO     ProductMRPArea(...)/SAP__self.DetmAvailabilityTimeSeries
 *   API_AVAIL_TO_PROMISE_CHECK  RlvtProductPlant(...)/SAP__self.CheckAvailabilityWithoutResvn
 * and the proposed OMP projected-inventory contract (see README).
 *
 * All dates are relative to "today" so the scenarios never go stale.
 */
import { addDays, todayIso, toIsoDate } from '../lib/dates.js';

export const MOCK_CATALOG = [
  {
    material: '1000001',
    plant: '1000',
    description: 'Surgical stapler reload, 60 mm (sample)',
    unit: 'EA',
    stock: 1200,
    receipts: [{ inDays: 14, qty: 500 }],
    plannedOrders: [{ inDays: 35, qty: 800 }],
    scenario: 'Healthy stock - full confirmation on the requested date',
    example: { quantity: 50, inDays: 7 },
  },
  {
    material: '1000002',
    plant: '1000',
    description: 'Titanium bone screw 4.5 mm (sample)',
    unit: 'EA',
    stock: 8,
    receipts: [{ inDays: 12, qty: 40 }],
    plannedOrders: [{ inDays: 30, qty: 100 }],
    scenario: 'Low stock, inbound receipt in ~2 weeks - partial confirmation',
    example: { quantity: 20, inDays: 5 },
  },
  {
    material: '1000003',
    plant: '1000',
    description: 'Tibial insert, size 5 (sample)',
    unit: 'EA',
    stock: 0,
    receipts: [{ inDays: 9, qty: 60 }],
    plannedOrders: [],
    scenario: 'Backordered - full quantity confirmed on a later date',
    example: { quantity: 10, inDays: 3 },
  },
  {
    material: '1000004',
    plant: '1000',
    description: 'Absorbable suture 3-0, box of 36 (sample)',
    unit: 'EA',
    stock: 500,
    receipts: [],
    plannedOrders: [],
    allocationCap: 25,
    scenario: 'Stock on hand but product allocation caps the confirmation',
    example: { quantity: 60, inDays: 4 },
  },
  {
    material: '1000005',
    plant: '1000',
    description: 'Acetabular shell, 52 mm (sample)',
    unit: 'EA',
    stock: 0,
    receipts: [],
    plannedOrders: [{ inDays: 45, qty: 30 }],
    scenario: 'No supply in SAP - only an OMP planned order',
    example: { quantity: 5, inDays: 10 },
  },
  {
    material: '1000006',
    plant: '2000',
    description: 'Spinal rod 5.5 x 480 mm (sample)',
    unit: 'EA',
    stock: 300,
    receipts: [],
    plannedOrders: [],
    atpFailureStatus: 503,
    scenario: 'aATP service unavailable - fail-safe handling',
    example: { quantity: 15, inDays: 6 },
  },
  {
    material: '1000007',
    plant: '1000',
    description: 'Wound closure strip kit (sample)',
    unit: 'EA',
    stock: 100,
    receipts: [],
    plannedOrders: [],
    availabilityOffset: -70,
    scenario: 'ATP confirms, but the availability snapshot shows less - documented assumption',
    example: { quantity: 50, inDays: 5 },
  },
];

function findEntry(material, plantOrMrpArea) {
  return MOCK_CATALOG.find((e) => e.material === material && e.plant === plantOrMrpArea) || null;
}

function supply(entry, today) {
  const receipts = entry.receipts
    .map((r) => ({ date: addDays(today, r.inDays), qty: r.qty }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const availableOn = (date) => entry.stock + receipts.filter((r) => r.date <= date).reduce((s, r) => s + r.qty, 0);
  return { receipts, availableOn };
}

export function mockTimeSeries(entry, today = todayIso()) {
  const { receipts, availableOn } = supply(entry, today);
  const starts = [today, ...receipts.map((r) => r.date).filter((d) => d > today)];
  const unique = [...new Set(starts)];
  return unique.map((start, i) => ({
    ProdAvailyPerdStrtUTCDteTme: `${start}T00:00:00Z`,
    ProdAvailyPerdStrtTimeZone: 'UTC',
    ProdAvailyPerdEndUTCDteTme: unique[i + 1] ? `${unique[i + 1]}T00:00:00Z` : '9999-12-31T23:59:59Z',
    ProdAvailyPerdEndTimeZone: 'UTC',
    AvailableQuantityInBaseUnit: Math.max(0, availableOn(start) + (entry.availabilityOffset || 0)),
    BaseUnit: entry.unit,
    BaseUnitISOCode: entry.unit,
  }));
}

export function mockAtpConfirmations(entry, quantity, requestedDateTime, today = todayIso()) {
  const { receipts, availableOn } = supply(entry, today);
  const requested = toIsoDate(requestedDateTime);
  const checkDate = requested < today ? today : requested;
  const time = String(requestedDateTime).slice(10) || 'T18:00:00Z';
  const cap = entry.allocationCap ?? Infinity;
  const lines = [];
  let confirmed = 0;

  const first = Math.min(quantity, availableOn(checkDate), cap);
  if (first > 0) {
    lines.push({ date: checkDate, qty: first });
    confirmed += first;
  }
  for (const receipt of receipts.filter((r) => r.date > checkDate)) {
    if (confirmed >= quantity || confirmed >= cap) break;
    const qty = Math.min(quantity - confirmed, availableOn(receipt.date) - confirmed, cap - confirmed);
    if (qty > 0) {
      lines.push({ date: receipt.date, qty });
      confirmed += qty;
    }
  }
  if (lines.length === 0) lines.push({ date: checkDate, qty: 0 });

  return lines.map((l) => ({
    ConfirmedQuantityInBaseUnit: l.qty,
    BaseUnit: entry.unit,
    ConfdProdAvailabilityUTCDteTme: `${l.date}${time}`,
    ConfdProdAvailabilityTimeZone: 'UTC',
  }));
}

export function mockOmpItems(entry, fromDate, toDate, today = todayIso()) {
  const { availableOn } = supply(entry, today);
  const planned = entry.plannedOrders.map((p) => ({ date: addDays(today, p.inDays), qty: p.qty }));
  const projected = (date) => availableOn(date) + planned.filter((p) => p.date <= date).reduce((s, p) => s + p.qty, 0);

  const items = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 7)) {
    items.push({ date, plannedOrderQuantity: 0, plannedOrderAvailabilityDate: null });
  }
  for (const p of planned.filter((p) => p.date >= fromDate && p.date <= toDate)) {
    items.push({ date: p.date, plannedOrderQuantity: p.qty, plannedOrderAvailabilityDate: p.date });
  }
  return items
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((item) => ({
      material: entry.material,
      plant: entry.plant,
      ...item,
      projectedAvailableInventory: projected(item.date),
    }));
}

const json = (status, data, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  setCookies: status === 200 && headers['x-csrf-token'] ? ['SAP_SESSIONID_MOCK=mock-session; path=/'] : [],
  data,
});
const sapError = (status, code, message) => json(status, { error: { code, message } });

const KEY_PATTERN = /^(ProductMRPArea|RlvtProductPlant)\(Product='((?:[^']|'')*)',(MRPArea|Plant)='((?:[^']|'')*)'\)\/SAP__self\.(\w+)$/;

/**
 * @param {{ availabilityServicePath: string, atpServicePath: string, ompProjectionPath: string }} paths
 * @param {{ latencyMs?: number, now?: () => Date }} [options]
 */
export function createMockTransport(paths, { latencyMs = 150, now = () => new Date() } = {}) {
  const ompPathname = paths.ompProjectionPath.split('?')[0];

  async function handle({ method, path, headers: rawHeaders = {}, body }) {
    const headers = Object.fromEntries(Object.entries(rawHeaders).map(([k, v]) => [k.toLowerCase(), v]));
    const today = todayIso(now());
    const [pathname, search = ''] = path.split('?');
    const params = new URLSearchParams(search);

    if (pathname === ompPathname) {
      const entry = findEntry(params.get('material'), params.get('plant'));
      if (!entry) return json(200, { items: [] });
      return json(200, { items: mockOmpItems(entry, params.get('fromDate') || today, params.get('toDate') || addDays(today, 90), today) });
    }

    const service = [paths.availabilityServicePath, paths.atpServicePath].find((p) => pathname.startsWith(p));
    if (!service) return sapError(404, '/IWFND/MED/170', `No service found for namespace, name, version for ${pathname}`);
    const rest = decodeURIComponent(pathname.slice(service.length));

    if (method === 'GET' && rest === '') {
      const entitySet = service === paths.atpServicePath ? 'RlvtProductPlant' : 'ProductMRPArea';
      const csrfHeaders = String(headers['x-csrf-token'] || '').toLowerCase() === 'fetch' ? { 'x-csrf-token': 'mock-csrf-token' } : {};
      return json(200, { '@odata.context': '$metadata', value: [{ name: entitySet, url: entitySet }] }, csrfHeaders);
    }

    if (method !== 'POST') return sapError(405, 'METHOD_NOT_ALLOWED', `${method} not supported on ${rest}`);
    if (headers['x-csrf-token'] !== 'mock-csrf-token') {
      return { status: 403, headers: { 'x-csrf-token': 'Required' }, setCookies: [], data: 'CSRF token validation failed' };
    }

    const match = rest.match(KEY_PATTERN);
    if (!match) return sapError(400, 'INVALID_URI', `Resource not found for segment '${rest}'`);
    const [, entitySet, rawProduct, , rawLocation, action] = match;
    const product = rawProduct.replace(/''/g, "'");
    const location = rawLocation.replace(/''/g, "'");
    const entry = findEntry(product, location);

    if (entitySet === 'ProductMRPArea' && action === 'DetmAvailabilityTimeSeries') {
      if (!body?.ATPCheckingRule) return sapError(400, 'MISSING_PARAMETER', 'Parameter ATPCheckingRule is mandatory');
      if (!entry) return sapError(404, 'NOT_FOUND', `Product ${product} is not planned in MRP area ${location}`);
      return json(200, { '@odata.context': '$metadata#Collection(...)', value: mockTimeSeries(entry, today) });
    }

    if (entitySet === 'RlvtProductPlant' && action === 'CheckAvailabilityWithoutResvn') {
      if (!entry) return sapError(404, 'NOT_FOUND', `Product ${product} does not exist in plant ${location}`);
      if (entry.atpFailureStatus) return sapError(entry.atpFailureStatus, 'SERVICE_UNAVAILABLE', 'aATP engine temporarily unavailable');
      const quantity = Number(body?.RequestedQuantityInBaseUnit);
      if (!Number.isFinite(quantity) || quantity <= 0) return sapError(400, 'INVALID_QUANTITY', 'RequestedQuantityInBaseUnit must be positive');
      if (body.BaseUnit && body.BaseUnit !== entry.unit) {
        return sapError(400, 'UNIT_NOT_DEFINED', `Unit ${body.BaseUnit} is not defined for product ${product} (base unit ${entry.unit})`);
      }
      if (!toIsoDate(body.ProductAvailabilityUTCDateTime)) return sapError(400, 'INVALID_DATE', 'ProductAvailabilityUTCDateTime is invalid');
      return json(200, {
        '@odata.context': '$metadata#Collection(...)',
        value: mockAtpConfirmations(entry, quantity, body.ProductAvailabilityUTCDateTime, today),
      });
    }

    return sapError(400, 'UNKNOWN_ACTION', `Action ${action} is not bound to ${entitySet}`);
  }

  return {
    describe: () => ({ mode: 'mock', target: 'Simulated DMS OTC MT2 (sample data)' }),
    async request(req) {
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      return handle(req);
    },
  };
}

export function mockCatalogForUi(now = new Date()) {
  const today = todayIso(now);
  return MOCK_CATALOG.map((e) => ({
    material: e.material,
    plant: e.plant,
    description: e.description,
    unit: e.unit,
    scenario: e.scenario,
    exampleQuantity: e.example.quantity,
    exampleDate: addDays(today, e.example.inDays),
  }));
}
