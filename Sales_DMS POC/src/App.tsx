import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from './api';
import type { ChatContext, ChatMessage, Status } from './types';
import { qty, shortDate, time } from './format';
import Markdown from './components/Markdown';
import AssessmentCard from './components/AssessmentCard';
import { AvailabilityCard, PlannedSupplyCard } from './components/LookupCards';
import QuickCheck from './components/QuickCheck';
import SidePanel, { type PanelTab } from './components/SidePanel';

const STORAGE_KEY = 'atp-agent.chat.v1';
const HISTORY_LIMIT = 12;

interface Saved {
  messages: ChatMessage[];
  context: ChatContext;
}

function load(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && Array.isArray(saved.messages)) return { messages: saved.messages, context: saved.context ?? {} };
  } catch {
    /* corrupted storage - start fresh */
  }
  return { messages: [], context: {} };
}

const id = () => crypto.randomUUID();

function contextLabel(c: ChatContext) {
  const parts = [
    c.material && `Material ${c.material}`,
    c.plant && `Plant ${c.plant}`,
    c.quantity && `${qty(c.quantity)} ${c.unit ?? ''}`.trim(),
    c.requestedDate && `by ${shortDate(c.requestedDate)}`,
  ].filter(Boolean);
  return parts.join(' · ');
}

export default function App() {
  const [{ messages, context }, setChat] = useState<Saved>(load);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState('');
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [showForm, setShowForm] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.status().then(setStatus, (e) => setStatusError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages: messages.slice(-60), context }));
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, context, busy]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    const userMsg: ChatMessage = { id: id(), role: 'user', text: message, at: new Date().toISOString() };
    const history = messages.slice(-HISTORY_LIMIT).map((m) => ({ role: m.role, text: m.text }));
    setChat((s) => ({ ...s, messages: [...s.messages, userMsg] }));
    setInput('');
    setBusy(true);
    try {
      const reply = await api.chat(message, history, context);
      const assistant: ChatMessage = {
        id: id(),
        role: 'assistant',
        text: reply.responseText,
        at: reply.timestamp,
        engine: reply.engine,
        assessments: reply.assessments,
        availability: reply.availability,
        plannedSupply: reply.plannedSupply,
        notice: reply.aiError ? 'AI Core was unavailable, so this answer came from the rule-based assistant.' : undefined,
      };
      setChat((s) => ({ messages: [...s.messages, assistant], context: reply.context ?? s.context }));
    } catch (e) {
      const text = `The request could not be completed: ${e instanceof Error ? e.message : String(e)}`;
      setChat((s) => ({ ...s, messages: [...s.messages, { id: id(), role: 'assistant', text, at: new Date().toISOString(), error: true }] }));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  };

  const newChat = () => {
    setChat({ messages: [], context: {} });
    setInput('');
  };

  const tryPrompt = (prompt: string) => {
    setPanel(null);
    send(prompt);
  };

  const samples = status?.sampleMaterials ?? [];
  const suggestions = [
    ...samples
      .filter((m) => ['1000001', '1000002', '1000003', '1000006'].includes(m.material))
      .map((m) => ({
        label: m.scenario,
        prompt: `Can we promise ${m.exampleQuantity} ${m.unit} of material ${m.material} at plant ${m.plant} by ${shortDate(m.exampleDate)}?`,
      })),
    { label: 'What can you do?', prompt: 'What can you do?' },
  ];
  const ctx = contextLabel(context);

  return (
    <div className={`app ${panel ? 'with-panel' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden>
            ATP
          </div>
          <div>
            <h1>Backorder Reliability Agent</h1>
            <p>Delivery promise check · {status?.system ?? 'DMS OTC MT2'}</p>
          </div>
        </div>
        <div className="top-actions">
          {status && (
            <button className={`pill pill-${status.sap.mode}`} onClick={() => setPanel('connection')} title={status.sap.target}>
              <span className="pill-dot" />
              {status.sap.mode === 'mock' ? 'Sample data' : status.sap.mode === 'destination' ? 'SAP via BTP Destination' : 'SAP direct'}
            </button>
          )}
          {status && (
            <span className={`pill ${status.ai.configured ? 'pill-ai' : 'pill-off'}`} title={status.ai.configured ? status.ai.model : 'No AI Core binding'}>
              <span className="pill-dot" />
              {status.ai.configured ? 'AI Core' : 'Rules only'}
            </span>
          )}
          {statusError && <span className="pill pill-error">Backend unreachable</span>}
          <button className="btn-ghost" onClick={() => setPanel(panel === 'audit' ? null : 'audit')}>
            Audit log
          </button>
          <button className="btn-ghost" onClick={newChat} disabled={busy || messages.length === 0}>
            New chat
          </button>
        </div>
      </header>

      <main className="chat" aria-live="polite">
        <div className="thread">
          {messages.length === 0 && (
            <section className="welcome">
              <h2>Can we promise this delivery?</h2>
              <p>
                Ask in plain language about a material, plant, quantity and requested date. The agent reads Product Availability and runs a
                read-only Advanced ATP simulation in SAP, adds OMP planned supply, and rates the promise <b>High</b>, <b>Medium</b> or{' '}
                <b>Low</b> with the evidence and a recommended action.
              </p>
              <div className="chips">
                {suggestions.map((s) => (
                  <button key={s.prompt} className="chip" onClick={() => send(s.prompt)} disabled={busy}>
                    <span>{s.label}</span>
                    <small>{s.prompt}</small>
                  </button>
                ))}
              </div>
            </section>
          )}

          {messages.map((m) => (
            <div key={m.id} className={`msg msg-${m.role} ${m.error ? 'msg-error' : ''}`}>
              {m.role === 'assistant' && (
                <div className="avatar" aria-hidden>
                  ATP
                </div>
              )}
              <div className="msg-body">
                <div className="bubble">
                  {m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}
                </div>
                {m.notice && <div className="notice">{m.notice}</div>}
                {m.assessments?.map((a) => <AssessmentCard key={a.id} assessment={a} />)}
                {m.availability?.map((l) => <AvailabilityCard key={l.id} lookup={l} />)}
                {m.plannedSupply?.map((l) => <PlannedSupplyCard key={l.id} lookup={l} />)}
                <div className="meta">
                  {time(m.at)}
                  {m.engine && ` · ${m.engine === 'ai-core' ? 'AI Core' : 'Rule-based'}`}
                </div>
              </div>
            </div>
          ))}

          {busy && (
            <div className="msg msg-assistant">
              <div className="avatar" aria-hidden>
                ATP
              </div>
              <div className="msg-body">
                <div className="bubble typing">
                  <span />
                  <span />
                  <span />
                  Checking availability and running the ATP simulation…
                </div>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </main>

      <footer className="composer">
        <div className="composer-inner">
          <div className="composer-tools">
            <button className={`btn-ghost ${showForm ? 'active' : ''}`} onClick={() => setShowForm(!showForm)} aria-expanded={showForm}>
              {showForm ? '▾' : '▸'} Structured check
            </button>
            {ctx && (
              <span className="context" title="Values the agent reuses for follow-up questions">
                {ctx}
                <button onClick={() => setChat((s) => ({ ...s, context: {} }))} aria-label="Clear context">
                  ×
                </button>
              </span>
            )}
          </div>
          {showForm && (
            <QuickCheck
              key={JSON.stringify(context)}
              initial={context}
              disabled={busy}
              onSubmit={(prompt) => {
                setShowForm(false);
                send(prompt);
              }}
            />
          )}
          <div className="input-row">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="e.g. Can we promise 20 EA of material 1000002 at plant 1000 by next Friday?"
              aria-label="Message"
            />
            <button className="btn send" onClick={() => send(input)} disabled={busy || !input.trim()}>
              Send
            </button>
          </div>
          <p className="fineprint">Decision support only. Read-only ATP simulation - nothing is reserved or changed in SAP.</p>
        </div>
      </footer>

      {panel && <SidePanel tab={panel} status={status} onTab={setPanel} onClose={() => setPanel(null)} onTry={tryPrompt} />}
    </div>
  );
}
