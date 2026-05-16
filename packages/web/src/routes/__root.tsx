import { createRootRouteWithContext, Link, Outlet, retainSearchParams, useNavigate } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { PRESETS, rangeKey, useRange } from '../lib/range';

/** Global time-range filter — carried in the URL across every route. */
interface RootSearch {
  range?: string;
  from?: number;
  to?: number;
}

function coerceNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  validateSearch: (s: Record<string, unknown>): RootSearch => ({
    range: typeof s.range === 'string' ? s.range : undefined,
    from: coerceNum(s.from),
    to: coerceNum(s.to),
  }),
  search: { middlewares: [retainSearchParams(['range', 'from', 'to'])] },
  component: RootLayout,
});

function RootLayout() {
  const { lastIngest, status } = useStream();
  return (
    <div className="min-h-screen flex flex-col bg-ink-0 text-ink-700">
      <header className="sticky top-0 z-30 bg-ink-0/90 backdrop-blur border-b border-ink-300">
        <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center gap-5">
          <Link
            to="/"
            search={(prev) => ({ range: prev.range, from: prev.from, to: prev.to })}
            className="flex items-center gap-2.5 group"
          >
            <PulseMark />
            <span className="font-semibold tracking-tight text-ink-900 text-[15px]">ccpulse</span>
            <span className="text-ink-500 text-[11px] font-mono pl-1.5 ml-1.5 border-l border-ink-300">v0.1</span>
          </Link>
          <span className="hidden lg:inline text-ink-500 text-xs">real-time analytics for Claude Code sessions</span>
          <div className="ml-auto flex items-center gap-3">
            <RangeControl />
            <LivePill since={lastIngest} status={status} />
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-[1400px] mx-auto w-full px-6 py-8">
        <Outlet />
      </main>
      <footer className="border-t border-ink-300 mt-12">
        <div className="max-w-[1400px] mx-auto px-6 py-4 text-[11px] text-ink-500 font-mono flex justify-between">
          <span>local · zero telemetry</span>
          <span>watching ~/.claude/projects</span>
        </div>
      </footer>
    </div>
  );
}

/* ============================================================================
   GLOBAL TIME-RANGE CONTROL
============================================================================ */

const PRESET_TOKENS = ['24h', '7d', '30d'] as const;

function pad(n: number) { return String(n).padStart(2, '0'); }

/** epoch ms → `YYYY-MM-DDTHH:mm` for <input type="datetime-local"> (local tz). */
function toLocalInput(ms?: number): string {
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(s: string): number | undefined {
  if (!s) return undefined;
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function RangeControl() {
  const navigate = useNavigate();
  const range = useRange();
  const active = rangeKey(range);
  const isCustom = active.startsWith('c:');
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Custom-popover draft state, seeded from the current window (or a 7d default).
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const applyPreset = (token: string) => {
    setOpen(false);
    navigate({
      to: '.',
      search: (p: Record<string, unknown>) => ({
        ...p,
        range: token === 'all' ? undefined : token,
        from: undefined,
        to: undefined,
      }),
    });
  };

  const openCustom = () => {
    const now = Date.now();
    setDraftFrom(toLocalInput(range.from ?? now - 7 * 86_400_000));
    setDraftTo(toLocalInput(range.to ?? now));
    setOpen(true);
  };

  const applyCustom = () => {
    const from = fromLocalInput(draftFrom);
    const to = fromLocalInput(draftTo);
    if (from == null && to == null) return;
    setOpen(false);
    navigate({ to: '.', search: (p: Record<string, unknown>) => ({ ...p, range: undefined, from, to }) });
  };

  return (
    <div ref={wrap} className="relative flex items-center gap-1">
      <div className="hidden sm:flex items-center gap-0.5 rounded-md border border-ink-300 bg-ink-50 p-0.5">
        {PRESET_TOKENS.map((t) => (
          <RangeChip key={t} label={PRESETS[t].label} on={active === t} onClick={() => applyPreset(t)} />
        ))}
        <RangeChip label="All" on={active === 'all'} onClick={() => applyPreset('all')} />
        <RangeChip label="Custom" on={isCustom} onClick={openCustom} caret />
      </div>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-40 w-64 rounded-md border border-ink-300 bg-ink-50 shadow-2xl p-3 space-y-2.5">
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-500 font-medium">Custom range</div>
          <label className="block">
            <span className="text-[10px] text-ink-500 font-mono">from</span>
            <input
              type="datetime-local"
              value={draftFrom}
              onChange={(e) => setDraftFrom(e.target.value)}
              className="w-full mt-0.5 bg-ink-0 border border-ink-300 rounded px-2 py-1 text-[12px] text-ink-800 font-mono focus:outline-none focus:border-pulse/60"
            />
          </label>
          <label className="block">
            <span className="text-[10px] text-ink-500 font-mono">to</span>
            <input
              type="datetime-local"
              value={draftTo}
              onChange={(e) => setDraftTo(e.target.value)}
              className="w-full mt-0.5 bg-ink-0 border border-ink-300 rounded px-2 py-1 text-[12px] text-ink-800 font-mono focus:outline-none focus:border-pulse/60"
            />
          </label>
          <div className="flex justify-end gap-2 pt-0.5">
            <button
              onClick={() => setOpen(false)}
              className="text-[11px] font-mono text-ink-500 hover:text-ink-800 px-2 py-1"
            >
              cancel
            </button>
            <button
              onClick={applyCustom}
              className="text-[11px] font-mono text-pulse-glow bg-pulse/10 border border-pulse/40 rounded px-2.5 py-1 hover:bg-pulse/20"
            >
              apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RangeChip({ label, on, onClick, caret }: { label: string; on: boolean; onClick: () => void; caret?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={[
        'px-2 py-1 rounded text-[11px] font-mono transition-colors',
        on ? 'bg-pulse/15 text-pulse-glow' : 'text-ink-500 hover:text-ink-800 hover:bg-ink-100',
      ].join(' ')}
    >
      {label}{caret && <span className="ml-1 text-[9px] opacity-70">▾</span>}
    </button>
  );
}

function PulseMark() {
  return (
    <span className="relative inline-flex items-center justify-center w-7 h-7 rounded-md bg-ink-100 border border-ink-300 group-hover:border-pulse/60 transition-colors">
      <span className="absolute inset-0 rounded-md bg-pulse/0 group-hover:bg-pulse/5 transition-colors" />
      <svg viewBox="0 0 16 16" className="w-4 h-4">
        <path d="M1 8 L4 8 L5.5 4 L8 12 L10.5 6 L12 8 L15 8" fill="none" stroke="currentColor" className="text-pulse" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

type StreamStatus = 'connecting' | 'open' | 'error';

function LivePill({ since, status }: { since: number; status: StreamStatus }) {
  const ago = useTick(since);
  const fresh = since > 0 && Date.now() - since < 4000;
  const ok = status === 'open';
  const dotColor = !ok ? 'bg-rose-400' : fresh ? 'bg-pulse' : 'bg-ink-500';
  const label =
    status === 'connecting' ? 'connecting…' :
    status === 'error' ? 'disconnected' :
    fresh ? `live · ${ago}` :
    since ? `idle · last ${ago}` :
    'idle';
  const tone = !ok ? 'text-rose-300' : 'text-ink-600';
  return (
    <div className={`flex items-center gap-2 text-[11px] font-mono ${tone}`} title={`SSE ${status}${since ? ` · last ingest ${new Date(since).toLocaleTimeString()}` : ''}`}>
      <span className="relative inline-flex w-2 h-2">
        {fresh && <span className="absolute inset-0 rounded-full bg-pulse opacity-60 animate-ping" />}
        <span className={`relative inline-flex w-2 h-2 rounded-full ${dotColor}`} />
      </span>
      <span>{label}</span>
    </div>
  );
}

function useTick(stamp: number) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (!stamp) return;
    const id = setInterval(() => setT((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [stamp]);
  if (!stamp) return '';
  const dt = Math.max(0, Date.now() - stamp);
  if (dt < 1500) return 'now';
  if (dt < 60000) return `${Math.round(dt / 1000)}s ago`;
  if (dt < 3600000) return `${Math.round(dt / 60000)}m ago`;
  return `${Math.round(dt / 3600000)}h ago`;
}

function useStream(): { lastIngest: number; status: StreamStatus } {
  const [lastIngest, setLastIngest] = useState(0);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  useEffect(() => {
    const src = new EventSource('/api/stream');
    const onIngest = () => setLastIngest(Date.now());
    const onPing = () => setStatus('open'); // ping confirms channel is alive
    const onOpen = () => setStatus('open');
    const onError = () => setStatus(src.readyState === EventSource.OPEN ? 'open' : 'error');
    src.addEventListener('ingest', onIngest);
    src.addEventListener('ping', onPing);
    src.addEventListener('open', onOpen);
    src.addEventListener('error', onError);
    return () => {
      src.removeEventListener('ingest', onIngest);
      src.removeEventListener('ping', onPing);
      src.removeEventListener('open', onOpen);
      src.removeEventListener('error', onError);
      src.close();
    };
  }, []);
  return { lastIngest, status };
}
