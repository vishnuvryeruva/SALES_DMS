import type { AvailabilityLookup, PlannedSupplyLookup } from '../types';
import { dateTime, qty, shortDate } from '../format';
import AvailabilityChart from './AvailabilityChart';
import { CallList } from './AssessmentCard';

export function AvailabilityCard({ lookup: l }: { lookup: AvailabilityLookup }) {
  const e = l.evidence;
  const unit = e.unit ?? l.input.unit;
  return (
    <article className="card card-lookup">
      <header className="card-head">
        <span className="badge badge-info">Availability</span>
        <div className="card-title">
          <h3>
            {e.ok ? `${qty(l.availableToday ?? 0)} ${unit} available today` : 'Availability could not be retrieved'}
          </h3>
          <p>
            Material <strong>{l.input.material}</strong> · MRP area <strong>{e.mrpArea ?? l.input.plant}</strong>
          </p>
        </div>
        <span className={`source source-${l.dataSource}`}>{l.dataSource === 'mock' ? 'Sample data' : 'Live SAP'}</span>
      </header>
      {e.ok && (
        <AvailabilityChart periods={e.periods ?? []} confirmations={[]} plannedOrders={[]} today={l.createdAt.slice(0, 10)} unit={unit} />
      )}
      <CallList calls={[e]} />
      <footer className="card-foot">
        <span>Availability is not a delivery promise - ask for a quantity and date to run the aATP simulation.</span>
        <span>
          {dateTime(l.createdAt)} · ref {l.id.slice(0, 8)}
        </span>
      </footer>
    </article>
  );
}

export function PlannedSupplyCard({ lookup: l }: { lookup: PlannedSupplyLookup }) {
  const e = l.evidence;
  const orders = e.plannedOrders ?? [];
  const projection = (e.projection ?? []).slice(0, 8);
  return (
    <article className="card card-lookup">
      <header className="card-head">
        <span className="badge badge-info">OMP</span>
        <div className="card-title">
          <h3>{e.ok ? `${orders.length} planned order${orders.length === 1 ? '' : 's'} in the horizon` : 'Planned supply not available'}</h3>
          <p>
            Material <strong>{l.input.material}</strong> · Plant <strong>{l.input.plant}</strong>
          </p>
        </div>
        <span className={`source source-${l.dataSource}`}>{l.dataSource === 'mock' ? 'Sample data' : 'Live OMP'}</span>
      </header>
      {e.ok && (
        <div className="evidence evidence-inline">
          {orders.length > 0 && (
            <table className="mini">
              <thead>
                <tr>
                  <th>Planned order availability</th>
                  <th className="num">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o, i) => (
                  <tr key={i}>
                    <td>{shortDate(o.availabilityDate)}</td>
                    <td className="num">{qty(o.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {projection.length > 0 && (
            <table className="mini">
              <thead>
                <tr>
                  <th>Date</th>
                  <th className="num">Projected available inventory</th>
                </tr>
              </thead>
              <tbody>
                {projection.map((p, i) => (
                  <tr key={i}>
                    <td>{shortDate(p.date)}</td>
                    <td className="num">{qty(p.projectedAvailableInventory)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <CallList calls={[e]} />
      <footer className="card-foot">
        <span>Planned supply is a forecast and is not confirmed in SAP execution.</span>
        <span>
          {dateTime(l.createdAt)} · ref {l.id.slice(0, 8)}
        </span>
      </footer>
    </article>
  );
}
