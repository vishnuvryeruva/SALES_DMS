import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { AuditEntry, ConnectivityResult, Status } from '../types';
import { dateTime, shortDate } from '../format';

export type PanelTab = 'connection' | 'audit';

interface Props {
  tab: PanelTab;
  status: Status | null;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  onTry: (prompt: string) => void;
}

const MODE_LABEL: Record<string, string> = {
  mock: 'Sample data (mock)',
  destination: 'BTP Destination',
  direct: 'Direct HTTP',
  off: 'Disabled',
};

function ConnectionTab({ status, onTry }: { status: Status | null; onTry: Props['onTry'] }) {
  const [result, setResult] = useState<ConnectivityResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const test = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await api.testConnection());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <p className="muted">Loading…</p>;
  return (
    <>
      <dl className="kv">
        <dt>System</dt>
        <dd>{status.system}</dd>
        <dt>SAP connection</dt>
        <dd>
          {MODE_LABEL[status.sap.mode] ?? status.sap.mode}
          <small>{status.sap.target}</small>
        </dd>
        <dt>OMP planned supply</dt>
        <dd>
          {MODE_LABEL[status.omp.mode] ?? status.omp.mode}
          <small>{status.omp.target}</small>
        </dd>
        <dt>Language model</dt>
        <dd>
          {status.ai.configured ? `SAP AI Core · ${status.ai.model}` : 'Not configured - rule-based parser'}
        </dd>
        <dt>Gap tolerance</dt>
        <dd>{status.rules.gapTolerancePct}% of requested quantity</dd>
      </dl>

      <button className="btn" onClick={test} disabled={busy}>
        {busy ? 'Testing…' : 'Test SAP connection'}
      </button>
      {error && <p className="error-text">{error}</p>}
      {result && (
        <ul className="calls">
          {result.checks.map((c) => (
            <li key={c.api} className={c.ok ? 'ok' : 'failed'}>
              <span className="call-dot" />
              <span className="call-api">{c.api}</span>
              <span className="call-meta">
                {c.ok ? `OK · ${c.durationMs} ms` : 'Failed'}
              </span>
              {c.ok && c.entitySets && <span className="call-path">Entity sets: {c.entitySets.join(', ')}</span>}
              {!c.ok && c.error && <span className="call-error">{c.error}</span>}
            </li>
          ))}
        </ul>
      )}

      {status.sampleMaterials.length > 0 && (
        <>
          <h4 className="panel-h">Sample materials</h4>
          <ul className="samples">
            {status.sampleMaterials.map((m) => (
              <li key={m.material}>
                <div>
                  <strong>
                    {m.material} / {m.plant}
                  </strong>{' '}
                  <span className="muted">{m.description}</span>
                  <small>{m.scenario}</small>
                </div>
                <button
                  className="btn-link"
                  onClick={() =>
                    onTry(`Can we promise ${m.exampleQuantity} ${m.unit} of material ${m.material} at plant ${m.plant} by ${shortDate(m.exampleDate)}?`)
                  }
                >
                  Try
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setEntries((await api.audit(100)).entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className="panel-row">
        <p className="muted">Every check is logged with its inputs, SAP calls, rule outcome and reference.</p>
        <button className="btn-link" onClick={load}>
          Refresh
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {entries?.length === 0 && <p className="muted">No entries yet.</p>}
      <ul className="audit">
        {entries?.map((e, i) => (
          <li key={e.correlationId ?? `${e.at}-${i}`}>
            <div className="audit-head">
              {e.rating && <span className={`badge badge-sm badge-${e.rating.toLowerCase()}`}>{e.rating}</span>}
              <span className="audit-type">{e.type.replace('_', ' ')}</span>
              <span className="muted">{dateTime(e.at)}</span>
            </div>
            {e.input?.material && (
              <div className="audit-input">
                {e.input.material} / {e.input.plant}
                {e.input.quantity ? ` · ${e.input.quantity} ${e.input.unit ?? ''}` : ''}
                {e.input.requestedDate ? ` · ${e.input.requestedDate}` : ''}
              </div>
            )}
            {e.headline && <div className="audit-headline">{e.headline}</div>}
            <div className="audit-calls">
              {(e.calls ?? e.checks ?? []).map((c) => (
                <span key={c.api} className={'skipped' in c && c.skipped ? 'skipped' : c.ok ? 'ok' : 'failed'} title={'error' in c ? c.error : undefined}>
                  {c.api.replace(/^API_/, '')} {c.durationMs !== undefined ? `${c.durationMs}ms` : ''}
                </span>
              ))}
            </div>
            {e.correlationId && <div className="audit-ref">ref {e.correlationId.slice(0, 8)}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}

export default function SidePanel({ tab, status, onTab, onClose, onTry }: Props) {
  return (
    <aside className="panel" aria-label="Connection and audit">
      <div className="panel-tabs">
        <button className={tab === 'connection' ? 'active' : ''} onClick={() => onTab('connection')}>
          Connection
        </button>
        <button className={tab === 'audit' ? 'active' : ''} onClick={() => onTab('audit')}>
          Audit log
        </button>
        <button className="panel-close" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </div>
      <div className="panel-body">{tab === 'connection' ? <ConnectionTab status={status} onTry={onTry} /> : <AuditTab />}</div>
    </aside>
  );
}
