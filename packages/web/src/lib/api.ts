export interface ProjectSummary {
  cwd: string;
  lastActive: number;
  sessionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  estimatedCost: number;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  title: string | null;
  startedAt: number;
  endedAt: number;
  branch: string | null;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  estimatedCost: number;
  toolCallCount: number;
}

export interface ToolBucket {
  name: string;
  count: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  totalLatencyMs: number;
}

export interface ModelBucket {
  model: string;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  cost: number;
}

const BASE = ''; // same origin (proxied in dev)

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export interface ContentMatch {
  sessionId: string;
  cwd: string | null;
  snippet: string;
  matchCount: number;
  lastTs: number;
}

export const api = {
  projects: () => get<ProjectSummary[]>('/api/projects'),
  sessions: (cwd: string) => get<SessionSummary[]>(`/api/projects/${encodeURIComponent(cwd)}/sessions`),
  projectTools: (cwd: string) => get<ToolBucket[]>(`/api/projects/${encodeURIComponent(cwd)}/tools`),
  projectModels: (cwd: string) => get<ModelBucket[]>(`/api/projects/${encodeURIComponent(cwd)}/models`),
  session: (id: string) => get<{ session: { id: string; title: string | null; cwd: string | null; branch: string | null; projectRoot: string | null }; events: any[]; gaps: any[] }>(`/api/sessions/${id}`),
  sessionTools: (id: string) => get<ToolBucket[]>(`/api/sessions/${id}/tools`),
  event: (uuid: string) => get<any>(`/api/events/${uuid}`),
  searchProjectSessions: (cwd: string, q: string) =>
    get<ContentMatch[]>(`/api/projects/${encodeURIComponent(cwd)}/sessions/search?q=${encodeURIComponent(q)}`),
  searchAllSessions: (q: string) =>
    get<ContentMatch[]>(`/api/sessions/search?q=${encodeURIComponent(q)}`),
};
