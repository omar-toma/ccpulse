import { describe, it, expect } from 'vitest';
import { parseLine } from './parser.js';

describe('parseLine', () => {
  it('returns empty for blank lines', () => {
    expect(parseLine('').event).toBeNull();
    expect(parseLine('   ').event).toBeNull();
  });

  it('returns empty for malformed JSON', () => {
    expect(parseLine('{not json').event).toBeNull();
  });

  it('parses an assistant message with usage and tool_use', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      parentUuid: 'p1',
      sessionId: 's1',
      cwd: '/tmp/proj',
      gitBranch: 'main',
      version: '2.0.0',
      timestamp: '2026-05-06T10:00:00.000Z',
      isSidechain: false,
      message: {
        role: 'assistant',
        model: 'claude-opus-4-7',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: '/x' } },
        ],
      },
    });
    const p = parseLine(raw);
    expect(p.event).not.toBeNull();
    expect(p.event!.inputTokens).toBe(100);
    expect(p.event!.outputTokens).toBe(50);
    expect(p.event!.toolName).toBe('Read');
    expect(p.event!.toolUseId).toBe('toolu_1');
    expect(p.toolCalls).toHaveLength(1);
    expect(p.toolCalls[0]!.name).toBe('Read');
  });

  it('parses a user message with tool_result', () => {
    const raw = JSON.stringify({
      type: 'user',
      uuid: 'u2',
      sessionId: 's1',
      timestamp: '2026-05-06T10:00:01.500Z',
      cwd: '/tmp/proj',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false }],
      },
    });
    const p = parseLine(raw);
    expect(p.event).not.toBeNull();
    expect(p.toolResults).toHaveLength(1);
    expect(p.toolResults[0]!.toolUseId).toBe('toolu_1');
  });

  it('extracts ai-title', () => {
    const raw = JSON.stringify({ type: 'ai-title', sessionId: 's1', aiTitle: 'My Session' });
    const p = parseLine(raw);
    expect(p.aiTitle).toEqual({ sessionId: 's1', title: 'My Session' });
    expect(p.event).toBeNull();
  });
});
