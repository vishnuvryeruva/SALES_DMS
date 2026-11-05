/**
 * HTTP transport to an upstream system. Two implementations share one interface:
 *   direct      - fetch() against BASE_URL with none / basic / OAuth2 client-credentials auth
 *                 (also used for a CPI iFlow proxy: CPI runtime URL + client-credentials key)
 *   destination - SAP BTP Destination service via SAP Cloud SDK; OnPremise destinations are routed
 *                 through the Connectivity service proxy to the Cloud Connector automatically
 *
 * request() never throws for HTTP error statuses; it returns { status, headers, setCookies, data }.
 * It throws UpstreamError for configuration, network and timeout problems.
 */

export class UpstreamError extends Error {
  constructor(message, { kind = 'upstream', status = null, detail = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

function parseBody(text, contentType) {
  if (!text) return null;
  if (contentType.includes('json') || /^[[{]/.test(text.trim())) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function lowerCaseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) out[key.toLowerCase()] = value;
  return out;
}

function withQuery(path, query) {
  const entries = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return path;
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

function createTokenProvider(auth, timeoutMs) {
  let cached = null;
  return async function getToken() {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    if (!auth.tokenUrl || !auth.clientId || !auth.clientSecret) {
      throw new UpstreamError('OAuth2 client credentials are incomplete (token URL, client ID and secret are required).', {
        kind: 'config',
      });
    }
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (auth.scope) form.set('scope', auth.scope);
    let res;
    try {
      res = await fetch(auth.tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new UpstreamError(`OAuth token request failed: ${err.message}`, { kind: 'network' });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new UpstreamError(`OAuth token request rejected (HTTP ${res.status}).`, { kind: 'auth', status: res.status });
    }
    cached = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 300) * 1000 };
    return cached.token;
  };
}

function createDirectTransport(cfg) {
  const getToken = cfg.auth.type === 'oauth2_client_credentials' ? createTokenProvider(cfg.auth, cfg.timeoutMs) : null;

  async function authHeaders() {
    if (cfg.auth.type === 'basic') {
      return { Authorization: `Basic ${Buffer.from(`${cfg.auth.username}:${cfg.auth.password}`).toString('base64')}` };
    }
    if (getToken) return { Authorization: `Bearer ${await getToken()}` };
    return {};
  }

  return {
    describe: () => ({ mode: 'direct', target: cfg.baseUrl || '(BASE_URL not set)', auth: cfg.auth.type }),
    async request({ method = 'GET', path, headers = {}, body, query }) {
      if (!cfg.baseUrl) throw new UpstreamError('Direct mode requires a BASE_URL.', { kind: 'config' });
      const url = cfg.baseUrl + withQuery(path, { ...cfg.defaultQuery, ...query });
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { ...(await authHeaders()), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (err) {
        if (err instanceof UpstreamError) throw err;
        const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
        const reason = err.cause?.code || err.message;
        throw new UpstreamError(timedOut ? `Request timed out after ${cfg.timeoutMs} ms.` : `Network error: ${reason}`, {
          kind: timedOut ? 'timeout' : 'network',
        });
      }
      const text = await res.text();
      const responseHeaders = lowerCaseHeaders(Object.fromEntries(res.headers.entries()));
      return {
        status: res.status,
        headers: responseHeaders,
        setCookies: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
        data: parseBody(text, responseHeaders['content-type'] || ''),
      };
    },
  };
}

function createDestinationTransport(cfg) {
  let httpClient = null;

  function toResponse(response) {
    const headers = lowerCaseHeaders(response.headers);
    const setCookie = headers['set-cookie'];
    return {
      status: response.status,
      headers,
      setCookies: Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [],
      data: typeof response.data === 'string' ? parseBody(response.data, headers['content-type'] || '') : response.data,
    };
  }

  return {
    describe: () => ({ mode: 'destination', target: cfg.destinationName || '(DESTINATION_NAME not set)' }),
    async request({ method = 'GET', path, headers = {}, body, query }) {
      if (!cfg.destinationName) throw new UpstreamError('Destination mode requires a DESTINATION_NAME.', { kind: 'config' });
      httpClient ||= await import('@sap-cloud-sdk/http-client');
      try {
        const response = await httpClient.executeHttpRequest(
          { destinationName: cfg.destinationName, useCache: true },
          {
            method: method.toLowerCase(),
            url: withQuery(path, { ...cfg.defaultQuery, ...query }),
            headers,
            data: body,
            timeout: cfg.timeoutMs,
          },
          { fetchCsrfToken: false }
        );
        return toResponse(response);
      } catch (err) {
        const response = err.response || err.cause?.response;
        if (response) return toResponse(response);
        const message = err.cause?.message ? `${err.message} (${err.cause.message})` : err.message;
        const kind = /destination/i.test(message) ? 'config' : err.code === 'ECONNABORTED' ? 'timeout' : 'network';
        throw new UpstreamError(`Destination "${cfg.destinationName}" request failed: ${message}`, { kind });
      }
    },
  };
}

export function createTransport(cfg) {
  if (cfg.mode === 'destination') return createDestinationTransport(cfg);
  if (cfg.mode === 'direct') return createDirectTransport(cfg);
  throw new UpstreamError(`Unsupported connection mode "${cfg.mode}".`, { kind: 'config' });
}
