import express from 'express';
import morgan from 'morgan';
import path from 'node:path';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServices } from './services.js';
import { createAuditLog } from './audit.js';
import { createAgent } from './agent/agent.js';
import { isAiConfigured } from './agent/ai-core.js';
import { assessPromise, lookupAvailability, lookupPlannedSupply } from './assessment.js';
import { mockCatalogForUi } from './sap/mock-dms.js';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Optional shared-credential gate for a deployed POC URL (APP_BASIC_AUTH_USER / _PASSWORD). */
function basicAuthGate({ user, password }) {
  return (req, res, next) => {
    if (!user || !password || req.path === '/api/v1/health') return next();
    const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, ...rest] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
      if (safeEqual(u, user) && safeEqual(rest.join(':'), password)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Backorder Reliability Agent", charset="UTF-8"');
    return res.status(401).send('Authentication required');
  };
}

export function createApp(config, { services = createServices(config), audit = createAuditLog(config.audit) } = {}) {
  const agent = createAgent({ services, config, audit });
  const deps = { services, config, audit, channel: 'api' };
  const app = express();

  app.disable('x-powered-by');
  app.use(basicAuthGate(config.basicAuth));
  if (config.nodeEnv !== 'test') app.use(morgan(config.nodeEnv === 'production' ? 'tiny' : 'dev'));
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.get('/api/v1/status', (_req, res) => {
    const connections = services.describe();
    res.json({
      app: 'Backorder Reliability Agent',
      version: '0.1.0',
      system: config.systemLabel,
      sap: connections.sap,
      omp: connections.omp,
      ai: { configured: isAiConfigured(config.ai), model: config.ai.model },
      rules: { gapTolerancePct: config.rules.gapTolerancePct },
      sampleMaterials: services.sapMode === 'mock' ? mockCatalogForUi() : [],
    });
  });

  app.post('/api/v1/chat', async (req, res) => {
    const { message, history, context } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: '"message" is required.' });
    }
    try {
      const reply = await agent.chat({
        message: message.trim().slice(0, 2000),
        history: Array.isArray(history) ? history : [],
        context: context && typeof context === 'object' ? context : {},
      });
      return res.json({ ...reply, timestamp: new Date().toISOString() });
    } catch (err) {
      console.error('[Chat Error]', err);
      return res.status(500).json({ error: `The agent could not process the request: ${err.message}` });
    }
  });

  /** Structured entry point (also the candidate action for a Joule Studio skill). */
  app.post('/api/v1/assess', async (req, res) => {
    try {
      const result = await assessPromise(req.body || {}, deps);
      return res.status(result.status === 'needs_input' ? 400 : 200).json(result);
    } catch (err) {
      console.error('[Assess Error]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/v1/availability', async (req, res) => {
    const result = await lookupAvailability(req.query, deps);
    res.status(result.status === 'needs_input' ? 400 : 200).json(result);
  });

  app.get('/api/v1/planned-supply', async (req, res) => {
    const result = await lookupPlannedSupply(req.query, deps);
    res.status(result.status === 'needs_input' ? 400 : 200).json(result);
  });

  app.get('/api/v1/audit', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({ entries: audit.list(limit) });
  });

  /** Read-only check: GET the service document of both OData services through the configured route. */
  app.post('/api/v1/diagnostics/connectivity', async (_req, res) => {
    const checks = await Promise.all(
      [
        ['API_PRODUCT_AVAILY_INFO', config.sap.availabilityServicePath],
        ['API_AVAIL_TO_PROMISE_CHECK', config.sap.atpServicePath],
      ].map(async ([api, servicePath]) => {
        const started = Date.now();
        try {
          const doc = await services.odata.get(servicePath);
          return { api, ok: true, durationMs: Date.now() - started, entitySets: (doc.value || []).map((v) => v.name) };
        } catch (err) {
          return { api, ok: false, durationMs: Date.now() - started, error: `${err.kind || 'error'}: ${err.message}` };
        }
      })
    );
    audit.record({ type: 'connectivity_check', target: services.describe().sap, checks });
    res.json({ sap: services.describe().sap, checks, checkedAt: new Date().toISOString() });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(distDir, 'index.html')) : next()));
  }

  return app;
}
