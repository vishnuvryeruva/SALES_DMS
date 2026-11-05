import type { AuditEntry, ChatContext, ChatReply, ConnectivityResult, Status } from './types';

const BASE = '/api/v1';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `Request failed (HTTP ${res.status})`);
  return body as T;
}

export const api = {
  status: () => request<Status>('/status'),
  chat: (message: string, history: { role: string; text: string }[], context: ChatContext) =>
    request<ChatReply>('/chat', { method: 'POST', body: JSON.stringify({ message, history, context }) }),
  audit: (limit = 50) => request<{ entries: AuditEntry[] }>(`/audit?limit=${limit}`),
  testConnection: () => request<ConnectivityResult>('/diagnostics/connectivity', { method: 'POST', body: '{}' }),
};
