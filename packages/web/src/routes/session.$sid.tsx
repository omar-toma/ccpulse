import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Card, CardHeader, EmptyState, Skeleton, Stat, fmtTokens, fmtMs, fmtDuration } from './index';

export const Route = createFileRoute('/session/$sid')({
  component: SessionView,
});

type SortBy = 'time' | 'in' | 'out' | 'cacheR' | 'cacheC' | 'total' | 'cost';
type SortDir = 'asc' | 'desc';

const KINDS = ['tool', 'claude', 'user', 'system', 'attachment', 'other'] as const;
type Kind = (typeof KINDS)[number];

function eventKind(e: any): Kind {
  if (e.role === 'user') return 'user';
  if (e.role === 'assistant') return e.tool_name ? 'tool' : 'claude';
  if (e.type === 'system') return 'system';
  if (e.type === 'attachment') return 'attachment';
  return 'other';
}

function eventTotalTokens(e: any): number {
  return (e.input_tokens ?? 0) + (e.output_tokens ?? 0) + (e.cache_read ?? 0) + (e.cache_create ?? 0);
}

function sortValue(e: any, by: SortBy): number {
  switch (by) {
    case 'time': return e.ts;
    case 'in': return e.input_tokens ?? 0;
    case 'out': return e.output_tokens ?? 0;
    case 'cacheR': return e.cache_read ?? 0;
    case 'cacheC': return e.cache_create ?? 0;
    case 'total': return eventTotalTokens(e);
    case 'cost': return e.cost ?? 0;
  }
}

function SessionView() {
  const { sid } = Route.useParams();
  const sess = useQuery({ queryKey: ['session', sid], queryFn: () => api.session(sid) });
  const tools = useQuery({ queryKey: ['sessionTools', sid], queryFn: () => api.sessionTools(sid) });

  const events = sess.data?.events ?? [];
  const meta = sess.data?.session;
  const projectCwd = meta?.projectRoot ?? meta?.cwd ?? null;
  const projectName = projectCwd ? projectCwd.slice(projectCwd.lastIndexOf('/') + 1) : null;
  const sessionLabel = meta?.title ?? sid;

  const totals = events.reduce(
    (a, e: any) => ({
      input: a.input + (e.input_tokens ?? 0),
      output: a.output + (e.output_tokens ?? 0),
      cacheR: a.cacheR + (e.cache_read ?? 0),
      cacheC: a.cacheC + (e.cache_create ?? 0),
      cost: a.cost + (e.cost ?? 0),
    }),
    { input: 0, output: 0, cacheR: 0, cacheC: 0, cost: 0 },
  );

  const start = events[0]?.ts;
  const end = events[events.length - 1]?.ts;
  const duration = start && end ? end - start : 0;
  const toolMax = (tools.data?.[0]?.count ?? 0) || 1;

  const kindCounts = useMemo(() => {
    const m = new Map<Kind, number>();
    for (const e of events) m.set(eventKind(e), (m.get(eventKind(e)) ?? 0) + 1);
    return m;
  }, [events]);

  const [sortBy, setSortBy] = usePersistedState<SortBy>('ccpulse:timeline:sortBy', 'time');
  const [sortDir, setSortDir] = usePersistedState<SortDir>('ccpulse:timeline:sortDir', 'desc');
  const [enabled, setEnabled] = usePersistedKindSet('ccpulse:timeline:kinds', new Set(KINDS));
  const [openUuid, setOpenUuid] = useState<string | null>(null);

  const visibleEvents = useMemo(() => {
    const filtered = events.filter((e: any) => enabled.has(eventKind(e)));
    const cmp = (a: any, b: any) => {
      const av = sortValue(a, sortBy);
      const bv = sortValue(b, sortBy);
      return sortDir === 'asc' ? av - bv : bv - av;
    };
    return filtered.slice().sort(cmp);
  }, [events, enabled, sortBy, sortDir]);

  const toggleSort = (col: SortBy) => {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(col); setSortDir('desc'); }
  };
  const toggleKind = (k: Kind) => setEnabled((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const setAll = () => setEnabled(new Set(KINDS));
  const setNone = () => setEnabled(new Set());

  return (
    <div className="space-y-8">
      <div>
        <Link to="/" className="text-[11px] text-ink-500 hover:text-ink-700 font-mono">← projects</Link>
        <h1 className="mt-2 font-mono text-xl text-ink-900 tracking-tight truncate">
          {projectName && (
            <>
              <Link
                to="/"
                search={{ project: projectCwd! }}
                className="text-ink-500 hover:text-ink-800"
              >
                {projectName}
              </Link>
              <span className="text-ink-400 mx-2">/</span>
            </>
          )}
          <span className="text-ink-900">{sessionLabel}</span>
        </h1>
        <div className="mt-1 text-[11px] font-mono text-ink-500">
          {meta?.title ? <span className="mr-2">{sid}</span> : null}
          {events.length} events  ·  duration {fmtDuration(duration)}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Cost" value={`$${totals.cost.toFixed(2)}`} sub="estimated" accent />
        <Stat label="Input" value={fmtTokens(totals.input)} sub="prompt tokens" />
        <Stat label="Output" value={fmtTokens(totals.output)} sub="completion tokens" />
        <Stat label="Cache read" value={fmtTokens(totals.cacheR)} sub="hit, free" />
        <Stat label="Cache create" value={fmtTokens(totals.cacheC)} sub="written this run" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card className="md:col-span-3">
          <CardHeader title="Tool usage" hint="count · avg · p95" />
          {tools.isLoading && <Skeleton rows={6} />}
          {tools.data && tools.data.length === 0 && <EmptyState title="No tool calls" body="" compact />}
          <ul className="space-y-1 max-h-[22rem] overflow-auto pr-1">
            {(tools.data ?? []).map((t, i) => (
              <li key={t.name} className="relative">
                <div className="absolute inset-y-0 left-0 bg-ink-200 rounded" style={{ width: `${(t.count / toolMax) * 100}%` }} />
                <div className="relative px-3 py-2 flex items-center gap-3 text-[13px]">
                  <span className="text-ink-500 font-mono w-5 text-right">{i + 1}</span>
                  <span className="font-mono font-medium text-ink-800 truncate flex-1">{t.name}</span>
                  {t.avgLatencyMs != null && (
                    <span className="font-mono text-[11px] text-ink-500 whitespace-nowrap">
                      {fmtMs(t.avgLatencyMs)}{t.p95LatencyMs != null ? ` · p95 ${fmtMs(t.p95LatencyMs)}` : ''}
                    </span>
                  )}
                  <span className="font-mono text-ink-900 tabular-nums w-12 text-right">{t.count}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader title="Idle gaps" hint="pauses > 2 min" />
          {sess.isLoading && <Skeleton rows={3} />}
          {sess.data && sess.data.gaps.length === 0 && <EmptyState title="No idle gaps" body="Continuous activity throughout the session." compact />}
          <ul className="space-y-1.5 max-h-[22rem] overflow-auto pr-1">
            {[...(sess.data?.gaps ?? [])].sort((a: any, b: any) => b.durationMs - a.durationMs).map((g: any, i: number) => (
              <li key={i} className="px-3 py-1.5 flex items-baseline justify-between text-[12px] font-mono">
                <span className="text-ink-500">{new Date(g.from).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="text-ink-700">{fmtDuration(g.durationMs)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader title="Timeline" hint={`${visibleEvents.length} of ${events.length} events`} />

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-ink-500 font-medium pr-1">Filter:</span>
          {KINDS.map((k) => (
            <KindChip key={k} kind={k} count={kindCounts.get(k) ?? 0} active={enabled.has(k)} onToggle={() => toggleKind(k)} />
          ))}
          <span className="ml-auto flex gap-2 text-[11px] font-mono">
            <button onClick={setAll} disabled={enabled.size === KINDS.length} className="text-ink-500 hover:text-ink-800 disabled:opacity-40 disabled:hover:text-ink-500">all</button>
            <span className="text-ink-400">·</span>
            <button onClick={setNone} disabled={enabled.size === 0} className="text-ink-500 hover:text-ink-800 disabled:opacity-40 disabled:hover:text-ink-500">none</button>
          </span>
        </div>

        <div className="max-h-[32rem] overflow-auto -mx-4 -mb-4 border-t border-ink-300">
          <table className="w-full text-[12px] font-mono">
            <thead className="sticky top-0 bg-ink-50 z-10">
              <tr className="text-left text-ink-500 border-b border-ink-300">
                <SortHeader label="time"   col="time"   sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} className="w-24" />
                <th className="px-2 py-1.5 font-medium w-20">kind</th>
                <th className="px-2 py-1.5 font-medium">detail</th>
                <SortHeader label="in"     col="in"     sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} className="w-16 text-right" align="right" />
                <SortHeader label="out"    col="out"    sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} className="w-16 text-right" align="right" />
                <SortHeader label="cache↓" col="cacheR" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} className="w-20 text-right" align="right" />
                <SortHeader label="cache↑" col="cacheC" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} className="w-20 text-right" align="right" />
                <SortHeader label="total"  col="total"  sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} className="w-20 text-right" align="right" />
                <SortHeader label="$"      col="cost"   sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} className="w-20 text-right" align="right" />
              </tr>
            </thead>
            <tbody>
              {visibleEvents.length === 0 && (
                <tr><td colSpan={9} className="text-center py-8 text-ink-500">No events match the current filter.</td></tr>
              )}
              {visibleEvents.map((e: any) => (
                <EventRow key={e.uuid} e={e} onOpen={setOpenUuid} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {openUuid && (
        <EventModal
          uuid={openUuid}
          uuids={visibleEvents.map((e: any) => e.uuid)}
          onChange={setOpenUuid}
          onClose={() => setOpenUuid(null)}
        />
      )}
    </div>
  );
}

function EventRow({ e, onOpen, indent }: { e: any; onOpen: (uuid: string) => void; indent?: boolean }) {
  const total = eventTotalTokens(e);
  return (
    <tr
      onClick={() => onOpen(e.uuid)}
      className={`border-t border-ink-300/60 hover:bg-ink-100/50 cursor-pointer ${indent ? 'bg-indigo-500/[0.02]' : ''}`}
    >
      <td className={`px-3 py-1.5 text-ink-500 whitespace-nowrap ${indent ? 'pl-8' : ''}`}>
        {new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </td>
      <td className="px-2 py-1.5"><KindBadge kind={eventKind(e)} /></td>
      <td className="px-2 py-1.5 text-ink-700 max-w-[1px] align-top">
        <div className="flex items-baseline gap-2 flex-wrap">
          {e.tool_name && <span className="text-pulse">{e.tool_name}</span>}
          {e.tool_name && e.model && <span className="text-ink-400">·</span>}
          {e.model && <span className="text-ink-500">{e.model}</span>}
          {e.hasThinking && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 text-[9px] italic">
              <span aria-hidden>✶</span> thinking
            </span>
          )}
          {e.is_sidechain ? <span className="px-1 rounded bg-fuchsia-500/15 text-fuchsia-300 text-[9px]">side</span> : null}
        </div>
        {e.summary && (
          <div className="text-ink-500 font-sans text-[12px] leading-snug line-clamp-2 mt-0.5 whitespace-pre-wrap break-words">
            {e.summary}
          </div>
        )}
      </td>
      <Num value={e.input_tokens} />
      <Num value={e.output_tokens} />
      <Num value={e.cache_read} />
      <Num value={e.cache_create} />
      <Num value={total} emphasis />
      <td className={`px-2 py-1.5 text-right whitespace-nowrap tabular-nums ${e.cost > 0 ? 'text-pulse-glow' : 'text-ink-400'}`}>
        {e.cost > 0 ? `$${e.cost.toFixed(4)}` : '—'}
      </td>
    </tr>
  );
}

/* ============================================================================
   EVENT DETAIL MODAL
============================================================================ */

function EventModal({
  uuid, uuids, onChange, onClose,
}: {
  uuid: string;
  uuids: string[];
  onChange: (uuid: string) => void;
  onClose: () => void;
}) {
  const detail = useQuery({ queryKey: ['event', uuid], queryFn: () => api.event(uuid) });

  const idx = uuids.indexOf(uuid);
  const prevUuid = idx > 0 ? uuids[idx - 1] : null;
  const nextUuid = idx >= 0 && idx < uuids.length - 1 ? uuids[idx + 1] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (e.key === 'ArrowUp' || e.key === 'k')  { if (prevUuid) { e.preventDefault(); onChange(prevUuid); } }
      if (e.key === 'ArrowDown' || e.key === 'j') { if (nextUuid) { e.preventDefault(); onChange(nextUuid); } }
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose, onChange, prevUuid, nextUuid]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center p-6 pt-[8vh] overflow-auto"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-3xl rounded-lg border border-ink-300 bg-ink-50 shadow-2xl"
      >
        <div className="px-5 py-3 border-b border-ink-300 flex items-baseline gap-3">
          <h3 className="text-[12px] uppercase tracking-[0.16em] text-ink-700 font-medium">Event detail</h3>
          {detail.data && <KindBadge kind={eventKind(detail.data)} />}
          {idx >= 0 && (
            <span className="text-[10px] font-mono text-ink-500">
              {idx + 1} / {uuids.length}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => prevUuid && onChange(prevUuid)}
              disabled={!prevUuid}
              title="Previous (↑ / k)"
              aria-label="previous event"
              className="px-1.5 py-0.5 rounded text-ink-500 hover:text-ink-800 hover:bg-ink-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-500"
            >↑</button>
            <button
              onClick={() => nextUuid && onChange(nextUuid)}
              disabled={!nextUuid}
              title="Next (↓ / j)"
              aria-label="next event"
              className="px-1.5 py-0.5 rounded text-ink-500 hover:text-ink-800 hover:bg-ink-100 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-500"
            >↓</button>
            <span className="text-[10px] font-mono text-ink-500 ml-1 truncate max-w-[14rem]">{uuid}</span>
            <button onClick={onClose} className="text-ink-500 hover:text-ink-800 text-lg leading-none -mt-0.5 ml-1" aria-label="close">×</button>
          </div>
        </div>

        {detail.isLoading && <div className="p-5"><Skeleton rows={6} /></div>}
        {detail.error && <div className="p-5 text-rose-300 text-sm">Failed to load event.</div>}
        {detail.data && <EventBody d={detail.data} />}
      </div>
    </div>
  );
}

function EventBody({ d }: { d: any }) {
  const total = eventTotalTokens(d);
  const content = extractContent(d);
  return (
    <div className="p-5 space-y-5 max-h-[80vh] overflow-auto">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Mini label="time" value={new Date(d.ts).toLocaleString()} />
        <Mini label="role / type" value={d.role ?? d.type} />
        <Mini label="model" value={d.model ?? '—'} mono />
        <Mini label="cost" value={d.cost ? `$${d.cost.toFixed(6)}` : '—'} accent={!!d.cost} />
        <Mini label="input"        value={String(d.input_tokens ?? 0)} />
        <Mini label="output"       value={String(d.output_tokens ?? 0)} />
        <Mini label="cache read"   value={String(d.cache_read ?? 0)} />
        <Mini label="cache create" value={String(d.cache_create ?? 0)} />
        <Mini label="total tokens" value={String(total)} />
        <Mini label="branch"       value={d.git_branch ?? '—'} mono />
        <Mini label="version"      value={d.version ?? '—'} mono />
        <Mini label="sidechain"    value={d.is_sidechain ? 'yes' : 'no'} />
      </div>

      {content.length > 0 && (
        <div>
          <SectionLabel>Content</SectionLabel>
          <div className="space-y-2">
            {content.map((b, i) => <ContentBlock key={i} block={b} />)}
          </div>
        </div>
      )}

      {d.tool_name && d.toolCallInput != null && (
        <div>
          <SectionLabel>Tool input</SectionLabel>
          <div className="rounded border border-ink-300 bg-ink-0 p-3 space-y-2">
            <div className="flex items-baseline gap-3 text-[12px] font-mono">
              <span className="text-pulse">{d.tool_name}</span>
              {d.tool_use_id && <span className="text-ink-500 truncate">id: {d.tool_use_id}</span>}
              {d.toolResult && (
                <span className={`ml-auto text-[10px] ${d.toolResult.isError ? 'text-rose-300' : 'text-ink-500'}`}>
                  result: {d.toolResult.isError ? 'error' : 'ok'} · {fmtMs(Math.abs(d.toolResult.ts - d.ts))}
                </span>
              )}
            </div>
            <JsonBlock value={d.toolCallInput} />
          </div>
        </div>
      )}

      {d.raw && (
        <details className="group">
          <summary className="text-[10px] uppercase tracking-[0.16em] text-ink-500 font-medium cursor-pointer select-none hover:text-ink-700 list-none">
            <span className="inline-block w-3 transition-transform group-open:rotate-90">▸</span> Raw JSONL
          </summary>
          <div className="mt-2"><JsonBlock value={d.raw} /></div>
        </details>
      )}

      <div>
        <SectionLabel>Identity</SectionLabel>
        <dl className="rounded border border-ink-300 bg-ink-0 divide-y divide-ink-300 text-[12px] font-mono">
          <KV k="uuid" v={d.uuid} />
          <KV k="parent" v={d.parent_uuid ?? '—'} />
          <KV k="session" v={d.session_id} />
          <KV k="cwd" v={d.cwd ?? '—'} />
        </dl>
      </div>
    </div>
  );
}

function extractContent(d: any): any[] {
  // Anthropic message format
  if (d.message) {
    const c = d.message.content;
    if (typeof c === 'string') return [{ type: 'text', text: c }];
    if (Array.isArray(c)) return c;
  }
  if (d.type === 'attachment' && d.raw?.attachment) {
    return [{ type: 'attachment_card', value: d.raw.attachment }];
  }
  if (d.type === 'system' && d.raw) {
    return [{ type: 'system_card', value: d.raw }];
  }
  return [];
}

const NOISE_KEYS = new Set([
  'parentUuid', 'sessionId', 'uuid', 'timestamp', 'userType', 'entrypoint',
  'version', 'gitBranch', 'isSidechain', 'cwd', 'leafUuid', 'slug', 'type',
  'promptId', 'requestId', 'attributionSkill',
]);

function pretty(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function ContentBlock({ block }: { block: any }) {
  if (!block) return null;

  if (block.type === 'text') {
    return <TextBubble label="text" text={block.text ?? ''} />;
  }
  if (block.type === 'thinking') {
    return <TextBubble label="thinking" text={block.thinking ?? block.text ?? ''} muted />;
  }
  if (block.type === 'tool_use') {
    return (
      <div className="rounded border border-pulse/30 bg-pulse/[0.04] p-3 space-y-2">
        <div className="flex items-baseline gap-3 text-[12px] font-mono">
          <span className="text-[9px] uppercase tracking-[0.14em] text-pulse-glow">tool_use</span>
          <span className="text-pulse">{block.name}</span>
          {block.id && <span className="text-ink-500 truncate">id: {block.id}</span>}
        </div>
        {block.input != null && <JsonBlock value={block.input} />}
      </div>
    );
  }
  if (block.type === 'tool_result') {
    const text = stringifyToolResult(block.content);
    return (
      <div className="rounded border border-ink-300 bg-ink-0 p-3 space-y-2">
        <div className="flex items-baseline gap-3 text-[12px] font-mono">
          <span className={`text-[9px] uppercase tracking-[0.14em] ${block.is_error ? 'text-rose-300' : 'text-ink-500'}`}>
            tool_result{block.is_error ? ' · error' : ''}
          </span>
          {block.tool_use_id && <span className="text-ink-500 truncate">for: {block.tool_use_id}</span>}
        </div>
        {text && <pre className="text-[11px] leading-snug font-mono whitespace-pre-wrap break-words text-ink-700 max-h-72 overflow-auto">{truncate(text, 4000)}</pre>}
      </div>
    );
  }
  if (block.type === 'attachment_card') {
    return <AttachmentCard a={block.value} />;
  }
  if (block.type === 'system_card') {
    return <SystemCard s={block.value} />;
  }
  // unknown — fall back to JSON
  return (
    <div className="rounded border border-ink-300 bg-ink-0 p-3">
      <div className="text-[9px] uppercase tracking-[0.14em] text-ink-500 mb-1.5">{String(block.type ?? 'unknown')}</div>
      <JsonBlock value={block} />
    </div>
  );
}

function TextBubble({ label, text, muted }: { label: string; text: string; muted?: boolean }) {
  return (
    <div className={`rounded border border-ink-300 ${muted ? 'bg-ink-100/50 text-ink-500' : 'bg-ink-0 text-ink-700'} p-3`}>
      <div className={`text-[9px] uppercase tracking-[0.14em] ${muted ? 'text-ink-500' : 'text-ink-500'} mb-1.5`}>{label}</div>
      <pre className="text-[12px] leading-relaxed whitespace-pre-wrap break-words font-sans">{truncate(text, 8000)}</pre>
    </div>
  );
}

function AttachmentCard({ a }: { a: any }) {
  if (!a || typeof a !== 'object') {
    return (
      <div className="rounded border border-fuchsia-500/30 bg-fuchsia-500/[0.05] p-3">
        <div className="text-[9px] uppercase tracking-[0.14em] text-fuchsia-300 mb-1.5">attachment</div>
        <pre className="text-[12px] font-mono text-ink-700">{pretty(a)}</pre>
      </div>
    );
  }
  const headline = a.hookName || a.hookEvent || a.reminderType || a.filename || a.displayPath || a.subtype;
  const content: string | null =
    typeof a.content === 'string' ? a.content :
    typeof a.snippet === 'string' ? a.snippet :
    typeof a.planContent === 'string' ? a.planContent :
    typeof a.stdout === 'string' ? a.stdout :
    null;
  const fields = collectKeyValues(a, new Set(['type', 'content', 'snippet', 'planContent', 'stdout']));
  return (
    <div className="rounded border border-fuchsia-500/30 bg-fuchsia-500/[0.04]">
      <div className="px-3 py-2 border-b border-fuchsia-500/20 flex items-baseline gap-2">
        <span className="text-[9px] uppercase tracking-[0.14em] text-fuchsia-300">attachment</span>
        <span className="text-[12px] font-mono text-fuchsia-200">{a.type ?? 'unknown'}</span>
        {headline && <span className="text-[12px] text-ink-700 truncate">· {headline}</span>}
      </div>
      <div className="p-3 space-y-3">
        {fields.length > 0 && <KeyValueGrid pairs={fields} />}
        {content && (
          <pre className="text-[12px] leading-relaxed whitespace-pre-wrap break-words font-sans text-ink-700 max-h-72 overflow-auto rounded bg-ink-0 border border-ink-300 p-3">
            {truncate(content, 8000)}
          </pre>
        )}
        {!content && fields.length === 0 && (
          <div className="text-[11px] text-ink-500 font-mono">no extra payload</div>
        )}
      </div>
    </div>
  );
}

function SystemCard({ s }: { s: any }) {
  const subtype = s.subtype ?? 'system';
  const headline =
    s.subtype === 'turn_duration' && typeof s.durationMs === 'number' ? fmtMs(s.durationMs) :
    s.stopReason ?? null;

  const stdout = typeof s.stdout === 'string' ? s.stdout : null;
  const stderr = typeof s.stderr === 'string' ? s.stderr : null;
  const command = typeof s.command === 'string' ? s.command : null;
  const fields = collectKeyValues(s, new Set([
    ...NOISE_KEYS,
    'hookInfos', 'hookErrors', 'stdout', 'stderr', 'command', 'subtype',
  ]));
  const hookInfos = Array.isArray(s.hookInfos) ? s.hookInfos.filter(Boolean) : [];
  const hookErrors = Array.isArray(s.hookErrors) ? s.hookErrors.filter(Boolean) : [];

  return (
    <div className="rounded border border-amber-500/30 bg-amber-500/[0.04]">
      <div className="px-3 py-2 border-b border-amber-500/20 flex items-baseline gap-2">
        <span className="text-[9px] uppercase tracking-[0.14em] text-amber-300">system</span>
        <span className="text-[12px] font-mono text-amber-200">{subtype}</span>
        {headline && <span className="text-[12px] text-ink-700 truncate">· {headline}</span>}
      </div>
      <div className="p-3 space-y-3">
        {fields.length > 0 && <KeyValueGrid pairs={fields} />}
        {command && (
          <Subsection label="command">
            <pre className="text-[12px] font-mono text-ink-700 whitespace-pre-wrap rounded bg-ink-0 border border-ink-300 p-3">{command}</pre>
          </Subsection>
        )}
        {stdout && (
          <Subsection label="stdout">
            <pre className="text-[12px] font-mono text-ink-700 whitespace-pre-wrap break-words rounded bg-ink-0 border border-ink-300 p-3 max-h-60 overflow-auto">{truncate(stdout, 4000)}</pre>
          </Subsection>
        )}
        {stderr && (
          <Subsection label="stderr">
            <pre className="text-[12px] font-mono text-rose-200 whitespace-pre-wrap break-words rounded bg-ink-0 border border-rose-500/30 p-3 max-h-60 overflow-auto">{truncate(stderr, 4000)}</pre>
          </Subsection>
        )}
        {hookErrors.length > 0 && (
          <Subsection label="hookErrors" tone="error">
            <JsonBlock value={hookErrors} />
          </Subsection>
        )}
        {hookInfos.length > 0 && (
          <Subsection label="hookInfos">
            <JsonBlock value={hookInfos} />
          </Subsection>
        )}
        {fields.length === 0 && !command && !stdout && !stderr && !hookErrors.length && !hookInfos.length && (
          <div className="text-[11px] text-ink-500 font-mono">no extra payload</div>
        )}
      </div>
    </div>
  );
}

function Subsection({ label, tone = 'normal', children }: { label: string; tone?: 'normal' | 'error'; children: React.ReactNode }) {
  return (
    <div>
      <div className={`text-[9px] uppercase tracking-[0.14em] mb-1 ${tone === 'error' ? 'text-rose-300' : 'text-ink-500'}`}>{label}</div>
      {children}
    </div>
  );
}

function collectKeyValues(obj: any, exclude: Set<string>): Array<[string, string]> {
  if (!obj || typeof obj !== 'object') return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (exclude.has(k)) continue;
    if (v == null) continue;
    if (typeof v === 'string' && v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    out.push([k, pretty(v)]);
  }
  return out;
}

function KeyValueGrid({ pairs }: { pairs: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] font-mono">
      {pairs.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[110px_1fr] gap-2 items-baseline border-b border-ink-300/50 pb-1">
          <dt className="text-ink-500 text-[10px] uppercase tracking-[0.1em] truncate">{k}</dt>
          <dd className="text-ink-700 truncate" title={v}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function stringifyToolResult(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => c?.type === 'text' ? c.text : JSON.stringify(c, null, 2)).join('\n');
  }
  return JSON.stringify(content, null, 2);
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n… (${(s.length - n).toLocaleString()} more chars)`;
}

function Num({ value, emphasis }: { value: number | null | undefined; emphasis?: boolean }) {
  const v = value ?? 0;
  return (
    <td className={`px-2 py-1.5 text-right tabular-nums whitespace-nowrap ${v === 0 ? 'text-ink-400' : emphasis ? 'text-ink-900' : 'text-ink-700'}`}>
      {v === 0 ? '—' : fmtTokens(v)}
    </td>
  );
}

function Mini({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: boolean }) {
  return (
    <div className="rounded border border-ink-300 bg-ink-0 px-3 py-2">
      <div className="text-[9px] uppercase tracking-[0.14em] text-ink-500 font-medium">{label}</div>
      <div className={`mt-0.5 text-[13px] truncate ${mono ? 'font-mono' : ''} ${accent ? 'text-pulse-glow' : 'text-ink-800'}`}>{value}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="px-3 py-1.5 grid grid-cols-[80px_1fr] gap-3 items-baseline">
      <dt className="text-ink-500 text-[10px] uppercase tracking-[0.14em]">{k}</dt>
      <dd className="text-ink-700 truncate">{v}</dd>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-500 font-medium">{children}</div>;
}

function JsonBlock({ value }: { value: unknown }) {
  const txt = JSON.stringify(value, null, 2);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(txt); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch {}
  };
  return (
    <div className="relative rounded border border-ink-300 bg-ink-0">
      <button
        onClick={copy}
        className="absolute top-1.5 right-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-ink-100 border border-ink-300 text-ink-500 hover:text-ink-800"
      >
        {copied ? 'copied' : 'copy'}
      </button>
      <pre className="p-3 text-[11px] leading-snug overflow-auto max-h-72 text-ink-700 font-mono whitespace-pre">{txt}</pre>
    </div>
  );
}

/* ============================================================================
   PRIMITIVES
============================================================================ */

function SortHeader({
  label, col, sortBy, sortDir, onClick, className = '', align = 'left',
}: {
  label: string;
  col: SortBy;
  sortBy: SortBy;
  sortDir: SortDir;
  onClick: (c: SortBy) => void;
  className?: string;
  align?: 'left' | 'right';
}) {
  const active = sortBy === col;
  return (
    <th className={`px-2 py-1.5 font-medium ${className}`}>
      <button
        onClick={() => onClick(col)}
        className={`inline-flex items-center gap-1 ${align === 'right' ? 'flex-row-reverse' : ''} ${active ? 'text-ink-800' : 'text-ink-500 hover:text-ink-700'} transition-colors`}
      >
        <span>{label}</span>
        <SortGlyph active={active} dir={sortDir} />
      </button>
    </th>
  );
}

function SortGlyph({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="text-ink-400 text-[9px] leading-none">⇅</span>;
  return <span className={`text-pulse text-[9px] leading-none`}>{dir === 'asc' ? '↑' : '↓'}</span>;
}

function KindChip({
  kind, count, active, onToggle,
}: {
  kind: Kind;
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  const styles = KIND_STYLES[kind];
  return (
    <button
      onClick={onToggle}
      disabled={count === 0}
      className={[
        'inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-mono border transition-colors',
        count === 0 ? 'opacity-30 cursor-not-allowed' : 'hover:border-ink-400',
        active
          ? `${styles.activeBg} ${styles.activeText} ${styles.activeBorder}`
          : 'bg-transparent text-ink-500 border-ink-300',
      ].join(' ')}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${active ? styles.dot : 'bg-ink-400'}`} />
      <span>{kind}</span>
      <span className={active ? 'text-ink-700' : 'text-ink-500'}>{count}</span>
    </button>
  );
}

const KIND_STYLES: Record<Kind, { activeBg: string; activeText: string; activeBorder: string; dot: string; chipBg: string; chipText: string }> = {
  tool:       { activeBg: 'bg-pulse/10',     activeText: 'text-pulse-glow', activeBorder: 'border-pulse/40', dot: 'bg-pulse',       chipBg: 'bg-pulse/15',     chipText: 'text-pulse-glow' },
  claude:     { activeBg: 'bg-sky-500/10',   activeText: 'text-sky-300',    activeBorder: 'border-sky-500/40', dot: 'bg-sky-400',   chipBg: 'bg-sky-500/15',   chipText: 'text-sky-300' },
  user:       { activeBg: 'bg-violet-500/10', activeText: 'text-violet-300', activeBorder: 'border-violet-500/40', dot: 'bg-violet-400', chipBg: 'bg-violet-500/15', chipText: 'text-violet-300' },
  system:     { activeBg: 'bg-amber-500/10', activeText: 'text-amber-300',  activeBorder: 'border-amber-500/40', dot: 'bg-amber-400', chipBg: 'bg-amber-500/15', chipText: 'text-amber-300' },
  attachment: { activeBg: 'bg-fuchsia-500/10', activeText: 'text-fuchsia-300', activeBorder: 'border-fuchsia-500/40', dot: 'bg-fuchsia-400', chipBg: 'bg-fuchsia-500/15', chipText: 'text-fuchsia-300' },
  other:      { activeBg: 'bg-ink-200',      activeText: 'text-ink-700',    activeBorder: 'border-ink-400', dot: 'bg-ink-500',      chipBg: 'bg-ink-200',      chipText: 'text-ink-500' },
};

function KindBadge({ kind }: { kind: Kind }) {
  const s = KIND_STYLES[kind];
  return <span className={`px-1.5 py-0.5 rounded ${s.chipBg} ${s.chipText} text-[10px]`}>{kind}</span>;
}

/* ---------------------------------------------------------------------------
   localStorage-backed state hooks
--------------------------------------------------------------------------- */

function usePersistedState<T extends string>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.localStorage.getItem(key);
      return raw == null ? initial : (raw as T);
    } catch { return initial; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(key, value); } catch { /* quota / disabled */ }
  }, [key, value]);
  return [value, setValue];
}

function usePersistedKindSet(key: string, initial: Set<Kind>): [Set<Kind>, (updater: Set<Kind> | ((prev: Set<Kind>) => Set<Kind>)) => void] {
  const [value, setValue] = useState<Set<Kind>>(() => {
    if (typeof window === 'undefined') return initial;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return initial;
      const valid = parsed.filter((k): k is Kind => (KINDS as readonly string[]).includes(k));
      return new Set(valid);
    } catch { return initial; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify([...value])); } catch { /* quota / disabled */ }
  }, [key, value]);
  return [value, setValue];
}
