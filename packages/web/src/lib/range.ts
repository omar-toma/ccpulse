import { useSearch } from '@tanstack/react-router';

/* ============================================================================
   Global time-range filter model.

   A range lives in the URL as either a preset token (`range=7d`) or an absolute
   custom window (`from`/`to`, epoch ms). Presets are *rolling* — resolved against
   `Date.now()` at fetch time — so the react-query key uses the stable token, not
   the resolved bound, to avoid a refetch storm.
============================================================================ */

export type RangePreset = '24h' | '7d' | '30d';

export const PRESETS: Record<RangePreset, { label: string; ms: number }> = {
  '24h': { label: '24h', ms: 24 * 60 * 60 * 1000 },
  '7d': { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  '30d': { label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
};

/** URL-facing range descriptor. `range` token wins; else absolute `from`/`to`. */
export interface RangeParam {
  range?: string; // '24h' | '7d' | '30d' | 'all' | undefined
  from?: number; // absolute epoch ms (custom window)
  to?: number;
}

function isPreset(v: string | undefined): v is RangePreset {
  return v != null && v in PRESETS;
}

/** Resolve a descriptor to concrete epoch-ms bounds for an API call. */
export function resolveRange(r: RangeParam | undefined): { from?: number; to?: number } {
  if (!r) return {};
  if (isPreset(r.range)) return { from: Date.now() - PRESETS[r.range].ms };
  if (r.range === 'all') return {};
  if (r.from != null || r.to != null) return { from: r.from, to: r.to };
  return {};
}

/** Stable react-query key fragment — never resolves "now". */
export function rangeKey(r: RangeParam | undefined): string {
  if (!r) return 'all';
  if (isPreset(r.range)) return r.range;
  if (r.from != null || r.to != null) return `c:${r.from ?? ''}-${r.to ?? ''}`;
  return 'all';
}

/** True when a non-"All" range is active (drives greyed rows / empty states). */
export function isRangeActive(r: RangeParam | undefined): boolean {
  return rangeKey(r) !== 'all';
}

/** Short human label for the active range, e.g. "7d" or "May 9 – May 16". */
export function rangeLabel(r: RangeParam | undefined): string {
  if (!r || rangeKey(r) === 'all') return 'All time';
  if (isPreset(r.range)) return `Last ${PRESETS[r.range].label}`;
  const fmt = (ms?: number) =>
    ms != null ? new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '…';
  return `${fmt(r.from)} – ${fmt(r.to)}`;
}

/** Read the global range from the URL search params (works on any route). */
export function useRange(): RangeParam {
  const s = useSearch({ strict: false }) as Record<string, unknown>;
  return {
    range: typeof s.range === 'string' ? s.range : undefined,
    from: typeof s.from === 'number' ? s.from : undefined,
    to: typeof s.to === 'number' ? s.to : undefined,
  };
}
