import { type GraderClient, isFinalStatus } from '../grader/client';
import { classifyConnectionError } from '../grader/connection';
import { normalizeProblem } from '../grader/types';
import type { Language, Problem, SubmissionBrief, SubmissionDetail } from '../grader/types';
import type { ProblemList } from '../grader/client';
import { type Freshness, RequestCache } from './cache';

/**
 * The one shared cache layer between the UI and the grader (no `vscode`
 * import, so request counts are unit tested).
 *
 * Request discipline:
 * - problem list: cached for the session; refreshed on demand or after a submit
 * - languages: cached for the session
 * - history per problem: fresh for 5 minutes
 * - submission details: cached forever once final, never while in progress
 * - file switches are debounced (400 ms) and only fetch missing/stale history
 * - same key in flight → same promise
 * - nothing is fetched while the panel is hidden; pending loads run when it is shown
 * - no background polling, no prefetching of other problems
 * - offline / 429 / 5xx: keep cached data and flag it as possibly out of date
 */
export const HISTORY_TTL_MS = 5 * 60_000;
export const SWITCH_DEBOUNCE_MS = 400;

const SESSION: Freshness = { kind: 'session' };
const HISTORY: Freshness = { kind: 'ttl', ms: HISTORY_TTL_MS };
const DETAIL: Freshness = { kind: 'final', final: (v) => isFinalStatus((v as SubmissionDetail).status) };

export interface LoadState {
  loading: boolean;
  /** Showing cached data because the last refresh failed (offline, 429, 5xx). */
  stale: boolean;
  error: string | null;
}

const IDLE: LoadState = { loading: false, stale: false, error: null };

export interface DataServiceOptions {
  client: () => GraderClient;
  /** True when a request may be made (logged in, or a stored password allows a silent re-login). */
  canFetch: () => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (line: string) => void;
  describe?: (err: unknown) => string;
  /**
   * Persisted problem list (workspace state, with its timestamp). It is shown
   * immediately on startup but still counts as stale, so the session fetches once.
   */
  persist?: { load(): { at: number; list: ProblemList } | undefined; save(at: number, list: ProblemList): void };
}

export class DataService {
  readonly cache: RequestCache;
  /** Called after any cached data or load state changed. */
  onChange: () => void = () => {};
  /** Every failed load, with its cache key (the controller shows the connection banner / Retry). */
  onError: (err: unknown, key: string) => void = () => {};
  /** A load succeeded (the connection banner can be hidden). */
  onSuccess: () => void = () => {};
  /** Called after the problem list was (re)loaded, e.g. to re-run local CPH matching. */
  onProblemsLoaded: () => void = () => {};

  private visible = false;
  private focused: number | null = null;
  private timer: unknown = null;
  private pendingProblems = false;
  private readonly states = new Map<string, LoadState>();
  private readonly setTimer: NonNullable<DataServiceOptions['setTimer']>;
  private readonly clearTimer: NonNullable<DataServiceOptions['clearTimer']>;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: DataServiceOptions) {
    this.log = opts.log ?? (() => {});
    this.cache = new RequestCache(opts.now ?? (() => Date.now()), this.log);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.restorePersisted();
  }

  /** Seed the cache with the saved list (marked stale: the first load of the session fetches). */
  private restorePersisted(): void {
    let saved: { at: number; list: ProblemList } | undefined;
    try {
      saved = this.opts.persist?.load();
    } catch {
      saved = undefined;
    }
    const raw = saved?.list as Partial<ProblemList> | undefined;
    if (!saved || !raw || !Array.isArray(raw.problems)) return;
    // Saved by an older version: fill in missing fields instead of trusting the shape.
    const list: ProblemList = {
      problems: raw.problems.filter((p) => p && typeof p.id === 'number').map((p) => normalizeProblem(p)),
      listStatus: raw.listStatus ?? 'loaded',
      topics: Array.isArray(raw.topics) ? raw.topics : null,
    };
    this.cache.set('problems', list);
    this.cache.invalidate('problems');
    this.persistedAt = saved.at;
  }

  /** When the shown problem list was fetched (persisted or this session). */
  persistedAt: number | null = null;

  // ------------------------------------------------------------- reading

  problemList(): ProblemList | undefined {
    return this.cache.peek<ProblemList>('problems')?.value;
  }

  history(problemId: number): SubmissionBrief[] | undefined {
    return this.cache.peek<SubmissionBrief[]>(historyKey(problemId))?.value;
  }

  detail(id: number): SubmissionDetail | undefined {
    return this.cache.peek<SubmissionDetail>(detailKey(id))?.value;
  }

  state(key: 'problems' | `history:${number}` | `detail:${number}`): LoadState {
    return this.states.get(key) ?? IDLE;
  }

  historyState(problemId: number): LoadState {
    return this.state(historyKey(problemId));
  }

  isVisible(): boolean {
    return this.visible;
  }

  // --------------------------------------------------------- visibility

  /** The sidebar became visible / hidden. Pending loads run when it becomes visible. */
  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    this.log(`panel ${v ? 'visible' : 'hidden'}`);
    if (!v) return;
    if (this.pendingProblems) void this.loadProblems(true);
    if (this.focused !== null && !this.cache.isFresh(historyKey(this.focused), HISTORY)) void this.loadHistory(this.focused);
  }

  /**
   * The active file's problem changed. Debounced: rapid switching causes at
   * most one fetch, and none while the cached history is fresh.
   */
  focusProblem(problemId: number | null): void {
    this.focused = problemId;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      const id = this.focused;
      if (id === null || !this.visible || !this.opts.canFetch()) return;
      if (this.cache.isFresh(historyKey(id), HISTORY)) this.log(`switch    ${historyKey(id)} fresh, no request`);
      else void this.loadHistory(id);
    }, SWITCH_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------ loading

  /** Problem list (+ /main/list penalties). Deferred while the panel is hidden. */
  async loadProblems(force = false): Promise<ProblemList | undefined> {
    if (!this.visible) {
      this.pendingProblems = true;
      this.log('problems: deferred (panel hidden)');
      return this.problemList();
    }
    this.pendingProblems = false;
    const fresh = !force && this.cache.isFresh('problems', SESSION);
    const list = await this.run('problems', () => this.cache.get('problems', SESSION, () => this.opts.client().listProblems(), force));
    if (list && !fresh) {
      this.savePersisted();
      this.onProblemsLoaded();
    }
    return list;
  }

  async languages(): Promise<Language[]> {
    return this.cache.get('languages', SESSION, () => this.opts.client().languages());
  }

  async loadHistory(problemId: number, force = false): Promise<SubmissionBrief[] | undefined> {
    if (!this.visible) return this.history(problemId);
    const key = historyKey(problemId);
    return this.run(key, () => this.cache.get(key, HISTORY, () => this.opts.client().listSubmissions(problemId), force));
  }

  /** Full detail, on demand. Cached forever once final; in-progress ones are always refetched. */
  async loadDetail(id: number): Promise<SubmissionDetail | undefined> {
    const key = detailKey(id);
    return this.run(key, () => this.cache.get(key, DETAIL, () => this.opts.client().getSubmission(id)));
  }

  /** Store a detail we already have (e.g. the final poll response) without another request. */
  recordDetail(d: SubmissionDetail): void {
    if (isFinalStatus(d.status)) this.cache.set(detailKey(d.id), d);
  }

  /**
   * After a submission is final: refresh that problem's history and the
   * problem list (API only, penalties kept) exactly once.
   */
  async afterSubmit(problemId: number): Promise<void> {
    this.cache.invalidate(historyKey(problemId));
    this.cache.invalidate('problems');
    if (!this.visible) {
      this.pendingProblems = true;
      return;
    }
    const prevList = this.problemList();
    const previous = prevList?.problems;
    await Promise.all([
      this.loadHistory(problemId, true),
      this.run('problems', () =>
        this.cache.get('problems', SESSION, () => this.opts.client().listProblems({ penalties: false, previous, previousTopics: prevList?.topics ?? null }), true),
      ),
    ]);
    this.savePersisted();
  }

  /** Replace one problem in the cached list (e.g. after a fresh per-problem fetch). */
  updateProblem(p: Problem): void {
    const list = this.problemList();
    if (!list) return;
    this.cache.set('problems', { ...list, problems: list.problems.map((x) => (x.id === p.id ? { ...p, list: x.list } : x)) });
    this.onChange();
  }

  private savePersisted(): void {
    const e = this.cache.peek<ProblemList>('problems');
    if (e && e.at !== Number.NEGATIVE_INFINITY) {
      this.persistedAt = e.at;
      this.opts.persist?.save(e.at, e.value);
    }
  }

  clear(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.persistedAt = null;
    this.timer = null;
    this.cache.clear();
    this.states.clear();
    this.pendingProblems = false;
    this.focused = null;
    this.onChange();
  }

  /** Track loading / stale / error per key; on network trouble keep the cached value. */
  private async run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    this.states.set(key, { loading: true, stale: this.states.get(key)?.stale ?? false, error: null });
    this.onChange();
    try {
      const v = await fn();
      this.states.set(key, IDLE);
      this.onSuccess();
      return v;
    } catch (err) {
      const cached = this.cache.peek<T>(key);
      const msg = this.opts.describe?.(err) ?? (err instanceof Error ? err.message : String(err));
      // Connection problems are shown once, in the banner; the section only says "may be out of date".
      const connection = classifyConnectionError(err) !== null;
      this.states.set(key, { loading: false, stale: !!cached, error: connection ? null : msg });
      if (cached) this.log(`${key}: showing cached data (${msg})`);
      this.onError(err, key);
      return cached?.value;
    } finally {
      this.onChange();
    }
  }
}

export const historyKey = (id: number) => `history:${id}` as const;
export const detailKey = (id: number) => `detail:${id}` as const;
