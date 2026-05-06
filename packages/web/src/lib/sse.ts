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
      // invalidate global lists
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['totals'] });
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
