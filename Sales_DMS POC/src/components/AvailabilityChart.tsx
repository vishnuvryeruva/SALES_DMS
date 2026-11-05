import type { Confirmation, Period } from '../types';
import { qty } from '../format';

interface Props {
  periods: Period[];
  confirmations: Confirmation[];
  plannedOrders: { quantity: number; availabilityDate: string }[];
  requestedQty?: number;
  requestedDate?: string;
  today: string;
  unit: string;
}

const W = 640;
const H = 190;
const PAD = { left: 44, right: 16, top: 14, bottom: 28 };
const DAY = 86_400_000;

const toMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const label = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Step chart: SAP available quantity over time, cumulative aATP confirmations, requested qty/date and OMP planned orders. */
export default function AvailabilityChart({ periods, confirmations, plannedOrders, requestedQty, requestedDate, today, unit }: Props) {
  if (!periods.length && !confirmations.length) return null;

  const t0 = toMs(today);
  const marks = [
    requestedDate && toMs(requestedDate),
    ...confirmations.map((c) => toMs(c.date)),
    ...periods.map((p) => toMs(p.start)),
  ].filter((v): v is number => typeof v === 'number' && v >= t0);
  const latestPlanned = plannedOrders.map((p) => toMs(p.availabilityDate)).filter((v) => v >= t0);
  const t1 = Math.max(t0 + 21 * DAY, ...marks, ...latestPlanned.slice(0, 2)) + 7 * DAY;

  let cumulative = 0;
  const cumulativePoints = [...confirmations]
    .filter((c) => c.qty > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((c) => ({ t: toMs(c.date), v: (cumulative += c.qty) }));

  const q = requestedQty ?? 0;
  const maxAvail = Math.max(0, ...periods.map((p) => p.availableQty));
  const yMax = Math.max(q * 1.35, cumulative * 1.2, Math.min(maxAvail, Math.max(q, 1) * 4) * 1.1, 1);

  const x = (t: number) => PAD.left + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - Math.min(Math.max(v, 0), yMax) / yMax) * (H - PAD.top - PAD.bottom);

  const steps = periods
    .filter((p) => !p.end || toMs(p.end) > t0)
    .map((p) => ({ from: Math.max(toMs(p.start), t0), to: p.end ? toMs(p.end) : t1, v: p.availableQty }));
  let availPath = '';
  steps.forEach((s, i) => {
    const cmd = i === 0 ? 'M' : 'L';
    availPath += `${cmd}${x(s.from)},${y(s.v)} L${x(Math.min(s.to, t1))},${y(s.v)} `;
  });
  const availArea = steps.length ? `${availPath} L${x(Math.min(steps[steps.length - 1].to, t1))},${y(0)} L${x(steps[0].from)},${y(0)} Z` : '';

  let confPath = '';
  if (cumulativePoints.length) {
    confPath = `M${x(t0)},${y(0)} `;
    let prev = 0;
    for (const p of cumulativePoints) {
      confPath += `L${x(p.t)},${y(prev)} L${x(p.t)},${y(p.v)} `;
      prev = p.v;
    }
    confPath += `L${x(t1)},${y(prev)}`;
  }

  const ticks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4);
  const clipped = maxAvail > yMax;

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Availability and ATP confirmations over time">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(yMax * f)} y2={y(yMax * f)} className="grid" />
            <text x={PAD.left - 6} y={y(yMax * f) + 4} className="axis" textAnchor="end">
              {qty(Math.round(yMax * f))}
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={H - 8} className="axis" textAnchor="middle">
            {label(t)}
          </text>
        ))}

        {availArea && <path d={availArea} className="avail-area" />}
        {availPath && <path d={availPath} className="avail-line" />}
        {confPath && <path d={confPath} className="conf-line" />}
        {cumulativePoints.map((p) => (
          <circle key={p.t} cx={x(p.t)} cy={y(p.v)} r={4} className="conf-dot" />
        ))}

        {q > 0 && (
          <>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(q)} y2={y(q)} className="req-line" />
            <text x={W - PAD.right} y={y(q) - 5} className="req-label" textAnchor="end">
              requested {qty(q)} {unit}
            </text>
          </>
        )}
        {requestedDate && (
          <>
            <line x1={x(toMs(requestedDate))} x2={x(toMs(requestedDate))} y1={PAD.top} y2={H - PAD.bottom} className="req-line" />
            <text x={x(toMs(requestedDate)) + 4} y={PAD.top + 10} className="req-label">
              requested date
            </text>
          </>
        )}

        {plannedOrders
          .filter((p) => toMs(p.availabilityDate) <= t1)
          .map((p) => {
            const px = x(toMs(p.availabilityDate));
            const py = H - PAD.bottom;
            return (
              <g key={p.availabilityDate + p.quantity}>
                <path d={`M${px},${py - 9} L${px + 6},${py} L${px - 6},${py} Z`} className="omp-mark" />
                <title>{`OMP planned order: ${qty(p.quantity)} ${unit} on ${p.availabilityDate}`}</title>
              </g>
            );
          })}
      </svg>
      <figcaption>
        <span className="key key-avail" /> Available (SAP){clipped && ` - axis capped, max ${qty(maxAvail)}`}
        <span className="key key-conf" /> aATP confirmed (cumulative)
        <span className="key key-req" /> Requested
        {plannedOrders.length > 0 && (
          <>
            <span className="key key-omp" /> OMP planned order
          </>
        )}
      </figcaption>
    </figure>
  );
}
