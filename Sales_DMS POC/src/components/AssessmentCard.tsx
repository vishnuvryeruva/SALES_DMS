import { useState } from 'react';
import type { ApiCall, Assessment } from '../types';
import { dateTime, qty, shortDate } from '../format';
import AvailabilityChart from './AvailabilityChart';

const TONE_ICON = { positive: '✓', warning: '!', negative: '✕', info: 'i' } as const;

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="fact">
      <span className="fact-label">{label}</span>
      <span className="fact-value">{value}</span>
      {sub && <span className="fact-sub">{sub}</span>}
    </div>
  );
}

export function CallList({ calls }: { calls: ApiCall[] }) {
  return (
    <ul className="calls">
      {calls.map((c) => (
        <li key={c.api} className={c.skipped ? 'skipped' : c.ok ? 'ok' : 'failed'}>
          <span className="call-dot" />
          <span className="call-api">{c.api}</span>
          <span className="call-meta">
            {c.skipped ? 'skipped' : c.ok ? 'OK' : `${c.error?.kind ?? 'error'}${c.error?.status ? ` ${c.error.status}` : ''}`}
            {c.durationMs !== undefined && ` · ${c.durationMs} ms`}
          </span>
          {c.request?.path && <code className="call-path">{`${c.request.method} ${c.request.path}`}</code>}
          {!c.ok && c.error?.message && <span className="call-error">{c.error.message}</span>}
        </li>
      ))}
    </ul>
  );
}

export default function AssessmentCard({ assessment: a }: { assessment: Assessment }) {
  const [open, setOpen] = useState(false);
  const { input, outcome: o, evidence } = a;
  const unit = input.unit;
  const periods = evidence.availability.periods ?? [];
  const confirmations = evidence.atp.confirmations ?? [];
  const plannedOrders = evidence.plannedSupply.plannedOrders ?? [];
  const p = o.partialShipment;

  const partialText = p
    ? `${qty(p.nowQty)} now · ${p.laterQty > 0 ? `${qty(p.laterQty)} ${shortDate(p.laterDate)}` : '-'}`
    : o.coverage === 'full_on_time'
      ? 'Not needed'
      : '-';
  const partialSub = p?.unconfirmedQty ? `${qty(p.unconfirmedQty)} ${unit} unconfirmed` : undefined;

  return (
    <article className={`card rating-${a.rating.toLowerCase()}`}>
      <header className="card-head">
        <span className={`badge badge-${a.rating.toLowerCase()}`}>{a.rating}</span>
        <div className="card-title">
          <h3>{a.headline}</h3>
          <p>
            Material <strong>{input.material}</strong> · Plant <strong>{input.plant}</strong> · {qty(input.quantity)} {unit} by{' '}
            {shortDate(input.requestedDate)}
          </p>
        </div>
        <span className={`source source-${a.dataSource}`}>{a.dataSource === 'mock' ? 'Sample data' : 'Live SAP'}</span>
      </header>

      <div className="facts">
        <Fact
          label={`Confirmed by ${shortDate(o.requestedDate)}`}
          value={o.confirmedOnTimeQty === null ? '-' : `${qty(o.confirmedOnTimeQty)} / ${qty(o.requestedQty)} ${unit}`}
        />
        <Fact
          label="Full quantity confirmed"
          value={o.confirmedDate && o.shortfallQty === 0 ? shortDate(o.confirmedDate) : o.coverage === 'unverified' ? 'Not verified' : 'Not confirmable'}
          sub={o.shortfallQty ? `${qty(o.shortfallQty)} ${unit} short` : undefined}
        />
        <Fact label="Next available" value={o.nextAvailable ? shortDate(o.nextAvailable.date) : '-'} sub={o.nextAvailable?.source} />
        <Fact label={`Partial shipment (${unit})`} value={partialText} sub={partialSub} />
      </div>

      <div className="action">
        <span className="action-label">Recommended action</span>
        <p>{a.recommendedAction}</p>
      </div>

      {a.drivers.length > 0 && (
        <ul className="drivers">
          {a.drivers.map((d, i) => (
            <li key={i} className={`tone-${d.tone}`}>
              <span className="tone-icon">{TONE_ICON[d.tone]}</span>
              {d.text}
            </li>
          ))}
        </ul>
      )}

      <AvailabilityChart
        periods={periods}
        confirmations={confirmations}
        plannedOrders={plannedOrders}
        requestedQty={input.quantity ?? undefined}
        requestedDate={input.requestedDate ?? undefined}
        today={a.createdAt.slice(0, 10)}
        unit={unit}
      />

      <button className="evidence-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '▾' : '▸'} Evidence and assumptions
      </button>
      {open && (
        <div className="evidence">
          <section>
            <h4>API calls</h4>
            <CallList calls={[evidence.availability, evidence.atp, evidence.plannedSupply]} />
          </section>

          {confirmations.length > 0 && (
            <section>
              <h4>aATP confirmations (CheckAvailabilityWithoutResvn)</h4>
              <table className="mini">
                <thead>
                  <tr>
                    <th>Availability date</th>
                    <th className="num">Confirmed qty</th>
                  </tr>
                </thead>
                <tbody>
                  {confirmations.map((c, i) => (
                    <tr key={i}>
                      <td>{shortDate(c.date)}</td>
                      <td className="num">
                        {qty(c.qty)} {c.unit ?? unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {periods.length > 0 && (
            <section>
              <h4>Availability time series (DetmAvailabilityTimeSeries, MRP area {evidence.availability.mrpArea})</h4>
              <table className="mini">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>To</th>
                    <th className="num">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.slice(0, 12).map((pd, i) => (
                    <tr key={i}>
                      <td>{shortDate(pd.start)}</td>
                      <td>{pd.end && !pd.end.startsWith('9999') ? shortDate(pd.end) : 'open'}</td>
                      <td className="num">
                        {qty(pd.availableQty)} {pd.unit ?? unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {plannedOrders.length > 0 && (
            <section>
              <h4>OMP planned orders (not yet in SAP execution)</h4>
              <table className="mini">
                <thead>
                  <tr>
                    <th>Availability date</th>
                    <th className="num">Planned qty</th>
                  </tr>
                </thead>
                <tbody>
                  {plannedOrders.map((po, i) => (
                    <tr key={i}>
                      <td>{shortDate(po.availabilityDate)}</td>
                      <td className="num">
                        {qty(po.quantity)} {unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {a.assumptions.length > 0 && (
            <section>
              <h4>Assumptions</h4>
              <ul className="plain">
                {a.assumptions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </section>
          )}

          <details className="raw">
            <summary>Raw SAP responses</summary>
            <pre>{JSON.stringify({ availability: evidence.availability.raw, atp: evidence.atp.raw, omp: evidence.plannedSupply.raw }, null, 2)}</pre>
          </details>
        </div>
      )}

      <footer className="card-foot">
        <span>{a.disclaimer}</span>
        <span>
          {a.system} · {dateTime(a.createdAt)} · ref {a.id.slice(0, 8)}
        </span>
      </footer>
    </article>
  );
}
