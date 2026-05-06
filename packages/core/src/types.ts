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
}

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
