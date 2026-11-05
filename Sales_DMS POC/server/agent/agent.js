import { assessPromise, lookupAvailability, lookupPlannedSupply, summarizeAssessment } from '../assessment.js';
import { mockCatalogForUi } from '../sap/mock-dms.js';
import { todayIso } from '../lib/dates.js';
import { parseRequest } from './parse.js';
import { chatWithTools, isAiConfigured } from './ai-core.js';

const CONTEXT_FIELDS = ['material', 'plant', 'quantity', 'unit', 'requestedDate'];
const FIELD_LABELS = { material: 'material number', plant: 'plant', quantity: 'quantity', requestedDate: 'requested date' };
const n = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 });

function pickContext(source = {}) {
  const out = {};
  for (const field of CONTEXT_FIELDS) {
    if (source[field] !== undefined && source[field] !== null && source[field] !== '') out[field] = source[field];
  }
  return out;
}

function exampleQuestion(today, isMock) {
  return isMock
    ? `How reliable is the promise for material 1000002, plant 1000, 20 EA, requested ${today}?`
    : 'How reliable is the promise for material <material>, plant <plant>, <qty> EA, requested <YYYY-MM-DD>?';
}

function askForMissing(result, today, isMock) {
  const parts = [];
  if (result.missing.length) {
    const labels = result.missing.map((f) => `**${FIELD_LABELS[f] || f}**`);
    parts.push(`To assess the promise I still need the ${labels.join(', ').replace(/, ([^,]*)$/, ' and $1')}.`);
  }
  if (result.errors.length) parts.push(result.errors.join(' '));
  parts.push(`For example: *${exampleQuestion(today, isMock)}*`);
  return parts.join('\n\n');
}

function summarizeAvailability(r) {
  const { input, evidence: e } = r;
  if (!e.ok) return `**Availability could not be retrieved** for material ${input.material} at plant ${input.plant}: ${e.error.message}`;
  if (e.periods.length === 0) return `The availability service returned no time series for material ${input.material} at plant ${input.plant}.`;
  const unit = e.unit || '';
  const lines = [`**Availability for material ${input.material}, MRP area ${e.mrpArea}:** ${n(r.availableToday ?? 0)} ${unit} available today.`];
  const changes = e.periods.filter((p) => p.start > r.createdAt.slice(0, 10)).slice(0, 4);
  for (const p of changes) lines.push(`- From ${p.start}: ${n(p.availableQty)} ${unit}`);
  lines.push('Give me a quantity and requested date to assess a specific promise.');
  return lines.join('\n');
}

function summarizePlannedSupply(r) {
  const { input, evidence: e } = r;
  if (!e.ok) return `**OMP planned supply is not available** for material ${input.material} at plant ${input.plant}: ${e.error.message}`;
  if (e.plannedOrders.length === 0) return `OMP shows no planned orders for material ${input.material} at plant ${input.plant} in the horizon.`;
  const lines = [`**OMP planned supply for material ${input.material} at plant ${input.plant}** (not yet in SAP execution):`];
  for (const p of e.plannedOrders.slice(0, 5)) lines.push(`- Planned order ${n(p.quantity)} available ${p.availabilityDate}`);
  return lines.join('\n');
}

function helpText(today, isMock) {
  return [
    'I assess how reliable a delivery promise is for a backordered product.',
    `Ask, for example: *${exampleQuestion(today, isMock)}*`,
    'I call **Product Availability** and the **Advanced ATP simulation** in SAP, add **OMP planned supply**, and rate the promise **High / Medium / Low** with the reasons and a recommended action.',
    'I am read-only: no sales orders, confirmations, allocations or delivery dates are changed.',
  ].join('\n\n');
}

function catalogText(isMock, now) {
  if (!isMock) return 'I am connected to the live SAP system, so there is no sample catalog. Ask about any material and plant you are authorized for.';
  const rows = mockCatalogForUi(now).map((m) => `- **${m.material} / plant ${m.plant}** - ${m.scenario}. Try ${m.exampleQuantity} ${m.unit} for ${m.exampleDate}.`);
  return ['Sample materials in the simulated DMS system:', ...rows].join('\n');
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'assess_promise_reliability',
      description:
        'Assess how reliable a delivery promise is: calls SAP Product Availability and the Advanced ATP simulation, adds OMP planned supply, and applies the approved High/Medium/Low rules.',
      parameters: {
        type: 'object',
        properties: {
          material: { type: 'string', description: 'SAP material / product number' },
          plant: { type: 'string', description: 'SAP plant or DC (max 4 characters)' },
          quantity: { type: 'number', description: 'Requested quantity' },
          unit: { type: 'string', description: 'Unit of measure, e.g. EA. Omit if the user did not say.' },
          requestedDate: { type: 'string', description: 'Requested date, YYYY-MM-DD' },
          shippingPoint: { type: 'string', description: 'Optional shipping point' },
          shipToCustomer: { type: 'string', description: 'Optional ship-to customer number' },
        },
        required: ['material', 'plant', 'quantity', 'requestedDate'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_product_availability',
      description: 'Availability time series for a material and plant from SAP Product Availability (how much is available, by period).',
      parameters: {
        type: 'object',
        properties: { material: { type: 'string' }, plant: { type: 'string' } },
        required: ['material', 'plant'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_planned_supply',
      description: 'OMP planned orders and projected available inventory for a material and plant (future supply not yet in SAP execution).',
      parameters: {
        type: 'object',
        properties: { material: { type: 'string' }, plant: { type: 'string' } },
        required: ['material', 'plant'],
      },
    },
  },
];

const SAMPLE_TOOL = {
  type: 'function',
  function: {
    name: 'list_sample_materials',
    description: 'List the sample materials and scenarios available in the simulated DMS system.',
    parameters: { type: 'object', properties: {} },
  },
};

/** What the LLM sees from a tool call: ground truth without raw payloads. */
function toolView(kind, result) {
  if (result.status === 'needs_input') return { status: 'needs_input', missing: result.missing, errors: result.errors };
  if (kind === 'assessment') {
    return {
      rating: result.rating,
      headline: result.headline,
      recommendedAction: result.recommendedAction,
      outcome: result.outcome,
      drivers: result.drivers.map((d) => d.text),
      assumptions: result.assumptions,
      dataSource: result.dataSource,
      summary: summarizeAssessment(result),
    };
  }
  if (kind === 'availability') {
    return result.evidence.ok
      ? { unit: result.evidence.unit, availableToday: result.availableToday, periods: result.evidence.periods }
      : { error: result.evidence.error.message };
  }
  return result.evidence.ok
    ? { plannedOrders: result.evidence.plannedOrders, projection: result.evidence.projection.slice(0, 12) }
    : { error: result.evidence.error.message };
}

function systemPrompt({ today, isMock, system, context }) {
  return `You are the Backorder Reliability Agent for J&J MedTech customer service and order management, working against SAP S/4HANA ${system}.
Today is ${today}. Data source: ${isMock ? 'SIMULATED sample data (mock DMS system) - mention this if the user asks whether data is real.' : 'live SAP system.'}

You answer one question: how reliable is a delivery promise for a backordered product (material, plant, quantity, requested date)?

Rules:
1. Never invent quantities, dates, ratings or SAP data. Only state what a tool returned.
2. The rating, confirmed quantity/date and recommended action come from the tool. Never change or soften them.
3. Call assess_promise_reliability as soon as material, plant, quantity and requested date are known from the message or the active context. Convert relative dates (tomorrow, next Friday, Nov 20) to YYYY-MM-DD using today's date. If the user gave no unit, omit it.
4. If inputs are missing, ask only for the missing ones in one short sentence. Never call a tool with guessed values.
5. Follow-ups such as "what about 50?" or "and next Friday?" reuse the active context for fields not mentioned.
6. Reply in 2-4 short sentences: rating, what can be confirmed and when, the key constraint, the recommended action. The UI shows a detailed card with the evidence, so do not reproduce tables, lists of periods or JSON.
7. If a tool reports an error or a Low rating, say the promise cannot be verified and should go to planner or order-management review.
8. You are read-only. You cannot change sales orders, confirmations, allocations or delivery dates; if asked, say so and suggest the planner route.
9. Only discuss availability, ATP, backorders and planned supply. Politely decline anything else.

Active context: ${Object.keys(context).length ? JSON.stringify(context) : 'none'}`;
}

export function createAgent({ services, config, audit }) {
  const deps = { services, config, audit, channel: 'chat' };
  const isMock = () => services.sapMode === 'mock';

  async function deterministic({ message, context }) {
    const today = todayIso();
    const { intent, fields } = parseRequest(message, { today });
    const merged = { ...context, ...fields };
    const reply = { engine: 'rules', assessments: [], availability: [], plannedSupply: [], context: pickContext(merged) };

    if (intent === 'help') return { ...reply, responseText: helpText(today, isMock()) };
    if (intent === 'catalog') return { ...reply, responseText: catalogText(isMock(), new Date()) };

    if (intent === 'availability' || intent === 'planned_supply') {
      const lookup = intent === 'availability' ? lookupAvailability : lookupPlannedSupply;
      const result = await lookup(merged, deps);
      if (result.status === 'needs_input') return { ...reply, responseText: askForMissing(result, today, isMock()) };
      return intent === 'availability'
        ? { ...reply, availability: [result], responseText: summarizeAvailability(result) }
        : { ...reply, plannedSupply: [result], responseText: summarizePlannedSupply(result) };
    }

    const result = await assessPromise(merged, deps);
    if (result.status === 'needs_input') {
      if (Object.keys(fields).length === 0 && Object.keys(context).length === 0) {
        return { ...reply, responseText: helpText(today, isMock()) };
      }
      return { ...reply, responseText: askForMissing(result, today, isMock()) };
    }
    return { ...reply, assessments: [result], context: pickContext(result.input), responseText: summarizeAssessment(result) };
  }

  async function withAi({ message, history, context }) {
    const today = todayIso();
    const collected = { assessments: [], availability: [], plannedSupply: [] };
    let latestContext = context;

    const messages = [
      { role: 'system', content: systemPrompt({ today, isMock: isMock(), system: config.systemLabel, context }) },
      ...history,
      { role: 'user', content: message },
    ];

    const executeToolCall = async (name, args) => {
      const merged = { ...latestContext, ...args };
      if (name === 'assess_promise_reliability') {
        const result = await assessPromise(merged, deps);
        if (result.status === 'assessed') {
          collected.assessments.push(result);
          latestContext = pickContext(result.input);
        }
        return toolView('assessment', result);
      }
      if (name === 'get_product_availability') {
        const result = await lookupAvailability(merged, deps);
        if (result.status !== 'needs_input') {
          collected.availability.push(result);
          latestContext = { ...latestContext, ...pickContext({ material: result.input.material, plant: result.input.plant }) };
        }
        return toolView('availability', result);
      }
      if (name === 'get_planned_supply') {
        const result = await lookupPlannedSupply(merged, deps);
        if (result.status !== 'needs_input') collected.plannedSupply.push(result);
        return toolView('planned_supply', result);
      }
      if (name === 'list_sample_materials' && isMock()) return { materials: mockCatalogForUi() };
      return { error: `Unknown tool ${name}` };
    };

    const text = await chatWithTools({
      model: config.ai.model,
      messages,
      tools: isMock() ? [...TOOLS, SAMPLE_TOOL] : TOOLS,
      executeToolCall,
    });

    const fallbackText = collected.assessments.length ? collected.assessments.map(summarizeAssessment).join('\n\n') : helpText(today, isMock());
    return { engine: 'ai-core', ...collected, context: latestContext, responseText: text || fallbackText };
  }

  return {
    aiEnabled: () => isAiConfigured(config.ai),
    async chat({ message, history = [], context = {} }) {
      const cleanHistory = history
        .filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.text === 'string' && h.text.trim())
        .slice(-12)
        .map((h) => ({ role: h.role, content: h.text.slice(0, 2000) }));
      const ctx = pickContext(context);

      if (isAiConfigured(config.ai)) {
        try {
          return await withAi({ message, history: cleanHistory, context: ctx });
        } catch (err) {
          console.error('[Agent] AI Core failed, using rule-based parser:', err.message);
          const reply = await deterministic({ message, context: ctx });
          return { ...reply, aiError: 'AI Core was unavailable; answered with the rule-based parser.' };
        }
      }
      return deterministic({ message, context: ctx });
    },
  };
}
