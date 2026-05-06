import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Rates in USD per 1M tokens. Numbers reflect public Anthropic pricing for Claude 4 family
// at time of writing; user can override at ~/.ccpulse/models.json.
export interface ModelRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

const DEFAULT_RATES: Record<string, ModelRate> = {
  'claude-opus-4-7':            { input: 15,  output: 75,  cacheRead: 1.5,  cacheCreate: 18.75 },
  'claude-opus-4-6':            { input: 15,  output: 75,  cacheRead: 1.5,  cacheCreate: 18.75 },
  'claude-opus-4-5':            { input: 15,  output: 75,  cacheRead: 1.5,  cacheCreate: 18.75 },
  'claude-sonnet-4-6':          { input: 3,   output: 15,  cacheRead: 0.3,  cacheCreate: 3.75 },
  'claude-sonnet-4-5':          { input: 3,   output: 15,  cacheRead: 0.3,  cacheCreate: 3.75 },
  'claude-haiku-4-5':           { input: 1,   output: 5,   cacheRead: 0.1,  cacheCreate: 1.25 },
  'claude-haiku-4-5-20251001':  { input: 1,   output: 5,   cacheRead: 0.1,  cacheCreate: 1.25 },
  '__default__':                { input: 3,   output: 15,  cacheRead: 0.3,  cacheCreate: 3.75 },
};

let cachedRates: Record<string, ModelRate> | null = null;

export function loadRates(overridePath = join(homedir(), '.ccpulse', 'models.json')): Record<string, ModelRate> {
  if (cachedRates) return cachedRates;
  let merged = { ...DEFAULT_RATES };
  if (existsSync(overridePath)) {
    try {
      const user = JSON.parse(readFileSync(overridePath, 'utf8')) as Record<string, ModelRate>;
      merged = { ...merged, ...user };
    } catch {
      // ignore malformed override
    }
  }
  cachedRates = merged;
  return merged;
}

export function rateFor(model: string | null | undefined, rates = loadRates()): ModelRate {
  if (!model) return rates.__default__!;
  if (rates[model]) return rates[model]!;
  // try prefix match (e.g. "claude-sonnet-4-6-foo" -> "claude-sonnet-4-6")
  for (const key of Object.keys(rates)) {
    if (key !== '__default__' && model.startsWith(key)) return rates[key]!;
  }
  return rates.__default__!;
}

export function costOf(model: string | null | undefined, tokens: { input?: number; output?: number; cacheRead?: number; cacheCreate?: number }): number {
  const r = rateFor(model);
  const i = (tokens.input ?? 0) * r.input;
  const o = (tokens.output ?? 0) * r.output;
  const cr = (tokens.cacheRead ?? 0) * r.cacheRead;
  const cc = (tokens.cacheCreate ?? 0) * r.cacheCreate;
  return (i + o + cr + cc) / 1_000_000;
}
