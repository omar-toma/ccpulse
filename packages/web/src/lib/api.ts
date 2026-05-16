import { resolveRange, type RangeParam } from './range';

export interface ProjectSummary {
  cwd: string;
  lastActive: number;
  sessionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  estimatedCost: number;
  inRange: boolean;
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
  inRange: boolean;
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

export interface SessionMeta {
  id: string;
  title: string | null;
  cwd: string | null;
  branch: string | null;
  projectRoot: string | null;
  /** All-time session bounds — present even when a range excludes every event. */
  firstTs: number | null;
  lastTs: number | null;
}

const BASE = ''; // same origin (proxied in dev)

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

/** Append `from`/`to` (and any extra params) to a path, resolving the range. */
function withRange(path: string, range?: RangeParam, extra?: Record<string, string>): string {
  const { from, to } = resolveRange(range);
  const p = new URLSearchParams(extra);
  if (from != null) p.set('from', String(Math.round(from)));
  if (to != null) p.set('to', String(Math.round(to)));
  const qs = p.toString();
  return qs ? `${path}?${qs}` : path;
}

const enc = encodeURIComponent;

export interface ContentMatch {
  sessionId: string;
  cwd: string | null;
  snippet: string;
  matchCount: number;
  lastTs: number;
}

export const api = {
  projects: (range?: RangeParam) => get<ProjectSummary[]>(withRange('/api/projects', range)),
  sessions: (cwd: string, range?: RangeParam) =>
    get<SessionSummary[]>(withRange(`/api/projects/${enc(cwd)}/sessions`, range)),
  projectTools: (cwd: string, range?: RangeParam) =>
    get<ToolBucket[]>(withRange(`/api/projects/${enc(cwd)}/tools`, range)),
  projectModels: (cwd: string, range?: RangeParam) =>
    get<ModelBucket[]>(withRange(`/api/projects/${enc(cwd)}/models`, range)),
  session: (id: string, range?: RangeParam) =>
    get<{ session: SessionMeta; events: any[]; gaps: any[] }>(withRange(`/api/sessions/${id}`, range)),
  sessionTools: (id: string, range?: RangeParam) =>
    get<ToolBucket[]>(withRange(`/api/sessions/${id}/tools`, range)),
  event: (uuid: string) => get<any>(`/api/events/${uuid}`),
  searchProjectSessions: (cwd: string, q: string, range?: RangeParam) =>
    get<ContentMatch[]>(withRange(`/api/projects/${enc(cwd)}/sessions/search`, range, { q })),
  searchAllSessions: (q: string, range?: RangeParam) =>
    get<ContentMatch[]>(withRange('/api/sessions/search', range, { q })),
};
