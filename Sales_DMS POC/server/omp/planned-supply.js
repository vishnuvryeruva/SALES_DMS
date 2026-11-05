/**
 * OMP planned supply ("second call", Base MVP): time-phased projected available inventory plus
 * planned orders that are not yet in SAP execution.
 *
 * OMP has not published an API yet. This adapter targets the proposed contract in the README:
 *   GET {OMP_PROJECTION_PATH} -> { items: [{ material, plant, date, projectedAvailableInventory,
 *                                           plannedOrderQuantity, plannedOrderAvailabilityDate }] }
 * Planned supply is informational: it never raises a reliability rating.
 */
import { addDays, toIsoDate } from '../lib/dates.js';
import { UpstreamError } from '../http/transport.js';
import { sapErrorMessage } from '../sap/odata.js';

const API = 'OMP_PROJECTED_INVENTORY';

export function normalizeOmpItems(data) {
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.value) ? data.value : [];
  const projection = [];
  const plannedOrders = [];
  for (const item of items) {
    const date = toIsoDate(item.date ?? item.Date);
    const projected = Number(item.projectedAvailableInventory ?? item.ProjectedAvailableInventory);
    if (date && Number.isFinite(projected)) projection.push({ date, projectedAvailableInventory: projected });
    const plannedQty = Number(item.plannedOrderQuantity ?? item.PlannedOrderQuantity);
    const plannedDate = toIsoDate(item.plannedOrderAvailabilityDate ?? item.PlannedOrderAvailabilityDate);
    if (plannedQty > 0 && plannedDate) plannedOrders.push({ quantity: plannedQty, availabilityDate: plannedDate });
  }
  projection.sort((a, b) => a.date.localeCompare(b.date));
  plannedOrders.sort((a, b) => a.availabilityDate.localeCompare(b.availabilityDate));
  return { projection, plannedOrders };
}

export function createPlannedSupplyService({ transport, projectionPath, horizonDays, mode }) {
  return {
    api: API,
    mode,
    async getPlannedSupply({ material, plant, fromDate }) {
      if (mode === 'off' || !transport) {
        return { api: API, ok: false, skipped: true, error: { kind: 'disabled', message: 'OMP planned supply is not connected.' } };
      }
      const toDate = addDays(fromDate, horizonDays);
      const path = projectionPath
        .replace('{material}', encodeURIComponent(material))
        .replace('{plant}', encodeURIComponent(plant))
        .replace('{fromDate}', fromDate)
        .replace('{toDate}', toDate);
      const started = Date.now();
      const base = { api: API, request: { method: 'GET', path } };
      try {
        const res = await transport.request({ method: 'GET', path, headers: { Accept: 'application/json' } });
        if (res.status < 200 || res.status >= 300 || !res.data || typeof res.data !== 'object') {
          throw new UpstreamError(sapErrorMessage(res.data) || `HTTP ${res.status}`, { kind: 'request', status: res.status });
        }
        const normalized = normalizeOmpItems(res.data);
        return { ...base, ok: true, durationMs: Date.now() - started, retrievedAt: new Date().toISOString(), raw: res.data, ...normalized };
      } catch (err) {
        return {
          ...base,
          ok: false,
          durationMs: Date.now() - started,
          retrievedAt: new Date().toISOString(),
          error: { kind: err.kind || 'internal', status: err.status ?? null, message: err.message },
        };
      }
    },
  };
}
