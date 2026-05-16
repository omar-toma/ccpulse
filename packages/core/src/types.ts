export type EventType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'attachment'
  | 'file-history-snapshot'
  | 'last-prompt'
  | 'permission-mode'
  | 'ai-title';

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface MessageContent {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface AnthropicMessage {
  role?: 'user' | 'assistant';
  content?: MessageContent[] | string;
  model?: string;
  usage?: Usage;
}

export interface RawJsonlEvent {
  type: EventType;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: AnthropicMessage;
  aiTitle?: string;
  requestId?: string;
  // system event extras
  subtype?: string;
  hookCount?: number;
  hookErrors?: unknown;
  toolUseID?: string;
  level?: string;
}

export interface NormalizedEvent {
  uuid: string;
  sessionId: string;
  parentUuid: string | null;
  type: EventType;
  role: string | null;
  ts: number; // ms epoch
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  isSidechain: number; // 0/1
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  toolName: string | null;
  toolUseId: string | null;
  toolResultForId: string | null;
  aiTitle: string | null;
  requestId: string | null;
}

/** Inclusive epoch-ms time window. Either bound may be omitted (open-ended). */
export interface Range {
  from?: number;
  to?: number;
}

export interface ProjectSummary {
  cwd: string;
  /** All-time last activity — kept even when the project is idle within a range. */
  lastActive: number;
  /** Sessions with at least one event inside the active range. */
  sessionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  estimatedCost: number;
  /** False when a range is active and the project had no events inside it. */
  inRange: boolean;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  title: string | null;
  /** All-time session bounds (session identity) — not range-clamped. */
  startedAt: number;
  endedAt: number;
  branch: string | null;
  /** Counts and totals below reflect only events inside the active range. */
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  estimatedCost: number;
  toolCallCount: number;
  /** False when a range is active and the session had no events inside it. */
  inRange: boolean;
}

export interface ToolBucket {
  name: string;
  count: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  totalLatencyMs: number;
}
