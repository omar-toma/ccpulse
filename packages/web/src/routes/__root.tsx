import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
});

function RootLayout() {
  const { lastIngest, status } = useStream();
  return (
    <div className="min-h-screen flex flex-col bg-ink-0 text-ink-700">
      <header className="sticky top-0 z-30 bg-ink-0/90 backdrop-blur border-b border-ink-300">
        <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center gap-5">
          <Link to="/" className="flex items-center gap-2.5 group">
            <PulseMark />
            <span className="font-semibold tracking-tight text-ink-900 text-[15px]">ccpulse</span>
            <span className="text-ink-500 text-[11px] font-mono pl-1.5 ml-1.5 border-l border-ink-300">v0.1</span>
          </Link>
          <span className="hidden md:inline text-ink-500 text-xs">real-time analytics for Claude Code sessions</span>
          <div className="ml-auto flex items-center gap-3">
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
