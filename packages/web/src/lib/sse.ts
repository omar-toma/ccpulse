import type { QueryClient } from '@tanstack/react-query';

interface IngestPayload {
  cwd: string | null;
  stats: { events: number; toolCalls: number; toolResults: number; aiTitles: number };
}

export function startSseStream(qc: QueryClient) {
  if (typeof window === 'undefined') return;
  const src = new EventSource('/api/stream');
  src.addEventListener('ingest', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as IngestPayload;
      // global lists
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['totals'] });
      // session-scoped queries (any sid). The ingest payload does not carry the
      // session id, so invalidate the whole prefix; React Query refetches only
      // active queries.
      qc.invalidateQueries({ queryKey: ['session'] });
      qc.invalidateQueries({ queryKey: ['sessionTools'] });
      qc.invalidateQueries({ queryKey: ['event'] });
      if (data.cwd) {
        qc.invalidateQueries({ queryKey: ['sessions', data.cwd] });
        qc.invalidateQueries({ queryKey: ['projectTools', data.cwd] });
        qc.invalidateQueries({ queryKey: ['projectModels', data.cwd] });
      }
    } catch {
      // ignore
    }
  });
  src.onerror = () => {
    // EventSource auto-reconnects; nothing to do
  };
}
