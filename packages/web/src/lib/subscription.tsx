import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';

export type StreamStatus = 'connecting' | 'open' | 'error' | 'paused';

interface IngestPayload {
  cwd: string | null;
  stats: { events: number; toolCalls: number; toolResults: number; aiTitles: number };
}

interface SubscriptionValue {
  status: StreamStatus;
  lastIngest: number;
  enabled: boolean;
  toggle: () => void;
}

const SubscriptionContext = createContext<SubscriptionValue | null>(null);

const STORAGE_KEY = 'ccpulse:subscribe';

function readEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  // Default ON for first-ever visit; a stored 'false' is a deliberate opt-out.
  return window.localStorage.getItem(STORAGE_KEY) !== 'false';
}

export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(readEnabled);
  const [status, setStatus] = useState<StreamStatus>(enabled ? 'connecting' : 'paused');
  const [lastIngest, setLastIngest] = useState(0);
  // Persists across effect runs so a toggle off→on reconnect triggers the
  // refresh; only the very first connect of the page session is exempt.
  const connectedOnce = useRef(false);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // storage unavailable — state still lives in memory for this session
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus('paused');
      return;
    }
    setStatus('connecting');
    const src = new EventSource('/api/stream');

    const onIngest = (ev: Event) => {
      setLastIngest(Date.now());
      try {
        const data = JSON.parse((ev as MessageEvent).data) as IngestPayload;
        qc.invalidateQueries({ queryKey: ['projects'] });
        qc.invalidateQueries({ queryKey: ['totals'] });
        // Session-scoped queries (any sid). The ingest payload does not carry the
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
        // ignore malformed payloads
      }
    };
    const onConnected = () => {
      setStatus('open');
      // The page-load connect lands on freshly fetched queries — no refresh
      // needed. Every later transition into 'open' (manual re-subscribe or
      // error auto-reconnect) means ingest events were missed while the socket
      // was down: invalidate everything so all cached data refetches.
      if (!connectedOnce.current) {
        connectedOnce.current = true;
        return;
      }
      qc.invalidateQueries();
    };
    const onPing = () => onConnected(); // ping confirms the channel is alive
    const onOpen = () => onConnected();
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
  }, [enabled, qc]);

  return (
    <SubscriptionContext.Provider value={{ status, lastIngest, enabled, toggle }}>
      {children}
    </SubscriptionContext.Provider>
  );
}

export function useSubscription(): SubscriptionValue {
  const ctx = useContext(SubscriptionContext);
  if (!ctx) throw new Error('useSubscription must be used within SubscriptionProvider');
  return ctx;
}
