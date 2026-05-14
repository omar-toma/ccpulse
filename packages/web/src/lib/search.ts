import { useEffect, useState } from 'react';
import type { FuseResult } from 'fuse.js';

/**
 * Re-rank fuse.js results by combining match score, recency, and usage signals.
 * Returns a flat array of items ordered best-first.
 *
 *   final = matchScore * 0.6 + recency * 0.25 + usage * 0.15
 *
 *  - matchScore: 1 - fuse.score (fuse: 0=perfect)
 *  - recency:    linear decay over `recencyMaxAgeMs` (default 30 days)
 *  - usage:      log1p(rawUsage) / 10, clamped >= 0 so outliers don't dominate
 */
export function rankResults<T>(
  results: FuseResult<T>[],
  getRecency: (item: T) => number,
  getUsage: (item: T) => number,
  recencyMaxAgeMs = 30 * 24 * 60 * 60 * 1000,
): T[] {
  const now = Date.now();
  return results
    .map((r) => {
      const matchScore = 1 - (r.score ?? 0);
      const age = now - getRecency(r.item);
      const recency = Math.max(0, 1 - age / recencyMaxAgeMs);
      const usage = Math.log1p(Math.max(0, getUsage(r.item))) / 10;
      return { item: r.item, rank: matchScore * 0.6 + recency * 0.25 + usage * 0.15 };
    })
    .sort((a, b) => b.rank - a.rank)
    .map((r) => r.item);
}

/** Debounce a changing value. Returns the latest `value` after `ms` of silence. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
