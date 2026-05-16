import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import Fuse from 'fuse.js';
import { api, type ContentMatch, type ProjectSummary, type SessionSummary } from '../lib/api';
import { rankResults, useDebounced } from '../lib/search';
import { isRangeActive, rangeKey, useRange } from '../lib/range';

interface IndexSearch { project?: string; q?: string }

export const Route = createFileRoute('/')({
  validateSearch: (s: Record<string, unknown>): IndexSearch => ({
    project: typeof s.project === 'string' ? s.project : undefined,
    q: typeof s.q === 'string' ? s.q : undefined,
  }),
  component: Dashboard,
});

function Dashboard() {
  const { project, q } = Route.useSearch();
  return project ? <ProjectView cwd={project} initialQuery={q ?? ''} /> : <ProjectsList />;
}

/* ============================================================================
   PROJECTS LIST
============================================================================ */

function ProjectsList() {
  const range = useRange();
  const rk = rangeKey(range);
  const rangeActive = isRangeActive(range);
  const projects = useQuery({ queryKey: ['projects', rk], queryFn: () => api.projects(range) });
  const data = projects.data ?? [];
  const totalCost = data.reduce((s, p) => s + p.estimatedCost, 0);
  const maxCost = Math.max(0.01, ...data.map((p) => p.estimatedCost));
  const totalTokens = data.reduce((s, p) => s + p.totalInputTokens + p.totalOutputTokens, 0);
  const totalSessions = data.reduce((s, p) => s + p.sessionCount, 0);

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 200);
  const trimmed = debouncedQuery.trim();

  const contentMatches = useQuery({
    queryKey: ['globalContentSearch', trimmed, rk],
    queryFn: () => api.searchAllSessions(trimmed, range),
    enabled: trimmed.length >= 2,
    staleTime: 30_000,
  });

  // Aggregate content hits by project cwd
  const projectHits = useMemo(() => {
    const m = new Map<string, { sessions: number; snippet: string }>();
    for (const hit of contentMatches.data ?? []) {
      if (!hit.cwd) continue;
      const existing = m.get(hit.cwd);
      if (existing) existing.sessions++;
      else m.set(hit.cwd, { sessions: 1, snippet: hit.snippet });
    }
    return m;
  }, [contentMatches.data]);

  const projectIndex = useMemo(() => {
    const augmented = data.map((p) => ({
      ...p,
      _segment: tailPath(p.cwd),
    }));
    return {
      items: augmented,
      fuse: new Fuse(augmented, {
        keys: [
          { name: '_segment', weight: 0.6 },
          { name: 'cwd', weight: 0.4 },
        ],
        threshold: 0.4,
        includeScore: true,
        ignoreLocation: true,
      }),
    };
  }, [data]);

  const filtered = useMemo(() => {
    if (!trimmed) return data;
    const metaHits = projectIndex.fuse.search(trimmed);
    const ranked = rankResults(metaHits, (p) => p.lastActive, (p) => p.estimatedCost);
    // Merge: include projects with content hits that aren't already in meta results
    const seen = new Set(ranked.map((p) => p.cwd));
    const contentOnly = projectIndex.items.filter(
      (p) => projectHits.has(p.cwd) && !seen.has(p.cwd),
    );
    return [...ranked, ...contentOnly];
  }, [trimmed, data, projectIndex, projectHits]);

  return (
    <div className="space-y-8">
      <Hero
        eyebrow="Overview"
        title="All projects"
        subtitle="Pick a project to drill in. The CLI scopes this automatically when you run "
        kbd="ccpulse open"
      />

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Cost" value={`$${totalCost.toFixed(2)}`} sub="estimated, all-time" />
        <Stat label="Tokens" value={fmtTokens(totalTokens)} sub={`${data.length} projects`} />
        <Stat label="Sessions" value={String(totalSessions)} sub="indexed" />
      </div>

      <Section
        title="Projects"
        hint={trimmed ? `${filtered.length} of ${data.length}` : (data.length ? `${data.length} tracked` : '')}
      >
        <div className="px-4 py-3 border-b border-ink-300 bg-ink-100/40">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search projects, branches, event content…"
            loading={contentMatches.isFetching && trimmed.length >= 2}
          />
        </div>
        {projects.isLoading && <Skeleton rows={5} />}
        {!projects.isLoading && data.length === 0 && (
          <EmptyState
            title="No sessions indexed yet"
            body="Use Claude Code in any project, then refresh."
          />
        )}
        {!projects.isLoading && data.length > 0 && filtered.length === 0 && (
          <EmptyState title="No projects match" body={`Nothing matched "${trimmed}".`} compact />
        )}
        <ul className="divide-y divide-ink-300">
          {filtered.map((p) => (
            <ProjectRow
              key={p.cwd}
              p={p}
              maxCost={maxCost}
              contentHit={projectHits.get(p.cwd) ?? null}
              query={trimmed}
              dimmed={rangeActive && !p.inRange}
            />
          ))}
        </ul>
      </Section>
    </div>
  );
}

function ProjectRow({
  p, maxCost, contentHit, query, dimmed,
}: {
  p: ProjectSummary;
  maxCost: number;
  contentHit?: { sessions: number; snippet: string } | null;
  query?: string;
  dimmed?: boolean;
}) {
  const share = Math.min(1, p.estimatedCost / maxCost);
  return (
    <li className={`relative ${dimmed ? 'opacity-40' : ''}`} title={dimmed ? 'No activity in the selected range' : undefined}>
      <Link
        to="/"
        search={(prev) => ({ ...prev, project: p.cwd, q: query || undefined })}
        className="block group"
      >
        <div className="absolute inset-y-0 left-0 bg-pulse/[0.05] group-hover:bg-pulse/10 transition-colors" style={{ width: `${share * 100}%` }} />
        <div className="relative px-4 py-3 grid grid-cols-12 gap-4 items-center">
          <div className="col-span-7 min-w-0">
            <div className="font-mono text-[13px] text-ink-800 truncate group-hover:text-ink-900">
              <span className="text-ink-500">{leadingPath(p.cwd)}</span>
              <span className="text-ink-900">{tailPath(p.cwd)}</span>
            </div>
            <div className="text-[11px] text-ink-500 mt-0.5 font-mono">
              {p.sessionCount} session{p.sessionCount === 1 ? '' : 's'}  ·  last active {fmtRel(p.lastActive)}
              {contentHit && (
                <span className="ml-2 px-1.5 py-0.5 rounded bg-pulse/15 text-pulse-glow text-[10px]">
                  {contentHit.sessions} matching session{contentHit.sessions === 1 ? '' : 's'}
                </span>
              )}
            </div>
            {contentHit?.snippet && (
              <div className="text-[11px] text-ink-500 italic mt-1 truncate font-sans">
                “{contentHit.snippet}”
              </div>
            )}
          </div>
          <div className="col-span-2 text-right font-mono text-[12px] text-ink-600">
            {fmtTokens(p.totalInputTokens + p.totalOutputTokens)} <span className="text-ink-500">tok</span>
          </div>
          <div className="col-span-2 text-right">
            <div className="font-mono text-[13px] text-ink-900">${p.estimatedCost.toFixed(2)}</div>
          </div>
          <div className="col-span-1 flex justify-end">
            <span className="text-ink-500 group-hover:text-pulse transition-colors">→</span>
          </div>
        </div>
      </Link>
    </li>
  );
}

export function SearchInput({
  value, onChange, placeholder, loading,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  loading?: boolean;
}) {
  return (
    <div className="relative">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-ink-0 border border-ink-300 rounded px-3 py-1.5 pr-16 text-[13px] text-ink-800 placeholder:text-ink-500 font-mono focus:outline-none focus:border-pulse/60 focus:ring-1 focus:ring-pulse/30"
      />
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
        {loading && <span className="text-[10px] text-ink-500 font-mono">…</span>}
        {value && (
          <button
            onClick={() => onChange('')}
            className="text-ink-500 hover:text-ink-800 text-[14px] leading-none px-1"
            aria-label="clear search"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
   PROJECT DRILLDOWN
============================================================================ */

function ProjectView({ cwd, initialQuery = '' }: { cwd: string; initialQuery?: string }) {
  const range = useRange();
  const rk = rangeKey(range);
  const rangeActive = isRangeActive(range);
  const projects = useQuery({ queryKey: ['projects', rk], queryFn: () => api.projects(range) });
  const sessions = useQuery({ queryKey: ['sessions', cwd, rk], queryFn: () => api.sessions(cwd, range) });
  const tools = useQuery({ queryKey: ['projectTools', cwd, rk], queryFn: () => api.projectTools(cwd, range) });
  const models = useQuery({ queryKey: ['projectModels', cwd, rk], queryFn: () => api.projectModels(cwd, range) });

  const proj = projects.data?.find((p) => p.cwd === cwd);
  const totalTokens = (proj?.totalInputTokens ?? 0) + (proj?.totalOutputTokens ?? 0);
  const totalCacheRead = proj?.totalCacheRead ?? 0;
  const totalCost = proj?.estimatedCost ?? 0;
  const toolCallTotal = (tools.data ?? []).reduce((s, t) => s + t.count, 0);

  const [sessionQuery, setSessionQuery] = useState(initialQuery);
  const debouncedSessionQuery = useDebounced(sessionQuery, 200);
  const trimmedSessionQ = debouncedSessionQuery.trim();

  const contentMatches = useQuery({
    queryKey: ['projectContentSearch', cwd, trimmedSessionQ, rk],
    queryFn: () => api.searchProjectSessions(cwd, trimmedSessionQ, range),
    enabled: trimmedSessionQ.length >= 2,
    staleTime: 30_000,
  });

  const sessionIndex = useMemo(() => {
    const list = sessions.data ?? [];
    return new Fuse(list, {
      keys: [
        { name: 'title', weight: 0.5 },
        { name: 'branch', weight: 0.3 },
        { name: 'id', weight: 0.2 },
      ],
      threshold: 0.4,
      includeScore: true,
      ignoreLocation: true,
    });
  }, [sessions.data]);

  const sessionMatches: Array<SessionSummary & { _snippet?: string; _matchCount?: number }> = useMemo(() => {
    const list = sessions.data ?? [];
    if (!trimmedSessionQ) return list;
    const contentMap = new Map<string, ContentMatch>();
    for (const m of contentMatches.data ?? []) contentMap.set(m.sessionId, m);

    const metaHits = sessionIndex.search(trimmedSessionQ);
    const metaRanked = rankResults(metaHits, (s) => s.endedAt, (s) => s.estimatedCost);
    const seen = new Set(metaRanked.map((s) => s.id));

    // Add content-only matches at the end
    const contentOnly = list.filter((s) => contentMap.has(s.id) && !seen.has(s.id));
    const ranked = [...metaRanked, ...contentOnly];

    return ranked.map((s) => {
      const hit = contentMap.get(s.id);
      return hit ? { ...s, _snippet: hit.snippet, _matchCount: hit.matchCount } : s;
    });
  }, [sessions.data, sessionIndex, trimmedSessionQ, contentMatches.data]);

  return (
    <div className="space-y-8">
      <div>
        <Link
          to="/"
          search={(prev) => ({ range: prev.range, from: prev.from, to: prev.to })}
          className="text-[11px] text-ink-500 hover:text-ink-700 font-mono"
        >← all projects</Link>
        <div className="flex items-baseline gap-3 mt-2">
          <h1 className="font-mono text-2xl text-ink-900 tracking-tight truncate">
            <span className="text-ink-500">{leadingPath(cwd)}</span>
            <span className="text-ink-900">{tailPath(cwd)}</span>
          </h1>
        </div>
        <div className="mt-1 text-[11px] font-mono text-ink-500">
          {sessions.data?.length ?? 0} sessions  ·  {toolCallTotal} tool calls
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Cost" value={`$${totalCost.toFixed(2)}`} sub="estimated" accent />
        <Stat label="Tokens" value={fmtTokens(totalTokens)} sub="in + out" />
        <Stat label="Cache hits" value={fmtTokens(totalCacheRead)} sub="read tokens" />
        <Stat label="Sessions" value={String(sessions.data?.length ?? 0)} sub={`${toolCallTotal} tools`} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card className="md:col-span-3">
          <CardHeader title="Tool usage" hint="count · avg latency" />
          {tools.isLoading && <Skeleton rows={6} />}
          {tools.data && tools.data.length === 0 && <EmptyState title="No tool calls yet" body="Tool calls appear here as Claude uses Bash, Read, Edit, etc." compact />}
          <ul className="space-y-1 max-h-[22rem] overflow-auto pr-1">
            {(tools.data ?? []).map((t, i) => {
              const max = tools.data![0]!.count;
              return (
                <li key={t.name} className="relative">
                  <div className="absolute inset-y-0 left-0 bg-ink-200 rounded" style={{ width: `${(t.count / max) * 100}%` }} />
                  <div className="relative px-3 py-2 flex items-center gap-3 text-[13px]">
                    <span className="text-ink-500 font-mono w-5 text-right">{i + 1}</span>
                    <span className="font-mono font-medium text-ink-800 truncate flex-1">{t.name}</span>
                    {t.avgLatencyMs != null && (
                      <span className="font-mono text-[11px] text-ink-500 whitespace-nowrap">
                        {fmtMs(t.avgLatencyMs)} avg{t.p95LatencyMs != null ? ` · ${fmtMs(t.p95LatencyMs)} p95` : ''}
                      </span>
                    )}
                    <span className="font-mono text-ink-900 tabular-nums w-12 text-right">{t.count}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader title="Models" hint="tokens · cost" />
          {models.isLoading && <Skeleton rows={3} />}
          {models.data && models.data.length === 0 && <EmptyState title="No model data" body="Models show after the first assistant reply." compact />}
          <ul className="space-y-2">
            {(models.data ?? []).map((m) => {
              const totalTok = m.inputTokens + m.outputTokens + m.cacheRead + m.cacheCreate;
              return (
                <li key={m.model} className="px-3 py-2 rounded border border-ink-300 bg-ink-50">
                  <div className="flex justify-between items-baseline gap-3">
                    <span className="font-mono text-[12px] text-ink-800 truncate">{m.model}</span>
                    <span className="font-mono text-[13px] text-ink-900 tabular-nums whitespace-nowrap">${m.cost.toFixed(2)}</span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-4 gap-2 text-[10px] font-mono text-ink-500">
                    <div><div className="text-ink-700">{fmtTokens(m.inputTokens)}</div>in</div>
                    <div><div className="text-ink-700">{fmtTokens(m.outputTokens)}</div>out</div>
                    <div><div className="text-ink-700">{fmtTokens(m.cacheRead)}</div>cache↓</div>
                    <div><div className="text-ink-700">{fmtTokens(m.cacheCreate)}</div>cache↑</div>
                  </div>
                  <div className="mt-1.5 text-[10px] font-mono text-ink-500">
                    {m.messages} messages · {fmtTokens(totalTok)} tokens
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Sessions"
          hint={trimmedSessionQ
            ? `${sessionMatches.length} of ${sessions.data?.length ?? 0}`
            : (sessions.data ? `${sessions.data.length} total` : '')}
        />
        <div className="mb-3">
          <SearchInput
            value={sessionQuery}
            onChange={setSessionQuery}
            placeholder="Search title, branch, id, or event content…"
            loading={contentMatches.isFetching && trimmedSessionQ.length >= 2}
          />
        </div>
        {sessions.isLoading && <Skeleton rows={3} />}
        {sessions.data && sessions.data.length === 0 && <EmptyState title="No sessions" body="No Claude Code sessions touched this project yet." compact />}
        {sessions.data && sessions.data.length > 0 && sessionMatches.length === 0 && (
          <EmptyState title="No sessions match" body={`Nothing matched "${trimmedSessionQ}".`} compact />
        )}
        <ul className="divide-y divide-ink-300">
          {sessionMatches.map((s) => {
            const dur = s.endedAt - s.startedAt;
            const dimmed = rangeActive && !s.inRange;
            return (
              <li key={s.id} className={dimmed ? 'opacity-40' : ''} title={dimmed ? 'No activity in the selected range' : undefined}>
                <Link
                  to="/session/$sid"
                  params={{ sid: s.id }}
                  search={(prev) => ({ range: prev.range, from: prev.from, to: prev.to })}
                  className="block group"
                >
                  <div className="px-4 py-3 grid grid-cols-12 gap-3 items-center">
                    <div className="col-span-6 min-w-0">
                      <div className="text-[13px] text-ink-800 group-hover:text-ink-900 truncate">
                        {s.title ?? <span className="text-ink-500 italic">(untitled session)</span>}
                      </div>
                      <div className="text-[11px] text-ink-500 mt-0.5 font-mono">
                        {s.id.slice(0, 8)}  ·  {fmtRel(s.endedAt)}  ·  {fmtDuration(dur)}
                        {s.branch ? <span className="ml-2 px-1.5 py-0.5 rounded bg-ink-200 text-ink-700 text-[10px]">{s.branch}</span> : null}
                        {s._matchCount ? (
                          <span className="ml-2 px-1.5 py-0.5 rounded bg-pulse/15 text-pulse-glow text-[10px]">
                            {s._matchCount} match{s._matchCount === 1 ? '' : 'es'}
                          </span>
                        ) : null}
                      </div>
                      {s._snippet && (
                        <div className="text-[11px] text-ink-500 italic mt-1 truncate font-sans">
                          “{s._snippet}”
                        </div>
                      )}
                    </div>
                    <div className="col-span-2 text-right font-mono text-[11px] text-ink-500">
                      <span className="text-ink-700">{s.toolCallCount}</span> tools
                    </div>
                    <div className="col-span-2 text-right font-mono text-[11px] text-ink-500">
                      <span className="text-ink-700">{fmtTokens(s.inputTokens + s.outputTokens)}</span> tok
                    </div>
                    <div className="col-span-2 text-right">
                      <div className="font-mono text-[13px] text-ink-900">${s.estimatedCost.toFixed(2)}</div>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

/* ============================================================================
   PRIMITIVES
============================================================================ */

function Hero({ eyebrow, title, subtitle, kbd }: { eyebrow: string; title: string; subtitle?: string; kbd?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-pulse font-medium">{eyebrow}</div>
      <h1 className="mt-1 text-2xl font-semibold text-ink-900 tracking-tight">{title}</h1>
      {subtitle && (
        <p className="mt-1 text-[13px] text-ink-500">
          {subtitle}{kbd && <kbd className="ml-1 px-1.5 py-0.5 rounded bg-ink-100 border border-ink-300 font-mono text-[11px] text-ink-700">{kbd}</kbd>}
        </p>
      )}
    </div>
  );
}

export function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border ${accent ? 'border-pulse/30 bg-gradient-to-b from-pulse/[0.06] to-transparent' : 'border-ink-300 bg-ink-50'} px-4 py-3`}>
      <div className="text-[10px] uppercase tracking-[0.14em] text-ink-500 font-medium">{label}</div>
      <div className={`mt-0.5 font-mono text-[22px] tracking-tight ${accent ? 'text-pulse-glow' : 'text-ink-900'}`}>{value}</div>
      {sub && <div className="text-[10px] text-ink-500 font-mono mt-0.5">{sub}</div>}
    </div>
  );
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-ink-300 bg-ink-50 p-4 ${className}`}>{children}</section>;
}

export function CardHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h2 className="text-[12px] uppercase tracking-[0.16em] text-ink-700 font-medium">{title}</h2>
      {hint && <span className="text-[11px] font-mono text-ink-500">{hint}</span>}
    </div>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3 px-1">
        <h2 className="text-[12px] uppercase tracking-[0.16em] text-ink-700 font-medium">{title}</h2>
        {hint && <span className="text-[11px] font-mono text-ink-500">{hint}</span>}
      </div>
      <div className="rounded-lg border border-ink-300 bg-ink-50 overflow-hidden">{children}</div>
    </section>
  );
}

export function EmptyState({ title, body, compact }: { title: string; body: string; compact?: boolean }) {
  return (
    <div className={`text-center ${compact ? 'py-6' : 'py-12'}`}>
      <div className="text-ink-700 text-[13px] font-medium">{title}</div>
      <div className="text-ink-500 text-[12px] mt-1">{body}</div>
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-9 rounded bg-ink-100 shimmer" />
      ))}
    </div>
  );
}

/* ============================================================================
   FORMATTERS
============================================================================ */

export function fmtTokens(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function fmtMs(n: number) {
  if (n >= 60_000) return `${(n / 60_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}

export function fmtRel(ts: number) {
  if (!ts) return 'never';
  const dt = Date.now() - ts;
  if (dt < 60_000) return 'just now';
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.round(dt / 3_600_000)}h ago`;
  return `${Math.round(dt / 86_400_000)}d ago`;
}

export function fmtDuration(ms: number) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function leadingPath(p: string) {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '' : p.slice(0, i + 1);
}

function tailPath(p: string) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}
