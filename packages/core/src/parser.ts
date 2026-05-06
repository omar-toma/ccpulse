import type { RawJsonlEvent, NormalizedEvent, MessageContent } from './types.js';

export interface ParsedLine {
  event: NormalizedEvent | null;
  toolCalls: Array<{
    toolUseId: string;
    sessionId: string;
    eventUuid: string;
    ts: number;
    name: string;
    inputJson: string;
  }>;
  toolResults: Array<{
    toolUseId: string;
    sessionId: string;
    eventUuid: string;
    ts: number;
    isError: number;
  }>;
  aiTitle: { sessionId: string; title: string } | null;
}

const EMPTY: ParsedLine = { event: null, toolCalls: [], toolResults: [], aiTitle: null };

export function parseLine(raw: string): ParsedLine {
  const trimmed = raw.trim();
  if (!trimmed) return EMPTY;
  let obj: RawJsonlEvent;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return EMPTY;
  }

  if (obj.type === 'ai-title' && obj.aiTitle && obj.sessionId) {
    return { event: null, toolCalls: [], toolResults: [], aiTitle: { sessionId: obj.sessionId, title: obj.aiTitle } };
  }

  if (!obj.uuid || !obj.sessionId || !obj.timestamp) return EMPTY;

  const ts = Date.parse(obj.timestamp);
  if (Number.isNaN(ts)) return EMPTY;

  const message = obj.message;
  const role = message?.role ?? null;
  const usage = message?.usage;
  const content = Array.isArray(message?.content) ? (message?.content as MessageContent[]) : [];

  let toolName: string | null = null;
  let toolUseId: string | null = null;
  let toolResultForId: string | null = null;

  const toolCalls: ParsedLine['toolCalls'] = [];
  const toolResults: ParsedLine['toolResults'] = [];

  for (const block of content) {
    if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({
        toolUseId: block.id,
        sessionId: obj.sessionId,
        eventUuid: obj.uuid,
        ts,
        name: block.name,
        inputJson: JSON.stringify(block.input ?? null),
      });
      if (!toolName) {
        toolName = block.name;
        toolUseId = block.id;
      }
    } else if (block.type === 'tool_result' && block.tool_use_id) {
      toolResults.push({
        toolUseId: block.tool_use_id,
        sessionId: obj.sessionId,
        eventUuid: obj.uuid,
        ts,
        isError: block.is_error ? 1 : 0,
      });
      if (!toolResultForId) toolResultForId = block.tool_use_id;
    }
  }

  const event: NormalizedEvent = {
    uuid: obj.uuid,
    sessionId: obj.sessionId,
    parentUuid: obj.parentUuid ?? null,
    type: obj.type,
    role,
    ts,
    cwd: obj.cwd ?? null,
    gitBranch: obj.gitBranch ?? null,
    version: obj.version ?? null,
    isSidechain: obj.isSidechain ? 1 : 0,
    model: message?.model ?? null,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheCreate: usage?.cache_creation_input_tokens ?? 0,
    toolName,
    toolUseId,
    toolResultForId,
    aiTitle: null,
  };

  return { event, toolCalls, toolResults, aiTitle: null };
}
