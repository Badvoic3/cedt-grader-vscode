import * as vscode from 'vscode';
import { readConfig, type GraderConfig } from './config';
import { DataService } from './data/dataService';
import { StatementStore } from './data/statementStore';
import { StatementPanels } from './ui/statementPanel';
import {
  AuthError,
  chooseLanguage,
  classifyConnectionError,
  type ConnectionProblem,
  countedScore,
  describeSubmitFailure,
  type Credentials,
  describeImprovement,
  GraderClient,
  GraderError,
  type Language,
  LanguageNotAllowedError,
  languageNameForPath,
  NetworkError,
  ProblemUnavailableError,
  parseGraderComment,
  PollTimeoutError,
  type Problem,
  resultWord,
  type StoredToken,
  type SubmissionDetail,
  summarize,
  problemStatus,
} from './grader';
import { dirname } from 'node:path';
import { chooseTestcaseTarget, CPH_EXTENSION_ID, CphPresence, saveTestcasesAsFiles, testsFolderFor } from './cphIntegration';
import { TestcaseStore } from './data/testcaseStore';
import { cphProbPath as cphProbPathFor, readCphProblem } from './mapping/cph';
import { importIntoCph } from './mapping/cphImport';
import { createFileNoOverwrite, pathExists as exists } from './mapping/newFile';
import { chooseNewFileLanguage } from './mapping/newFileLanguage';
import { BINARY_EXTS, excludeGlob, filterCandidates, includeGlob, rankCandidates } from './mapping/findByName';
import { EXTENSION_LANGUAGE } from './grader/languages';
import { stat as fsStat, readFile as fsReadFile } from 'node:fs/promises';
import { dismissKey, type LocatedEntry, moveCphProblem, reconnectCandidates, remapPath } from './mapping/mappingOps';
import { cleanName, fileNameFor, type MatchSource, placeholder, resolveProblem, SOURCE_LABEL } from './mapping/match';
import { MappingStore } from './mapping/store';
import { comparePaths, linkedNotice, mergeProblemFiles, type ProblemFile, ProblemFileSearch } from './mapping/problemFiles';
import { pathKey } from './mapping/paths';
import { confirmSuggestion } from './mapping/suggestionGate';
import { LIMITS, TIMING, WEB_PATHS } from './shared/constants';
import { PICK_HOW, S } from './shared/strings';
import type { HistoryEntry, ProblemFilter, ProblemView, ResultView, SubmissionDetailView, ViewState } from './shared/messages';

export const EXAM_WARNING = S.exam.warning;

/** URI scheme serving the source of a past submission (for the diff view). */
export const SUBMISSION_SCHEME = 'cedt-grader-submission';

const LANGUAGE_KEY = 'cedtGrader.languageByFile';
const DISMISSED_KEY = 'cedtGrader.dismissedReconnects';
const CLEANUP_KEY = 'cedtGrader.lastMappingCleanup';
const TESTCASE_TARGET_KEY = 'cedtGrader.testcaseTarget';
const NEWFILE_LANG_KEY = 'cedtGrader.lastNewFileLanguage';
const FILTER_KEY = 'cedtGrader.problemFilter';
const OPENED_KEY = 'cedtGrader.recentlyOpened';
const CPH_TIP_KEY = 'cedtGrader.cphTipDismissed';
const REMEMBER_KEY = 'cedtGrader.rememberPassword';

type Listener = (s: ViewState) => void;

/**
 * Single owner of the grader session and all UI state. All grader data goes
 * through `DataService` (the shared cache layer).
 */
export class GraderController implements vscode.Disposable {
  private cfg: GraderConfig = readConfig();
  private client: GraderClient;
  readonly data: DataService;
  private readonly mapping: MappingStore;
  private readonly listeners = new Set<Listener>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output: vscode.OutputChannel;
  private debugChannel: vscode.OutputChannel | null = null;
  private requestCount = 0;

  private accountStatus: ViewState['account']['status'] = 'logged-out';
  private accountError: string | null = null;
  private hasSavedPassword = false;

  private fileUri: vscode.Uri | null = null;
  private problem: (Problem & { source: MatchSource }) | null = null;
  private languagesError: string | null = null;
  private selectedLanguageId: number | null = null;
  private expandedSubmission: number | null = null;
  /** Latest result per source file (fsPath): the panel only shows the active file's result. */
  private results = new Map<string, ResultView>();
  private gradingFile: string | null = null;
  private busy = false;
  private pollAbort: AbortController | null = null;
  private refreshSeq = 0;
  private changingUsername = false;
  /** Matching details for the active file (picker suggestions, ambiguous candidates, stale mapping). */
  private matchInfo: { suggestions: Problem[]; ambiguous: Problem[] | null; ambiguousSource: 'cph' | 'filename' | 'suggested' | null } = {
    suggestions: [],
    ambiguous: null,
    ambiguousSource: null,
  };
  /** Problems the grader no longer offers (missing from the list, or 404/403 this session). */
  private readonly unavailableIds = new Set<number>();
  /** The active file was explicitly unlinked (auto-detection is off for it). */
  private notLinked = false;
  /** Files for the current problem (duplicate notice): saved links, remembered auto-matches, name matches. */
  private linkedFiles: ProblemFile[] = [];
  /** One cached file search per problem; cleared on file create/delete/rename (debounced). */
  private readonly fileSearch = new ProblemFileSearch((id) => this.searchFilesNamed(id, true));
  private fileEventTimer: ReturnType<typeof setTimeout> | undefined;
  /** CPH tip: "Not now" hides it for this session. */
  private cphTipHidden = false;
  /** Inline question in the panel (calm alternative to modal dialogs). */
  private prompt: InlinePrompt | null = null;
  private promptResolve: ((v: string | undefined) => void) | null = null;
  private promptSeq = 0;
  /** Problems with at least one mapped file (for "go to file"). */
  private mappedIds = new Set<number>();
  private testcasesBusy = false;
  /** Files already asked about "keep the link?" this session. */
  private readonly reconnectAsked = new Set<string>();
  private readonly testcases: TestcaseStore;
  /** CPH is optional: only used when installed (re-checked when extensions change). */
  readonly cph: CphPresence;
  /** Connection banner (null = all good) and what its Retry button re-runs. */
  private connection: ConnectionProblem | null = null;
  private retryAction: (() => Promise<unknown>) | null = null;
  /** A submission that was sent but whose result could not be fetched (connection lost). */
  private pendingPoll: { key: string; problem: Problem; submissionId: number; countedBefore: number | null } | null = null;
  readonly statements: StatementPanels;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('CEDT Grader');
    this.mapping = new MappingStore(ctx);
    this.client = this.makeClient();
    this.data = new DataService({
      client: () => this.client,
      canFetch: () => this.client.isLoggedIn || this.hasSavedPassword,
      log: (l) => this.requestLog(l),
      describe: (e) => this.describe(e),
      // Problem list survives restarts (shown at once, refetched once per session).
      persist: {
        load: () => ctx.workspaceState.get<{ at: number; list: import('./grader').ProblemList }>(this.problemsKey()),
        save: (at, list) => void ctx.workspaceState.update(this.problemsKey(), { at, list }),
      },
    });
    this.testcases = new TestcaseStore(ctx.globalStorageUri.fsPath, () => this.client, (l) => this.requestLog(l));
    this.cph = new CphPresence(vscode.extensions, () => this.emit());
    this.data.onChange = () => this.emit();
    this.data.onError = (e, key) => {
      if (e instanceof ProblemUnavailableError) {
        const m = /^history:(\d+)$/.exec(key);
        if (m) this.markUnavailable(Number(m[1]));
        return;
      }
      this.reportError(e, () => this.reloadKey(key));
    };
    this.data.onSuccess = () => this.connectionOk();
    this.statements = new StatementPanels(
      ctx.extensionUri,
      new StatementStore(ctx.globalStorageUri.fsPath, () => this.client, (l) => this.requestLog(l)),
      {
        memento: ctx.globalState,
        beside: () => this.cfg.statementBeside,
        openInBrowser: (id) => void this.openStatementInBrowser(id),
        onError: (e) => {
          this.reportError(e, null);
          return classifyConnectionError(e)?.message ?? this.describe(e);
        },
      },
    );
    // A late (deferred) list load: re-resolve the open file (local only: mapping file and CPH .prob).
    this.data.onProblemsLoaded = () => {
      // Problems back in the list are available again.
      const ids = new Set(this.problems.map((p) => p.id));
      for (const id of [...this.unavailableIds]) if (ids.has(id)) this.unavailableIds.delete(id);
      if (this.fileUri) void this.setActiveFile(this.fileUri);
    };
    this.disposables.push(
      this.output,
      this.statements,
      this.cph,
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e && e.document.uri.scheme === 'file') void this.setActiveFile(e.document.uri);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('cedtGrader')) this.onConfigChanged();
      }),
      // Renames / moves inside VS Code (a folder rename moves every file inside it).
      vscode.workspace.onDidRenameFiles((e) => void this.onFilesRenamed(e.files)),
      // Created / deleted / renamed files (also outside VS Code): the cached name searches are out of date.
      ...(() => {
        const w = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
        return [
          w,
          w.onDidCreate(() => this.onFileEvent()),
          w.onDidDelete((u) => {
            void this.mapping.deleteAuto(u);
            this.onFileEvent();
          }),
        ];
      })(),
      // Deleted mapped files: mark stale (not removed), so a moved file can reconnect.
      vscode.workspace.onDidDeleteFiles((e) => {
        void Promise.all(e.files.flatMap((f) => [this.mapping.markDeleted(f), this.mapping.deleteAuto(f)])).then(async () => {
          await this.refreshMappedIds();
          this.emit();
        });
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.fileName.endsWith('.cedt-grader.json')) {
          this.mapping.invalidate();
          void this.cleanupDuplicateLinks();
          if (this.fileUri) void this.setActiveFile(this.fileUri);
        }
      }),
    );
  }

  /** Restores a stored API token (no network). Never logs in on its own. */
  async init(): Promise<void> {
    // Problem list saved by versions before v2 (no tags): no longer read, remove it.
    await this.ctx.workspaceState.update(`cedtGrader.problems:${this.cfg.baseUrl}:${this.cfg.username}`, undefined);
    await this.dailyCleanup();
    await this.cleanupDuplicateLinks();
    this.hasSavedPassword = !!(await this.getPassword());
    if (await this.client.restore()) {
      this.accountStatus = 'logged-in';
      void this.data.loadProblems(); // deferred until the panel is visible
    }
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === 'file') await this.setActiveFile(ed.document.uri);
    else this.emit();
  }

  dispose(): void {
    this.pollAbort?.abort();
    this.debugChannel?.dispose();
    for (const d of this.disposables) d.dispose();
  }

  onState(l: Listener): vscode.Disposable {
    this.listeners.add(l);
    const s = this.safeState();
    if (s) l(s);
    return new vscode.Disposable(() => this.listeners.delete(l));
  }

  /** Never let a bug in building the view state break activation or the panel: log it instead. */
  private safeState(): ViewState | null {
    try {
      return this.state();
    } catch (err) {
      this.log(`Internal error while building the panel: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
      return null;
    }
  }

  /** The sidebar was shown or hidden. */
  setPanelVisible(v: boolean): void {
    this.data.setVisible(v);
    if (v) {
      void this.ensureLanguages();
      void this.ensureMe();
      void this.refreshLinkedFiles(); // the name search runs only while the panel shows the problem
    }
  }

  // ------------------------------------------------------------ plumbing

  private makeClient(): GraderClient {
    return new GraderClient({
      baseUrl: this.cfg.baseUrl,
      getStoredCredentials: async (): Promise<Credentials | undefined> => {
        const password = await this.getPassword();
        return this.cfg.username && password ? { username: this.cfg.username, password } : undefined;
      },
      tokenStore: {
        load: async () => {
          const raw = await this.ctx.secrets.get(this.secretKey('token'));
          try {
            return raw ? (JSON.parse(raw) as StoredToken) : undefined;
          } catch {
            return undefined;
          }
        },
        save: async (t) => {
          // The token is persisted only when the user chose to remember the password.
          if (t && this.rememberPassword) await this.ctx.secrets.store(this.secretKey('token'), JSON.stringify(t));
          else await this.ctx.secrets.delete(this.secretKey('token'));
        },
      },
      log: (line) => this.requestLog(line),
    });
  }

  /** `cedtGrader.debugRequests`: method, path, status and cache hit/miss only. Never tokens. */
  private requestLog(line: string): void {
    if (!this.cfg.debugRequests) return;
    if (!this.debugChannel) this.debugChannel = vscode.window.createOutputChannel('CEDT Grader: Requests');
    const isHttp = /^(GET|POST) /.test(line);
    if (isHttp) this.requestCount++;
    const t = new Date().toISOString().slice(11, 23);
    this.debugChannel.appendLine(`${t} ${isHttp ? `#${this.requestCount} ` : '   '}${line}`);
  }

  showRequestLog(): void {
    if (!this.cfg.debugRequests) {
      void vscode.window
        .showInformationMessage(S.requestLogOff, S.common.openSetting)
        .then((p) => p && vscode.commands.executeCommand('workbench.action.openSettings', 'cedtGrader.debugRequests'));
      return;
    }
    if (!this.debugChannel) this.debugChannel = vscode.window.createOutputChannel('CEDT Grader: Requests');
    this.debugChannel.show(true);
  }

  private get rememberPassword(): boolean {
    return this.ctx.globalState.get<boolean>(REMEMBER_KEY, true);
  }

  private onConfigChanged(): void {
    const prev = this.cfg;
    this.cfg = readConfig();
    if (this.changingUsername && prev.baseUrl === this.cfg.baseUrl) {
      this.emit();
      return;
    }
    if (prev.baseUrl !== this.cfg.baseUrl || prev.username !== this.cfg.username) {
      void this.client.logout();
      this.client = this.makeClient();
      this.resetSessionState();
      void this.getPassword().then((p) => {
        this.hasSavedPassword = !!p;
        if (this.fileUri) void this.setActiveFile(this.fileUri);
      });
    }
    this.emit();
  }

  private resetSessionState(): void {
    this.accountStatus = 'logged-out';
    this.results.clear();
    this.expandedSubmission = null;
    this.data.clear();
  }

  private problemsKey(): string {
    // v2: problems carry `tags`; older saved lists are still read safely (normalized), but new ones go here.
    return `cedtGrader.problems.v2:${this.cfg.baseUrl}:${this.cfg.username}`;
  }

  private secretKey(kind: 'password' | 'token', username = this.cfg.username): string {
    return `cedtGrader.${kind}:${this.cfg.baseUrl}:${username}`;
  }

  private async getPassword(): Promise<string | undefined> {
    if (!this.cfg.username) return undefined;
    return this.ctx.secrets.get(this.secretKey('password'));
  }

  private emit(): void {
    const s = this.safeState();
    if (!s) return;
    for (const l of this.listeners) l(s);
  }

  /** Errors outside a request (e.g. activation) go to the extension's output channel, not the console. */
  logError(context: string, err: unknown): void {
    this.log(`${context}: ${err instanceof Error ? err.message : String(err)}`);
  }

  private log(msg: string): void {
    this.output.appendLine(msg);
  }

  url(path: string): string {
    return this.client.url(path);
  }

  private get problems(): Problem[] {
    return this.data.problemList()?.problems ?? [];
  }

  private get languages(): Language[] {
    return this.data.cache.peek<Language[]>('languages')?.value ?? [];
  }

  /** The current problem with the freshest cached data. */
  private currentProblem(): (Problem & { source: MatchSource }) | null {
    if (!this.problem) return null;
    const fresh = this.problems.find((p) => p.id === this.problem!.id);
    return fresh ? { ...fresh, source: this.problem.source } : this.problem;
  }

  // ----------------------------------------------------------- connection

  /**
   * Show a connection problem in the banner (once; no toast, no retry loop).
   * Session problems switch the panel to the login form.
   */
  private reportError(err: unknown, retry: (() => Promise<unknown>) | null): void {
    const problem = classifyConnectionError(err);
    if (!problem) return;
    this.connection = problem;
    this.retryAction = retry;
    if (problem.kind === 'session') {
      this.accountStatus = 'logged-out';
      this.accountError = null; // the banner says it; don't repeat it in the form
      if (err instanceof AuthError && err.reason === 'wrong-password') {
        void this.ctx.secrets.delete(this.secretKey('password'));
        this.hasSavedPassword = false;
      }
    }
    this.emit();
  }

  /** A request succeeded: hide the banner, and resume a result that could not be fetched. */
  private connectionOk(): void {
    if (this.connection && this.connection.kind !== 'session') {
      this.connection = null;
      this.retryAction = null;
      this.emit();
    }
    if (this.pendingPoll && !this.busy) void this.resumePoll();
  }

  /** The banner's button. */
  async retry(): Promise<void> {
    const c = this.connection;
    if (c?.action === 'login') {
      this.connection = null;
      this.emit();
      await vscode.commands.executeCommand('cedtGrader.panel.focus');
      return;
    }
    const action = this.retryAction;
    this.connection = null;
    this.retryAction = null;
    this.emit();
    if (this.pendingPoll) await this.resumePoll();
    else if (action) await action();
    else if (this.problem) await this.data.loadHistory(this.problem.id, true);
    else await this.data.loadProblems(true);
  }

  private reloadKey(key: string): Promise<unknown> {
    const [kind, id] = key.split(':');
    if (kind === 'history') return this.data.loadHistory(Number(id), true);
    if (kind === 'detail') return this.data.loadDetail(Number(id));
    return this.data.loadProblems(true);
  }

  /** The file's language is not accepted by the mapped problem (e.g. a problem picked by mistake). */
  private languageMismatch(problem: Problem): { wanted: string; allowed: string[] } | null {
    if (!this.fileUri || !this.languages.length) return null;
    const allowed = this.allowedLanguages(problem);
    if (!allowed.length) return null;
    const c = chooseLanguage(this.fileUri.fsPath, allowed, this.languages);
    if (c.kind !== 'not-allowed') return null;
    return { wanted: c.wanted, allowed: allowed.map((l) => l.name) };
  }

  // ---------------------------------------------------------------- state

  private problemView(p: Problem): ProblemView {
    return {
      id: p.id,
      name: cleanName(p.name),
      fullName: cleanName(p.fullName),
      score: summarize(p, this.data.problemDetail(p.id)?.fullScore ?? null),
      hasFile: this.mappedIds.has(p.id),
      hasTestcase: p.hasTestcase,
      status: problemStatus(p),
      tags: p.tags ?? [],
      lastSubmissionTime: p.lastSubmissionTime,
      lastOpened: this.ctx.workspaceState.get<Record<string, number>>(OPENED_KEY, {})[p.id] ?? null,
    };
  }

  state(): ViewState {
    const file = this.fileUri;
    const lang = file ? languageNameForPath(file.fsPath, this.languages) : null;
    const loggedIn = this.accountStatus === 'logged-in';
    const problem = this.currentProblem();
    const languagesLoading = this.data.cache.peek('languages') === undefined && loggedIn && !!problem && this.data.isVisible();

    const unavailable = !!problem && this.unavailableIds.has(problem.id);
    const mismatch = problem && !unavailable ? this.languageMismatch(problem) : null;
    let reason: string | null = null;
    if (this.busy) reason = null;
    else if (!file) reason = 'Open a source file to submit it.';
    else if (!loggedIn && !this.hasSavedPassword) reason = 'Log in first.';
    else if (!problem) reason = 'Choose the grader problem for this file.';
    else if (unavailable) reason = 'This problem is no longer available on the grader.';
    else if (mismatch) reason = `This problem doesn't accept ${mismatch.wanted}.`;
    else if (this.languagesError) reason = this.languagesError;

    const enabled = !this.busy && !!file && !!problem && (loggedIn || this.hasSavedPassword) && !mismatch && !unavailable;
    const pState = this.data.state('problems');
    const list = this.data.problemList();

    return {
      baseUrl: this.cfg.baseUrl,
      account: {
        status: this.accountStatus,
        username: this.cfg.username,
        fullName: this.client.user?.fullName || null,
        hasSavedPassword: this.hasSavedPassword,
        rememberPassword: this.rememberPassword,
        error: this.accountError,
      },
      file: file
        ? { path: vscode.workspace.asRelativePath(file, false), name: file.path.split('/').pop() ?? '', languageGuess: lang, supported: lang !== null }
        : null,
      problem: problem ? { ...this.problemView(problem), source: problem.source, sourceLabel: SOURCE_LABEL[problem.source], unavailable } : null,
      // Explicitly unlinked, or no confident match (candidates are only offered in the picker).
      notLinked: !problem && !!file && (this.notLinked || (!!this.data.problemList()?.problems.length && !this.matchInfo.ambiguous)),
      prompt: this.prompt,
      ...(() => {
        const n = problem && file ? linkedNotice(this.linkedFiles, file.fsPath, (f) => vscode.workspace.asRelativePath(f)) : null;
        return { linkedFiles: n ? n.files.map(({ path, current, how }) => ({ path, current, how })) : [], linkedNotice: n?.text ?? null };
      })(),
      cphTip:
        !this.cph.installed && !this.cphTipHidden && !this.ctx.globalState.get<boolean>(CPH_TIP_KEY, false) && !!problem?.hasTestcase,
      matching: {
        suggestions: this.matchInfo.suggestions.map((p) => this.problemView(p)),
        ambiguous: this.matchInfo.ambiguous?.map((p) => this.problemView(p)) ?? null,
        note: this.matchInfo.ambiguous
          ? this.matchInfo.ambiguousSource === 'suggested'
            ? S.match.severalCould
            : S.match.severalMatch(this.matchInfo.ambiguousSource === 'cph')
          : null,
      },
      testcases: { busy: this.testcasesBusy },
      cph: { installed: this.cph.installed },
      languages: {
        loading: languagesLoading,
        items: problem ? this.allowedLanguages(problem).map((l) => ({ id: l.id, name: l.name })) : [],
        selectedId: this.selectedLanguageId,
        mismatch,
      },
      connection: this.connection,
      submit: { enabled, busy: this.busy, reason, label: S.submitLabel },
      result: file ? (this.results.get(file.fsPath) ?? null) : null,
      gradingElsewhere:
        this.busy && this.gradingFile !== null && this.gradingFile !== file?.fsPath
          ? (this.results.get(this.gradingFile)?.problemName ?? 'another file')
          : null,
      history: problem
        ? { ...this.historyView(problem), ...(unavailable ? { stale: true } : {}) }
        : { loading: false, stale: false, error: null, items: [], expanded: null },
      problems: {
        loading: pState.loading,
        loaded: list !== undefined,
        stale: pState.stale,
        items: this.problems.map((p) => this.problemView(p)),
        error: pState.error,
        filter: this.problemFilter(),
        topics: this.topics(list),
        penaltyNote:
          !list || list.listStatus === 'loaded'
            ? null
            : list.listStatus === 'no-web-session'
              ? 'Hint/AI penalties not loaded (password not remembered). Scores shown are best scores.'
              : 'Could not read hint/AI penalties from the problem list. Scores shown are best scores.',
      },
    };
  }

  private historyView(problem: Problem): ViewState['history'] {
    const st = this.data.historyState(problem.id);
    const items = this.data.history(problem.id) ?? [];
    const pretty = new Map(this.languages.map((l) => [l.code, l.name]));
    // The counted (best) submission: highest points; on a tie the earliest one (list is newest first).
    let countedId: number | null = null;
    let best = -Infinity;
    for (let i = items.length - 1; i >= 0; i--) {
      const pts = items[i].points;
      if (pts !== null && pts > best) {
        best = pts;
        countedId = items[i].id;
      }
    }
    const entries: HistoryEntry[] = items.map((h) => ({
      submissionId: h.id,
      number: h.number,
      points: h.points,
      status: h.status,
      comment: h.comment,
      submittedAt: h.submittedAt,
      language: h.language ? (pretty.get(h.language) ?? h.language) : null,
      compileError: h.status === 'compilation_error',
      counted: h.id === countedId && best > 0,
      verdicts: h.status === 'compilation_error' ? [] : parseGraderComment(h.comment),
    }));
    let expanded: ViewState['history']['expanded'] = null;
    if (this.expandedSubmission !== null && items.some((h) => h.id === this.expandedSubmission)) {
      const id = this.expandedSubmission;
      const d = this.data.detail(id);
      const ds = this.data.state(`detail:${id}`);
      expanded = { submissionId: id, loading: ds.loading, error: ds.error, detail: d ? this.detailView(d) : null };
    }
    return { loading: st.loading, stale: st.stale, error: st.error, items: entries, expanded };
  }

  private detailView(d: SubmissionDetail): SubmissionDetailView {
    const evals = [...d.evaluations].sort((a, b) => a.testcaseId - b.testcaseId);
    const msg = d.compilerMessage?.trim() ? d.compilerMessage : null;
    return {
      submissionId: d.id,
      url: this.url(`/submissions/${d.id}`),
      status: d.status,
      compilerMessage: msg,
      maxRuntimeMs: d.maxRuntimeMs,
      peakMemoryKb: d.peakMemoryKb,
      hasSource: d.source !== null,
      sourceFilename: d.sourceFilename,
      evaluations: evals.map((e, i) => ({
        index: i + 1,
        kind: e.result ?? 'unknown',
        label: `Test ${i + 1}: ${resultWord(e.result)}`,
        score: e.score,
        timeMs: e.timeMs,
        memoryKb: e.memoryKb,
      })),
    };
  }

  private problemFilter(): ProblemFilter {
    return this.ctx.workspaceState.get<ProblemFilter>(FILTER_KEY, { status: 'all', topic: null });
  }

  /** Persist the problem-list filter per workspace. */
  async setProblemFilter(f: ProblemFilter): Promise<void> {
    const valid: ProblemFilter['status'][] = ['all', 'unsolved', 'inprogress', 'solved'];
    const sorts = ['default', 'name-asc', 'name-desc', 'latest', 'score-asc', 'score-desc', 'recent'];
    await this.ctx.workspaceState.update(FILTER_KEY, {
      status: valid.includes(f.status) ? f.status : 'all',
      topic: f.topic || null,
      sort: f.sort && sorts.includes(f.sort) ? f.sort : 'default',
    });
    this.emit();
  }

  /** Topic pills: the website's topic tags when known, otherwise every tag in use. */
  private topics(list: import('./grader').ProblemList | undefined): { name: string; description: string | null }[] {
    if (!list) return [];
    if (list.topics && list.topics.length) return list.topics;
    const names = new Set<string>();
    for (const p of list.problems) for (const t of p.tags ?? []) names.add(t);
    return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, description: null }));
  }

  private allowedLanguages(p: Pick<Problem, 'permittedLanguageIds'>): Language[] {
    return p.permittedLanguageIds === null ? this.languages : this.languages.filter((l) => p.permittedLanguageIds!.includes(l.id));
  }

  /**
   * Ask in the panel with plain buttons (no OS dialog). Resolves with the
   * chosen button id, or undefined when replaced, dismissed or the active
   * file changes. Native modal dialogs are only for actions that can't be
   * undone or lose data (overwrite a file, clear data, exam submit).
   */
  askInline(text: string, buttons: InlinePrompt['buttons'], opts: { detail?: string; tone?: 'info' | 'warn' } = {}): Promise<string | undefined> {
    this.promptResolve?.(undefined);
    const id = ++this.promptSeq;
    this.prompt = { id, text, detail: opts.detail ?? null, tone: opts.tone ?? 'info', buttons };
    this.emit();
    if (!this.data.isVisible()) void vscode.commands.executeCommand('cedtGrader.panel.focus');
    return new Promise((resolve) => {
      this.promptResolve = (v) => {
        if (this.prompt?.id === id) {
          this.prompt = null;
          this.promptResolve = null;
          this.emit();
        }
        resolve(v);
      };
    });
  }

  answerPrompt(id: number, button: string | null): void {
    if (this.prompt?.id === id) this.promptResolve?.(button ?? undefined);
  }

  private cancelPrompt(): void {
    this.promptResolve?.(undefined);
  }

  private markUnavailable(problemId: number): void {
    if (this.unavailableIds.has(problemId)) return;
    this.unavailableIds.add(problemId);
    this.emit();
  }

  /** Remember when a problem was last worked on (for "Recently opened" sorting). */
  private async noteOpened(problemId: number): Promise<void> {
    const all = { ...this.ctx.workspaceState.get<Record<string, number>>(OPENED_KEY, {}) };
    all[problemId] = Date.now();
    const keep = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, LIMITS.recentlyOpenedMax);
    await this.ctx.workspaceState.update(OPENED_KEY, Object.fromEntries(keep));
  }

  /** Full name for the Account section (`GET /api/v1/me`, once per session, after a token restore). */
  private async ensureMe(): Promise<void> {
    if (this.client.user || !this.client.isLoggedIn || !this.data.isVisible()) return;
    try {
      await this.data.cache.get('me', { kind: 'session' }, () => this.client.me());
      this.emit();
    } catch {
      /* the login ID is shown instead */
    }
  }

  // ---------------------------------------------------------------- CPH tip

  async cphTip(action: 'install' | 'later' | 'never'): Promise<void> {
    if (action === 'install') await vscode.commands.executeCommand('extension.open', CPH_EXTENSION_ID);
    if (action === 'never') await this.ctx.globalState.update(CPH_TIP_KEY, true);
    this.cphTipHidden = true; // never more than once per session
    this.emit();
  }

  // --------------------------------------------------------------- account

  /**
   * Log in with credentials typed in the sidebar. With `remember`, the
   * password goes to SecretStorage (macOS Keychain); without it, only the
   * token is kept, in memory.
   */
  async loginWith(username: string, password: string, remember: boolean): Promise<boolean> {
    username = username.trim();
    if (!username || !password) {
      this.accountError = 'Enter your username and password.';
      this.emit();
      return false;
    }
    await this.ctx.globalState.update(REMEMBER_KEY, remember);
    if (username !== this.cfg.username) {
      this.changingUsername = true;
      try {
        await vscode.workspace.getConfiguration('cedtGrader').update('username', username, vscode.ConfigurationTarget.Global);
      } finally {
        this.changingUsername = false;
      }
      this.cfg = readConfig();
      await this.client.logout();
      this.client = this.makeClient();
      this.resetSessionState();
    }
    if (remember) await this.ctx.secrets.store(this.secretKey('password'), password);
    else await this.ctx.secrets.delete(this.secretKey('password'));
    this.hasSavedPassword = remember;
    return this.doLogin({ username, password });
  }

  /** Log in with the stored password (explicit user action). */
  async login(): Promise<boolean> {
    const password = await this.getPassword();
    if (!this.cfg.username || !password) {
      await vscode.commands.executeCommand('cedtGrader.panel.focus');
      return false;
    }
    return this.doLogin({ username: this.cfg.username, password });
  }

  private async doLogin(creds: Credentials): Promise<boolean> {
    this.accountStatus = 'logging-in';
    this.accountError = null;
    this.emit();
    try {
      await this.client.login(creds);
      this.accountStatus = 'logged-in';
      this.connection = null;
      this.retryAction = null;
      this.log(`Logged in to ${this.cfg.baseUrl}.`);
      this.data.clear();
      await this.data.loadProblems(true);
      await this.ensureLanguages();
      return true;
    } catch (err) {
      const conn = classifyConnectionError(err);
      if (conn && conn.kind !== 'session') {
        this.accountStatus = 'logged-out';
        this.reportError(err, () => this.doLogin(creds));
        return false;
      }
      await this.onAuthFailure(err);
      return false;
    }
  }

  private async onAuthFailure(err: unknown): Promise<void> {
    this.accountStatus = 'logged-out';
    this.accountError = this.describe(err);
    if (err instanceof AuthError && err.reason === 'wrong-password') {
      await this.ctx.secrets.delete(this.secretKey('password'));
      this.hasSavedPassword = false;
    }
    this.emit();
  }

  /** Remove the token and the stored password. */
  async logout(): Promise<void> {
    this.pollAbort?.abort();
    await this.client.logout();
    if (this.cfg.username) {
      await this.ctx.secrets.delete(this.secretKey('password'));
      await this.ctx.secrets.delete(this.secretKey('token'));
    }
    this.hasSavedPassword = false;
    this.accountError = null;
    this.connection = null;
    this.retryAction = null;
    this.pendingPoll = null;
    this.resetSessionState();
    this.emit();
  }

  /** Ensure an API session: stored token, else a silent login with the stored password. */
  private async ensureLoggedIn(): Promise<boolean> {
    if (this.client.isLoggedIn) return true;
    if (!this.hasSavedPassword) {
      this.accountStatus = 'logged-out';
      this.emit();
      await vscode.commands.executeCommand('cedtGrader.panel.focus');
      return false;
    }
    return this.login();
  }


  private async ensureLanguages(): Promise<void> {
    if (this.data.cache.peek('languages') || !(this.client.isLoggedIn || this.hasSavedPassword) || !this.data.isVisible()) return;
    try {
      await this.data.languages();
      this.applyLanguageChoice();
    } catch (err) {
      if (classifyConnectionError(err)) this.reportError(err, () => this.ensureLanguages());
      else this.languagesError = this.describe(err);
    }
    this.emit();
  }

  // ----------------------------------------------------------- active file

  /**
   * Show the file right away from cached data. Network work (history) is
   * debounced inside DataService and only happens if the cache is missing or stale.
   */
  async setActiveFile(uri: vscode.Uri): Promise<void> {
    const seq = ++this.refreshSeq;
    const changed = this.fileUri?.toString() !== uri.toString();
    this.fileUri = uri;
    if (changed) {
      this.cancelPrompt();
      this.selectedLanguageId = this.ctx.workspaceState.get<Record<string, number>>(LANGUAGE_KEY, {})[uri.fsPath] ?? null;
      this.languagesError = null;
      this.expandedSubmission = null;
    }

    // Matching order: saved → CPH .prob → exact file name → suggestions (never saved automatically).
    // An explicitly unlinked file is left alone ("Not linked to a problem").
    const entry = await this.mapping.get(uri, this.cfg.baseUrl);
    const unlinked = !entry && this.mapping.isUnlinked(uri);
    const list = this.data.problemList()?.problems;
    const cph = entry || unlinked ? null : await readCphProblem(uri.fsPath, this.cphSaveLocation());
    const m = unlinked
      ? ({ kind: 'none', suggestions: [] } as const)
      : resolveProblem({
          savedProblemId: entry?.problemId ?? null,
          cph,
          filePath: uri.fsPath,
          problems: list,
          baseUrl: this.cfg.baseUrl,
          folders: vscode.workspace.asRelativePath(vscode.Uri.joinPath(uri, '..'), false).split('/').filter((x) => x && x !== '.'),
        });
    this.notLinked = unlinked;
    if (seq !== this.refreshSeq) return;
    let problem: (Problem & { source: MatchSource }) | null = null;
    this.matchInfo = { suggestions: [], ambiguous: null, ambiguousSource: null };
    if (m.kind === 'unavailable') {
      // Keep the saved link; the panel offers Change problem / Remove link and disables Submit.
      this.unavailableIds.add(m.problemId);
      problem = { ...placeholder(m.problemId, entry?.name ?? ''), source: 'saved' };
      this.matchInfo.suggestions = m.suggestions;
    } else if (m.kind === 'match') {
      problem = { ...(m.problem.name.startsWith('#') && entry?.name ? placeholder(m.problem.id, entry.name) : m.problem), source: m.source };
    } else if (m.kind === 'ambiguous') {
      this.matchInfo.ambiguous = m.candidates;
      this.matchInfo.ambiguousSource = m.source;
    } else {
      // Below the confidence threshold: not used; candidates only in the picker ("Not linked to a problem").
      this.matchInfo.suggestions = [...m.suggestions];
    }
    if (m.kind === 'match' && m.source === 'suggested') this.matchInfo.suggestions = [...m.suggestions];
    // Remember automatic matches of open files (never over a manual link or "not linked").
    if (!entry && !unlinked && m.kind === 'match' && (m.source === 'filename' || m.source === 'cph' || m.source === 'suggested')) await this.mapping.recordAuto(uri, m.problem.id, m.source);
    else if (!entry && list?.length && m.kind !== 'match') await this.mapping.dropAuto(uri);
    await this.refreshMappedIds();
    if (seq !== this.refreshSeq) return;
    this.problem = problem;
    // Cached name search only here; a missing search runs right after the first render.
    // Suggestions (confident ones only) behave like links for everything read-only.
    this.linkedFiles = problem ? await this.filesForProblem(problem.id, 'cached') : [];
    if (problem && !this.fileSearch.peek(problem.id) && this.data.isVisible()) void this.refreshLinkedFiles();
    if (problem) await this.noteOpened(problem.id);
    this.applyLanguageChoice();
    this.emit();
    // One problem only (the top suggestion at most, never several candidates).
    this.data.focusProblem(problem ? problem.id : null);
    if (!entry && !this.reconnectAsked.has(uri.fsPath)) void this.offerReconnect(uri);
  }

  // ------------------------------------------------ files for a problem

  /**
   * The one "files for this problem" answer (duplicate notice, row click /
   * go to file, before-submit check): saved links, remembered auto-matches
   * and files named like the problem (one cached search per problem).
   * Explicit "not linked" files and files linked to another problem are left out.
   * `search`: 'run' searches if not cached; 'cached' uses only a finished search.
   */
  async filesForProblem(problemId: number, search: 'run' | 'cached' | 'none' = 'run', includeSuggested = true): Promise<ProblemFile[]> {
    const chosen = (await this.mapping.filesFor(problemId, this.cfg.baseUrl)).map((u) => u.fsPath);
    let searched: string[] = [];
    if (search === 'run') searched = await this.fileSearch.get(problemId);
    else if (search === 'cached') searched = (await this.fileSearch.peek(problemId)) ?? [];
    return mergeProblemFiles({
      problemId,
      chosen,
      auto: this.mapping.autoMatches(),
      searched,
      unlinked: this.mapping.unlinkedPaths(),
      linkedElsewhere: await this.mapping.linkedElsewhere(problemId, this.cfg.baseUrl),
      includeSuggested,
    });
  }

  /** Recompute the current problem's files (runs the name search if needed) and re-render. */
  private async refreshLinkedFiles(): Promise<void> {
    const p = this.problem;
    const file = this.fileUri;
    if (!p || !file || !this.data.isVisible()) return;
    const files = await this.filesForProblem(p.id, 'run');
    if (this.problem?.id !== p.id || this.fileUri?.fsPath !== file.fsPath) return;
    this.linkedFiles = files;
    this.emit();
  }

  /** File created / deleted / renamed: drop cached name searches (debounced), then refresh what is shown. */
  private onFileEvent(): void {
    clearTimeout(this.fileEventTimer);
    this.fileEventTimer = setTimeout(() => {
      this.fileSearch.invalidate();
      if (this.data.isVisible()) void this.refreshLinkedFiles();
    }, TIMING.fileEventDebounceMs);
  }

  /** Source extensions of the problem's permitted languages (binary/archive ones skipped). */
  private sourceExtsFor(p: Problem): string[] {
    const exts = new Set<string>();
    for (const l of this.allowedLanguages(p)) {
      if (l.ext && !BINARY_EXTS.has(l.ext.toLowerCase())) exts.add(l.ext.toLowerCase());
      // Other extensions of the same language (e.g. .cc / .cxx for C++).
      for (const [ext, lang] of Object.entries(EXTENSION_LANGUAGE)) if (lang === l.name) exts.add(ext.slice(1));
    }
    return [...exts];
  }

  /**
   * One workspace.findFiles for source files named exactly like the problem
   * (case-insensitive), with a permitted extension, outside excluded folders
   * (same rules as "Find file by name"). Logged as a file search.
   */
  private async searchFilesNamed(problemId: number, background: boolean): Promise<string[]> {
    const p = this.problemById(problemId);
    if (!p) return [];
    if (!background) await this.data.languages().catch(() => undefined);
    const exts = this.sourceExtsFor(p);
    if (!exts.length) return [];
    const cfg = (section: string) => vscode.workspace.getConfiguration(section).get<Record<string, unknown>>('exclude') ?? {};
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    let gitignore: string | null = null;
    if (root) gitignore = await fsReadFile(vscode.Uri.joinPath(root, '.gitignore').fsPath, 'utf8').catch(() => null);
    const t0 = Date.now();
    const found = await vscode.workspace.findFiles(includeGlob(p.name, exts), excludeGlob([cfg('files'), cfg('search')], gitignore), LIMITS.findFilesMax);
    const kept = filterCandidates(found.map((u) => u.fsPath), p.name, exts).slice(0, LIMITS.findFilesKept);
    this.requestLog(`FILE SEARCH "${cleanName(p.name)}.{${exts.join(',')}}" (#${p.id}) → ${kept.length} file${kept.length === 1 ? '' : 's'} (${Date.now() - t0} ms)`);
    return kept;
  }

  /** Existing files for a problem, in the stable path order; missing saved links reported, missing auto-matches dropped. */
  private async existingFilesFor(problemId: number): Promise<{ found: { uri: vscode.Uri; t: number; how: ProblemFile['how'] }[]; gone: vscode.Uri[] }> {
    const found: { uri: vscode.Uri; t: number; how: ProblemFile['how'] }[] = [];
    const gone: vscode.Uri[] = [];
    // Opening a file never links it, so suggestions are fine here.
    for (const f of await this.filesForProblem(problemId, 'run', true)) {
      const st = await fsStat(f.fsPath).catch(() => null);
      if (st) found.push({ uri: vscode.Uri.file(f.fsPath), t: st.mtimeMs, how: f.how });
      else if (f.how === 'chosen') gone.push(vscode.Uri.file(f.fsPath));
      else await this.mapping.deleteAuto(vscode.Uri.file(f.fsPath));
    }
    found.sort((a, b) => comparePaths(vscode.workspace.asRelativePath(a.uri), vscode.workspace.asRelativePath(b.uri)));
    return { found, gone };
  }

  /** Ask once whether to remove saved links whose files are gone. */
  private async offerRemoveStale(gone: vscode.Uri[]): Promise<void> {
    if (!gone.length) return;
    const pick = await this.askInline(
      S.files.noLongerExists(gone.length === 1 ? vscode.workspace.asRelativePath(gone[0]) : S.files.nLinkedFiles(gone.length), gone.length > 1),
      [
        { id: 'remove', label: S.files.removeStale, primary: true },
        { id: 'keep', label: S.common.keep },
      ],
    );
    if (pick !== 'remove') return;
    for (const g of gone) await this.mapping.set(g, undefined);
    await this.refreshMappedIds();
    this.emit();
  }

  private async pickAndOpen(found: { uri: vscode.Uri; t: number; how: ProblemFile['how'] }[], name: string): Promise<void> {
    const how = PICK_HOW;
    const target =
      found.length === 1
        ? found[0].uri
        : (
            await vscode.window.showQuickPick(
              found.map((f) => ({ label: vscode.workspace.asRelativePath(f.uri), description: how[f.how], detail: S.common.edited(new Date(f.t).toLocaleString()), uri: f.uri })),
              { placeHolder: S.files.filesFor(name) },
            )
          )?.uri;
    if (target) await vscode.window.showTextDocument(target);
  }

  /** Problems with a file (saved links + remembered auto-matches), for the row menus. */
  private async refreshMappedIds(): Promise<void> {
    const ids = await this.mapping.mappedProblemIds(this.cfg.baseUrl);
    const blocked = new Set(this.mapping.unlinkedPaths().map((p) => pathKey(p)));
    for (const a of this.mapping.autoMatches()) if (!blocked.has(pathKey(a.fsPath))) ids.add(a.problemId);
    this.mappedIds = ids;
  }

  // ------------------------------------------------------ moved files

  /** Stale mappings (older than 30 days) are removed, at most once a day. */
  private async dailyCleanup(): Promise<void> {
    const last = this.ctx.globalState.get<number>(CLEANUP_KEY, 0);
    if (Date.now() - last < TIMING.dailyCleanupMs) return;
    await this.ctx.globalState.update(CLEANUP_KEY, Date.now());
    const n = await this.mapping.expireStale();
    if (n) this.log(`Removed ${n} mapping(s) whose file has been missing for 30 days.`);
  }

  /** Update mappings (and per-file state) for files renamed or moved inside VS Code. */
  private async onFilesRenamed(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    const moved: { from: string; to: string }[] = [];
    for (const f of files) moved.push(...(await this.mapping.rename(f.oldUri, f.newUri)));
    // Auto-matches follow the file only while the new name still matches.
    for (const f of files) await this.mapping.renameAuto(f.oldUri, f.newUri, (id) => this.problemById(id)?.name);
    this.onFileEvent();
    // Per-file state follows the file even when it had no mapping (results, chosen language).
    const langs = { ...this.ctx.workspaceState.get<Record<string, number>>(LANGUAGE_KEY, {}) };
    for (const f of files) {
      for (const key of [...this.results.keys()]) {
        const to = remapPath(key, f.oldUri.fsPath, f.newUri.fsPath);
        if (to) {
          this.results.set(to, this.results.get(key)!);
          this.results.delete(key);
        }
      }
      for (const key of Object.keys(langs)) {
        const to = remapPath(key, f.oldUri.fsPath, f.newUri.fsPath);
        if (to) {
          langs[to] = langs[key];
          delete langs[key];
        }
      }
      if (this.fileUri) {
        const to = remapPath(this.fileUri.fsPath, f.oldUri.fsPath, f.newUri.fsPath);
        if (to) this.fileUri = vscode.Uri.file(to);
      }
    }
    await this.ctx.workspaceState.update(LANGUAGE_KEY, langs);
    if (!moved.length) return;
    this.log(`Updated ${moved.length} mapping(s) after a rename.`);
    if (this.fileUri) await this.setActiveFile(this.fileUri);

    // CPH names its file after the full source path and does not follow renames: offer once.
    const save = this.cphSaveLocation();
    const withCph = [];
    for (const m of moved) if (await exists(cphProbPathFor(m.from, save))) withCph.push(m);
    if (!withCph.length) return;
    const yes = S.moved.moveCph;
    const pick = await vscode.window.showInformationMessage(
      S.moved.moveCphQuestion(withCph.length === 1 ? vscode.workspace.asRelativePath(withCph[0].to) : null, withCph.length),
      yes,
      S.common.no,
    );
    if (pick !== yes) return;
    let done = 0;
    let skipped = 0;
    for (const m of withCph) {
      const r = await moveCphProblem(m.from, m.to, save);
      if (r.status === 'moved') done++;
      else if (r.status === 'target-exists') skipped++;
    }
    void vscode.window.showInformationMessage(
      S.moved.movedCph(done, skipped),
    );
  }

  /**
   * A file with no mapping was opened: if saved mappings point at a missing
   * file with the same name (moved outside VS Code), ask whether to keep the link.
   * Only the saved mappings are checked; never applied silently.
   */
  private async offerReconnect(uri: vscode.Uri): Promise<void> {
    this.reconnectAsked.add(uri.fsPath);
    const dismissed = new Set(this.ctx.workspaceState.get<string[]>(DISMISSED_KEY, []));
    const candidates = await reconnectCandidates(await this.mapping.allEntries(), uri.fsPath, exists, dismissed);
    if (!candidates.length) return;
    const describeEntry = (c: LocatedEntry) =>
      `${vscode.workspace.asRelativePath(c.fsPath)}, linked to ${this.problemById(c.entry.problemId)?.name ?? c.entry.name ?? `#${c.entry.problemId}`}`;
    let chosen: LocatedEntry | undefined;
    if (candidates.length === 1) {
      const pick = await this.askInline(S.moved.looksLike(describeEntry(candidates[0])), [
        { id: 'keep', label: S.common.keep, primary: true },
        { id: 'no', label: S.moved.notThisOne },
      ]);
      if (pick === 'keep') chosen = candidates[0];
      else if (pick === 'no') await this.dismissReconnect(candidates, uri);
    } else if (candidates.length <= 3) {
      const pick = await this.askInline(S.moved.whichLink(uri.path.split('/').pop() ?? ''), [
        ...candidates.map((c, i) => ({ id: String(i), label: `${vscode.workspace.asRelativePath(c.fsPath)} → ${this.problemById(c.entry.problemId)?.name ?? c.entry.name}` })),
        { id: 'skip', label: S.moved.noneOfThese },
      ]);
      if (pick === 'skip') await this.dismissReconnect(candidates, uri);
      else if (pick !== undefined) chosen = candidates[Number(pick)];
    } else {
      const pick = await vscode.window.showQuickPick(
        [
          ...candidates.map((c) => ({ label: vscode.workspace.asRelativePath(c.fsPath), description: this.problemById(c.entry.problemId)?.name ?? c.entry.name, c })),
          { label: S.moved.skip, description: S.moved.noneOfThese.toLowerCase(), c: undefined },
        ],
        { placeHolder: S.moved.whichLink(uri.path.split('/').pop() ?? '') },
      );
      if (pick?.c) chosen = pick.c;
      else if (pick) await this.dismissReconnect(candidates, uri);
    }
    if (!chosen) return;
    await this.mapping.reconnect(chosen, uri);
    if (this.fileUri?.toString() === uri.toString()) await this.setActiveFile(uri);
  }

  private async dismissReconnect(candidates: LocatedEntry[], uri: vscode.Uri): Promise<void> {
    const list = new Set(this.ctx.workspaceState.get<string[]>(DISMISSED_KEY, []));
    for (const c of candidates) list.add(dismissKey(c.fsPath, uri.fsPath));
    await this.ctx.workspaceState.update(DISMISSED_KEY, [...list]);
  }

  private cphSaveLocation(): string {
    return vscode.workspace.getConfiguration('cph').get<string>('general.saveLocation') ?? '';
  }

  private applyLanguageChoice(): void {
    const problem = this.currentProblem();
    if (!problem || !this.fileUri || !this.languages.length) return;
    const allowed = this.allowedLanguages(problem);
    if (allowed.some((l) => l.id === this.selectedLanguageId)) {
      this.languagesError = null;
    } else {
      const c = chooseLanguage(this.fileUri.fsPath, allowed, this.languages);
      this.selectedLanguageId = c.kind === 'match' ? c.language.id : null;
      this.languagesError = null; // a mismatch is reported once, by languageMismatch()
    }
  }

  async selectLanguage(id: number): Promise<void> {
    this.selectedLanguageId = id;
    this.languagesError = null;
    if (this.fileUri) {
      const all = { ...this.ctx.workspaceState.get<Record<string, number>>(LANGUAGE_KEY, {}) };
      all[this.fileUri.fsPath] = id;
      await this.ctx.workspaceState.update(LANGUAGE_KEY, all);
    }
    this.emit();
  }

  // -------------------------------------------------------------- problems

  /** Problem list: cached for the session; `force` = the Refresh button. */
  async refreshProblems(force = true): Promise<void> {
    if (!force && this.data.problemList()) return;
    if (!(await this.ensureLoggedIn())) return;
    await this.data.loadProblems(force);
    await this.ensureLanguages();
  }

  async refreshHistory(): Promise<void> {
    const p = this.problem;
    if (!p || !(await this.ensureLoggedIn())) return;
    await this.data.loadHistory(p.id, true);
  }

  async mapCurrentFile(problemId: number): Promise<void> {
    if (!this.fileUri) {
      void vscode.window.showInformationMessage(S.files.openSourceFirst);
      return;
    }
    const p = this.problems.find((x) => x.id === problemId);
    await this.mapping.set(this.fileUri, { problemId, name: p?.name ?? '', baseUrl: this.cfg.baseUrl });
    await this.setActiveFile(this.fileUri);
  }

  /**
   * "Unlink this file": remove the link AND remember "not linked", so
   * auto-detection doesn't re-link it. Choosing a problem or Auto-detect clears it.
   */
  async unmapCurrentFile(): Promise<void> {
    if (!this.fileUri) return;
    await this.mapping.set(this.fileUri, undefined);
    await this.mapping.setUnlinked(this.fileUri, true);
    this.problem = null;
    await this.setActiveFile(this.fileUri);
  }

  /** Full name without a repeated "name:" prefix. */
  private subtitleOf(p: Problem): string {
    const full = p.fullName.trim();
    return full && full !== p.name ? (full.startsWith(`${p.name}:`) ? full.slice(p.name.length + 1).trim() : full) : '';
  }

  /**
   * Write action on a suggested match: one inline question; "yes" saves the
   * link (it's not asked again), "Choose another problem" opens the picker.
   */
  private confirmSuggestedFor(file: vscode.Uri, problem: Problem & { source: MatchSource }, question: string, yesLabel: string): Promise<boolean> {
    return confirmSuggestion({
      source: problem.source,
      ask: async () => {
        const pick = await this.askInline(question, [
          { id: 'yes', label: yesLabel, primary: true },
          { id: 'choose', label: S.submit.chooseAnother },
        ]);
        return pick === 'yes' ? 'yes' : pick === 'choose' ? 'choose' : undefined;
      },
      confirm: async () => {
        await this.mapping.set(file, { problemId: problem.id, name: problem.name, baseUrl: this.cfg.baseUrl });
        if (this.problem?.id === problem.id) this.problem = { ...this.problem, source: 'saved' };
        this.emit();
      },
      chooseAnother: () => this.focusProblemPicker(),
    });
  }

  /** Open the problem dropdown in the panel (e.g. "Choose another problem"). */
  async focusProblemPicker(): Promise<void> {
    await vscode.commands.executeCommand('cedtGrader.panel.focus');
    this.focusTarget?.('problem-search');
  }
  /** Set by the sidebar provider: focus something inside the panel. */
  focusTarget: ((t: 'login' | 'problem-search' | 'submit') => void) | null = null;

  /**
   * Click on a row of the problem list: open its linked file (several → most
   * recently edited first; missing → offer to remove the stale link). With no
   * linked file, offer choices; never link automatically.
   */
  async problemRowClick(problemId: number): Promise<void> {
    const p = this.problemById(problemId);
    if (!p) return;
    const { found, gone } = await this.existingFilesFor(problemId);
    await this.offerRemoveStale(gone);
    if (found.length) {
      await this.pickAndOpen(found, p.name);
      return;
    }
    if (gone.length) return;
    const fileName = this.fileUri?.path.split('/').pop();
    const choices = [
      ...(this.fileUri ? [{ label: S.files.linkTo(fileName ?? ''), id: 'link' }] : []),
      { label: S.files.createNew, id: 'new' },
      { label: S.files.findByName, id: 'find' },
      { label: S.files.openStatement, id: 'statement' },
    ];
    const pick = await vscode.window.showQuickPick(choices, { placeHolder: S.files.noLinkedFile(p.name) });
    if (pick?.id === 'link') await this.mapCurrentFile(problemId);
    else if (pick?.id === 'new') await this.newFileForProblem(problemId);
    else if (pick?.id === 'find') await this.findFileByName(problemId);
    else if (pick?.id === 'statement') await this.openStatement(problemId);
  }

  /** Remove duplicate link entries (and tell the user). */
  private async cleanupDuplicateLinks(): Promise<void> {
    const n = await this.mapping.cleanupDuplicates();
    if (n) void vscode.window.showInformationMessage(S.files.cleanedDuplicates(n));
  }

  /** Re-run matching for the active file, ignoring the saved link; ask before replacing a manual link. */
  async autoDetect(): Promise<void> {
    const uri = this.fileUri;
    if (!uri) return;
    const entry = await this.mapping.get(uri, this.cfg.baseUrl);
    await this.mapping.setUnlinked(uri, false); // Auto-detect clears "not linked"
    const list = this.data.problemList()?.problems;
    if (!list) {
      await this.refreshProblems(false);
      if (!this.data.problemList()) return;
    }
    const cph = await readCphProblem(uri.fsPath, this.cphSaveLocation());
    const m = resolveProblem({ savedProblemId: null, cph, filePath: uri.fsPath, problems: this.data.problemList()!.problems, baseUrl: this.cfg.baseUrl });
    const how = S.autoDetect.how;
    if (entry && m.kind === 'match' && m.problem.id !== entry.problemId) {
      const pick = await this.askInline(S.autoDetect.found(m.problem.name, how[m.source] ?? how.suggested), [
        { id: 'switch', label: S.autoDetect.switch, primary: true },
        { id: 'keep', label: S.autoDetect.keepCurrent },
      ]);
      if (pick !== 'switch') return;
      await this.mapping.set(uri, undefined);
      await this.setActiveFile(uri);
      return;
    }
    if (entry && m.kind === 'match') {
      void this.askInline(S.autoDetect.agrees(m.problem.name, how[m.source] ?? ''), [{ id: 'ok', label: S.common.ok }]);
      return;
    }
    if (entry) {
      void this.askInline(
        m.kind === 'ambiguous' ? S.autoDetect.ambiguousKept(m.candidates.length) : S.autoDetect.noneKept,
        [{ id: 'ok', label: S.common.ok }],
      );
      return;
    }
    await this.setActiveFile(uri);
    if (m.kind === 'none' && !m.suggestions.length) void this.askInline(S.autoDetect.none, [{ id: 'ok', label: S.common.ok }]);
  }

  /** The notice's list as shown (current file first). */
  private noticeFiles(): ProblemFile[] {
    const file = this.fileUri;
    if (!file) return [];
    return linkedNotice(this.linkedFiles, file.fsPath, (f) => f)?.files.map(({ fsPath, how }) => ({ fsPath, how })) ?? [];
  }

  /** Jump to one of the files for the current problem (index into the list the panel shows). */
  async openLinkedFile(index: number): Promise<void> {
    const f = this.noticeFiles()[index];
    if (!f) return;
    if (!(await exists(f.fsPath))) {
      void this.goToFile(this.problem?.id ?? -1); // offers removing the stale link
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(f.fsPath));
  }

  /**
   * Unlink one other file from the notice: a chosen link is removed; a name /
   * CPH match gets the explicit "not linked" state ("Don't match this file").
   * Either way auto-detection leaves that file alone afterwards.
   */
  async unlinkLinkedFile(index: number): Promise<void> {
    const f = this.noticeFiles()[index];
    if (!f || pathKey(f.fsPath) === pathKey(this.fileUri?.fsPath ?? '')) return;
    await this.detachFile(f);
    if (this.fileUri) await this.setActiveFile(this.fileUri);
  }

  private async detachFile(f: ProblemFile): Promise<void> {
    const uri = vscode.Uri.file(f.fsPath);
    if (f.how === 'chosen') await this.mapping.set(uri, undefined);
    await this.mapping.dropAuto(uri);
    await this.mapping.setUnlinked(uri, true);
  }

  /** Keep the active file as the only one for its problem ("Unlink the other files"). */
  async keepOnlyThisFile(): Promise<void> {
    const file = this.fileUri;
    const problem = this.problem;
    if (!file || !problem) return;
    const others = this.linkedFiles.filter((f) => pathKey(f.fsPath) !== pathKey(file.fsPath));
    if (!others.length) return;
    const pick = await this.askInline(
      S.files.unlinkOthers(others.length === 1 ? vscode.workspace.asRelativePath(others[0].fsPath) : S.files.nOtherFiles(others.length), problem.name),
      [
        { id: 'unlink', label: S.files.unlink, primary: true },
        { id: 'cancel', label: S.common.cancel },
      ],
      { detail: S.files.linksOnly },
    );
    if (pick !== 'unlink') return;
    for (const f of others) await this.detachFile(f);
    if (this.problem?.source !== 'saved') await this.mapping.set(file, { problemId: problem.id, name: problem.name, baseUrl: this.cfg.baseUrl });
    await this.setActiveFile(file);
  }

  // ------------------------------------------------------------ linking

  /** Copy the clean problem name (zero-width characters removed): a file named like it is matched exactly. */
  async copyProblemName(problemId: number): Promise<void> {
    const p = this.problemById(problemId);
    if (!p) return;
    const name = cleanName(p.name);
    await vscode.env.clipboard.writeText(name);
    void vscode.window.setStatusBarMessage(S.files.copied(name), TIMING.statusMessageMs);
  }

  /** Create `<clean name>.<ext>` next to the active file (or in the workspace root), open it and map it. */
  async newFileForProblem(problemId: number): Promise<void> {
    const p = this.problemById(problemId);
    if (!p) return;
    const folder =
      (this.fileUri ? vscode.Uri.joinPath(this.fileUri, '..') : undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) {
      void vscode.window.showInformationMessage(S.files.openFolderFirst);
      return;
    }
    await this.data.languages().catch(() => undefined);
    const permitted = this.allowedLanguages(p);
    if (!permitted.length) {
      void vscode.window.showInformationMessage(S.files.languagesNotLoaded);
      return;
    }
    // Active file's language → last used for new files → cedtGrader.defaultLanguage → ask. Never archive/binary automatically.
    const choice = chooseNewFileLanguage({
      permitted,
      activeFilePath: this.fileUri?.fsPath ?? null,
      lastUsedLanguageId: this.ctx.globalState.get<number>(NEWFILE_LANG_KEY) ?? null,
      defaultLanguageName: this.cfg.defaultLanguage,
    });
    const language =
      choice.kind === 'auto'
        ? choice.language
        : (await vscode.window.showQuickPick(choice.options.map((l) => ({ label: l.name, description: l.ext ? `.${l.ext}` : undefined, l })), { placeHolder: S.files.newFileLanguage(p.name) }))?.l;
    if (!language) return;
    await this.ctx.globalState.update(NEWFILE_LANG_KEY, language.id);
    const target = vscode.Uri.joinPath(folder, fileNameFor(p.name, language.ext && language.ext !== 'null' ? language.ext : 'txt'));
    const created = await createFileNoOverwrite(target.fsPath, async () => {
      const open = S.files.openExisting;
      const overwrite = S.files.overwrite;
      const pick = await vscode.window.showWarningMessage(S.files.alreadyExists(vscode.workspace.asRelativePath(target)), { modal: true }, open, overwrite);
      return pick === overwrite ? 'overwrite' : pick === open ? 'open' : 'cancel';
    });
    if (created === 'cancel') return;
    await this.mapping.set(target, { problemId: p.id, name: p.name, baseUrl: this.cfg.baseUrl });
    await vscode.window.showTextDocument(target);
  }

  /** Open the file(s) for a problem (same list as the duplicate notice). */
  async goToFile(problemId: number): Promise<void> {
    const p = this.problemById(problemId);
    const { found, gone } = await this.existingFilesFor(problemId);
    await this.offerRemoveStale(gone);
    if (found.length) await this.pickAndOpen(found, p?.name ?? `#${problemId}`);
  }

  /**
   * "Find file by name" (only when clicked): one workspace.findFiles for source
   * files named like the problem (case-insensitive) with an extension of a
   * permitted language; build output, binaries and excluded folders are skipped.
   */
  async findFileByName(problemId: number): Promise<void> {
    const p = this.problemById(problemId);
    if (!p) return;
    await this.data.languages().catch(() => undefined);
    const exts = this.sourceExtsFor(p);
    if (!exts.length) {
      void vscode.window.showInformationMessage(S.files.noSourceLanguage(p.name));
      return;
    }
    const kept = await this.searchFilesNamed(problemId, false);
    if (!kept.length) {
      void vscode.window.showInformationMessage(S.files.noFileNamed(cleanName(p.name), [...exts].map((e) => `.${e}`).join(', ')));
      return;
    }
    const mtimes = new Map<string, number>();
    for (const f of kept) mtimes.set(f, (await fsStat(f).catch(() => null))?.mtimeMs ?? 0);
    const activeDir = this.fileUri ? vscode.Uri.joinPath(this.fileUri, '..').fsPath : null;
    const ranked = rankCandidates(kept, activeDir, (f) => mtimes.get(f) ?? 0);
    let target: string | undefined = ranked[0];
    if (ranked.length > 1) {
      target = (
        await vscode.window.showQuickPick(
          ranked.map((f) => ({
            label: vscode.workspace.asRelativePath(f),
            description: activeDir && vscode.Uri.joinPath(vscode.Uri.file(f), '..').fsPath === activeDir ? S.files.sameFolder : undefined,
            detail: S.common.modified(new Date(mtimes.get(f) ?? 0).toLocaleString()),
            f,
          })),
          { placeHolder: S.files.filesNamed(cleanName(p.name)) },
        )
      )?.f;
    }
    if (!target) return;
    const uri = vscode.Uri.file(target);
    await vscode.window.showTextDocument(uri);
    const link = S.files.link;
    const pick = await vscode.window.showInformationMessage(S.files.linkFileTo(vscode.workspace.asRelativePath(uri), p.name, p.id), link, S.common.notNow);
    if (pick === link) {
      await this.mapping.set(uri, { problemId: p.id, name: p.name, baseUrl: this.cfg.baseUrl });
      await this.setActiveFile(uri);
    }
  }

  // ---------------------------------------------------------- test cases

  /**
   * Download the grader's test cases (one at a time, cached in globalStorage)
   * and save them: into CPH's problem file when CPH is installed, otherwise as
   * `<problem>/tests/<n>.in|out` files (asked once per workspace) or not at all.
   */
  async loadTestcases(refresh = false): Promise<void> {
    const problem = this.currentProblem();
    const file = this.fileUri;
    if (!problem || !file || this.testcasesBusy) return;
    if (!problem.hasTestcase) {
      void vscode.window.showInformationMessage(S.testcases.none(problem.name));
      return;
    }
    // Writing test cases for a guess: ask once (yes confirms the link).
    if (!(await this.confirmSuggestedFor(file, problem, S.testcases.suggestedQ(problem.name, this.subtitleOf(problem)), S.testcases.load))) return;
    if (!(await this.ensureLoggedIn())) return;
    this.testcasesBusy = true;
    this.emit();
    try {
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Test cases for ${problem.name}`, cancellable: true },
        async (progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          let last = 0;
          return this.testcases.get(problem.id, {
            refresh,
            signal: abort.signal,
            onProgress: (done, total) => {
              progress.report({ message: `downloading ${done} / ${total}`, increment: total ? ((done - last) / total) * 100 : 0 });
              last = done;
            },
          });
        },
      );
      this.connectionOk();
      if (res.status === 'not-available') {
        void vscode.window.showInformationMessage(S.testcases.notAllowed(problem.name));
        return;
      }
      const { set } = res;
      const total = set.cases.length + set.truncated.length;
      const tooLarge = set.truncated.length ? S.testcases.tooLarge(set.truncated.length) : '';
      const refetch = S.testcases.downloadAgain;

      const target = chooseTestcaseTarget(this.cph.installed, this.ctx.workspaceState.get<'files'>(TESTCASE_TARGET_KEY));
      if (target !== 'cph') {
        if (target === 'ask') {
          const files = S.testcases.saveAsFiles;
          const install = S.common.installCph;
          const pick = await vscode.window.showInformationMessage(
            S.testcases.whereTo(set.cases.length),
            { detail: S.testcases.whereToDetail },
            files,
            install,
          );
          if (pick === install) {
            await vscode.commands.executeCommand('extension.open', CPH_EXTENSION_ID);
            return;
          }
          if (pick !== files) return;
          await this.ctx.workspaceState.update(TESTCASE_TARGET_KEY, 'files'); // remembered per workspace
        }
        const folder = testsFolderFor(dirname(file.fsPath), problem.name);
        if (!(await exists(folder))) {
          const create = S.testcases.createFolder;
          const ok = await vscode.window.showInformationMessage(
            S.testcases.createFolderQ(vscode.workspace.asRelativePath(folder), set.cases.length),
            create,
          );
          if (ok !== create) return;
        }
        const r = await saveTestcasesAsFiles(folder, set.cases);
        const extra = [r.unchanged ? S.testcases.unchanged(r.unchanged) : '', r.keptExisting ? S.testcases.keptExisting(r.keptExisting) : '']
          .filter(Boolean)
          .join(', ');
        const open = S.testcases.showFolder;
        const install = S.common.installCph;
        const pick = await vscode.window.showInformationMessage(
          S.testcases.savedFiles(r.written, total, vscode.workspace.asRelativePath(folder), tooLarge, extra),
          open,
          install,
          ...(res.fromCache ? [refetch] : []),
        );
        if (pick === open) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(folder));
        if (pick === install) await vscode.commands.executeCommand('extension.open', CPH_EXTENSION_ID);
        if (pick === refetch) await this.loadTestcases(true);
        return;
      }

      const result = await importIntoCph({
        srcPath: file.fsPath,
        saveLocation: this.cphSaveLocation(),
        problemName: cleanName(problem.name),
        problemUrl: this.url(WEB_PATHS.problem(problem.id)),
        cases: set.cases,
      });
      const parts = [S.testcases.savedCph(set.cases.length, total, tooLarge)];
      if (result.alreadyPresent) parts.push(S.testcases.alreadyPresent(result.alreadyPresent));
      if (result.updated) parts.push(S.testcases.updated(result.updated));
      if (result.added) parts.push(S.testcases.added(result.added));
      const reload = S.testcases.reloadCph;
      const pick = await vscode.window.showInformationMessage(
        S.testcases.cphDone(parts.join('; '), !!result.backupPath),
        reload,
        ...(res.fromCache ? [refetch] : []),
      );
      if (pick === reload) await this.reloadCph(file);
      if (pick === refetch) await this.loadTestcases(true);
    } catch (err) {
      if (classifyConnectionError(err)) this.reportError(err, () => this.loadTestcases(refresh));
      else void vscode.window.showErrorMessage(S.testcases.failed(this.describe(err)));
    } finally {
      this.testcasesBusy = false;
      this.emit();
    }
  }

  /**
   * CPH only re-reads a .prob when the active editor changes (no reload
   * command exists). Briefly show a read-only placeholder and come back.
   */
  async reloadCph(file: vscode.Uri): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: SUBMISSION_SCHEME, path: '/0/reloading-cph' }));
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.window.showTextDocument(file, { preview: false });
  }

  /** Command-palette flow: searchable QuickPick of the cached problem list. */
  async chooseProblemQuickPick(): Promise<void> {
    if (!this.fileUri) {
      void vscode.window.showInformationMessage(S.files.openSourceFirstShort);
      return;
    }
    if (!this.data.problemList()) {
      await vscode.commands.executeCommand('cedtGrader.panel.focus');
      await this.refreshProblems(false);
    }
    if (!this.problems.length) return;
    const pick = await vscode.window.showQuickPick(
      this.problems.map((p) => {
        const s = summarize(p);
        return {
          label: p.name,
          description: p.fullName !== p.name ? p.fullName : undefined,
          detail: `#${p.id}${s.counted !== null ? S.files.counted(s.counted) : ''}`,
          id: p.id,
        };
      }),
      { placeHolder: S.files.problemFor(this.fileUri.path.split('/').pop() ?? ''), matchOnDescription: true, matchOnDetail: true },
    );
    if (pick) await this.mapCurrentFile(pick.id);
  }

  // ---------------------------------------------------------------- history

  /** Expand / collapse a history entry; details are fetched on demand (cached once final). */
  async toggleSubmission(id: number): Promise<void> {
    this.expandedSubmission = this.expandedSubmission === id ? null : id;
    this.emit();
    if (this.expandedSubmission === id) await this.data.loadDetail(id);
  }

  private async detailWithSource(id: number): Promise<SubmissionDetail | undefined> {
    const d = this.data.detail(id) ?? (await this.data.loadDetail(id));
    if (d && d.source === null) void vscode.window.showInformationMessage(S.submit.noSource);
    return d?.source !== null ? d : undefined;
  }

  /** Open a past submission's source in a new untitled editor (never touches the user's file). */
  async openSubmissionSource(id: number): Promise<void> {
    const d = await this.detailWithSource(id);
    if (!d) return;
    const doc = await vscode.workspace.openTextDocument({ content: d.source ?? '', language: vscodeLanguageId(d.sourceFilename ?? this.fileUri?.path ?? '') });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** Diff a past submission (read-only virtual document) against the current file. */
  async compareSubmission(id: number): Promise<void> {
    if (!this.fileUri) return;
    const d = await this.detailWithSource(id);
    if (!d) return;
    const name = d.sourceFilename || 'submission';
    const left = vscode.Uri.from({ scheme: SUBMISSION_SCHEME, path: `/${d.id}/${name}` });
    const label = `${d.number !== null ? `Attempt ${d.number}` : `#${d.id}`} ↔ ${this.fileUri.path.split('/').pop()}`;
    await vscode.commands.executeCommand('vscode.diff', left, this.fileUri, label);
  }

  /** Content for `cedt-grader-submission:/<id>/<file>` URIs (cache only, no request). */
  submissionSource(uri: vscode.Uri): string {
    const id = Number(uri.path.split('/')[1]);
    return this.data.detail(id)?.source ?? '';
  }

  // ---------------------------------------------------------------- submit

  async submit(): Promise<void> {
    if (this.busy) {
      void vscode.window.showInformationMessage(S.submit.alreadyGrading);
      return;
    }
    const fileUri = this.fileUri;
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === fileUri?.toString());
    const doc = editor?.document ?? (fileUri ? await vscode.workspace.openTextDocument(fileUri) : undefined);
    if (!doc || !fileUri) {
      void vscode.window.showInformationMessage(S.submit.openToSubmit);
      return;
    }
    if (!(await this.ensureLoggedIn())) return;
    if (!this.problem) {
      await this.chooseProblemQuickPick();
      if (!this.problem) return;
    }
    const problem = this.currentProblem()!;
    const key = fileUri.fsPath;
    const fileName = fileUri.path.split('/').pop() ?? '';

    let sentId: number | null = null;
    let countedBefore: number | null = null;
    try {
      // Everything needed comes from the cache: no extra request before submitting.
      countedBefore = countedScore(problem.bestScore, problem.list?.cost ?? 0, problem.list?.rawSum ?? false);
      await this.data.languages();
      const allowed = this.allowedLanguages(problem);

      // Exam hint (section 2b), from the problem list page we already fetched. Never remembered.
      let warned = false;
      if (this.client.contestPage) {
        const open = S.exam.openInBrowser;
        const anyway = S.exam.submitAnyway;
        const pick = await vscode.window.showWarningMessage(EXAM_WARNING, { modal: true }, open, anyway);
        if (pick === open) await this.openProblemInBrowser(problem.id);
        if (pick !== anyway) return;
        warned = true;
      }

      let languageId = this.selectedLanguageId;
      if (languageId === null || !allowed.some((l) => l.id === languageId)) {
        const c = chooseLanguage(fileUri.fsPath, allowed, this.languages);
        if (c.kind === 'match') languageId = c.language.id;
        else if (c.kind === 'not-allowed') throw new LanguageNotAllowedError(S.submit.notAllowed(c.wanted));
        else {
          const options = c.kind === 'ambiguous' ? c.candidates : c.allowed;
          const pick = await vscode.window.showQuickPick(options.map((l) => ({ label: l.name, id: l.id })), {
            placeHolder: S.submit.languageFor,
          });
          if (!pick) return;
          languageId = pick.id;
        }
        await this.selectLanguage(languageId);
      }
      const language = allowed.find((l) => l.id === languageId);

      if (this.unavailableIds.has(problem.id)) {
        throw new ProblemUnavailableError(S.submit.unavailable, 404);
      }

      // Another file linked to the same problem changed more recently? Ask (drafts are normal).
      const others = (await this.filesForProblem(problem.id, 'run')).filter((f) => pathKey(f.fsPath) !== pathKey(fileUri.fsPath)).map((f) => vscode.Uri.file(f.fsPath));
      if (others.length) {
        const mine = doc.isDirty ? Date.now() : ((await fsStat(fileUri.fsPath).catch(() => null))?.mtimeMs ?? 0);
        let newest: { uri: vscode.Uri; t: number } | null = null;
        for (const u of others) {
          const t = (await fsStat(u.fsPath).catch(() => null))?.mtimeMs ?? 0;
          if (t > mine && (!newest || t > newest.t)) newest = { uri: u, t };
        }
        if (newest) {
          const pick = await this.askInline(
            S.submit.newerOther(vscode.workspace.asRelativePath(newest.uri)),
            [
              { id: 'go', label: S.submit.submitThis, primary: true },
              { id: 'open', label: S.submit.openOther },
            ],
            { tone: 'warn', detail: S.submit.bothLinked(problem.name, problem.id) },
          );
          if (pick === 'open') await vscode.window.showTextDocument(newest.uri);
          if (pick !== 'go') return;
        }
      }

      // A suggested (unconfirmed) match always asks, even with confirmations off.
      if (problem.source === 'suggested') {
        if (!(await this.confirmSuggestedFor(fileUri, problem, S.submit.suggestedQ(problem.name, this.subtitleOf(problem)), S.submit.submit))) return;
        warned = true;
      }

      if (this.cfg.confirmBeforeSubmit && !warned) {
        const pick = await this.askInline(
          S.submit.confirmQ(fileName, problem.name, problem.id, language?.name ?? null),
          [
            { id: 'submit', label: S.submit.submit, primary: true },
            { id: 'cancel', label: S.common.cancel },
          ],
          { detail: S.submit.confirmOff },
        );
        if (pick !== 'submit') return;
      }

      // Busy from here on (questions above don't lock the panel).
      this.busy = true;
      this.gradingFile = key;
      this.setResult(key, newResult(problem, 'submitting', S.submit.submitting));
      const sub = await this.client.submit(problem.id, languageId!, doc.getText(), fileName);
      sentId = sub.id;
      this.connectionOk();
      this.updateResult(key, {
        phase: 'grading',
        submissionId: sub.id,
        number: sub.number,
        submissionUrl: this.url(`/submissions/${sub.id}`),
        message: S.submit.waiting,
      });
      // Poll only this submission until final.
      await this.pollAndFinish(key, problem, sub.id, countedBefore);
    } catch (err) {
      // Connection problems: say whether anything was submitted; the banner shows the cause.
      const connectionMsg = describeSubmitFailure(err, sentId);
      const msg = connectionMsg ?? this.describe(err);
      if (connectionMsg) {
        if (sentId !== null) this.pendingPoll = { key, problem, submissionId: sentId, countedBefore };
        this.reportError(err, null);
      }
      const r = this.results.get(key);
      if (r && r.problemId === problem.id && (r.phase === 'submitting' || r.phase === 'grading')) {
        this.updateResult(key, { phase: sentId !== null && connectionMsg ? 'timeout' : 'error', message: msg });
      } else {
        this.setResult(key, newResult(problem, 'error', msg));
      }
      if (err instanceof ProblemUnavailableError) this.markUnavailable(problem.id);
      if (!connectionMsg) void this.showError(err, msg);
    } finally {
      if (this.gradingFile === key) {
        this.busy = false;
        this.gradingFile = null;
        this.pollAbort = null;
      }
      this.emit();
    }
  }

  /** Poll one submission, then refresh history + list once and report the counted-score change. */
  private async pollAndFinish(key: string, problem: Problem, submissionId: number, countedBefore: number | null): Promise<void> {
    const final = await this.poll(key, problem, submissionId);
    if (!final) return;
    this.pendingPoll = null;
    this.connectionOk();
    this.data.recordDetail(final);
    await this.data.afterSubmit(problem.id);
    const updated = this.currentProblem();
    const after = updated ? countedScore(updated.bestScore, updated.list?.cost ?? 0, updated.list?.rawSum ?? false) : null;
    this.updateResult(key, { improvement: describeImprovement(countedBefore, after, final.points) });
  }

  /** Continue a submission whose result could not be fetched (Retry, or connection back). */
  private async resumePoll(): Promise<void> {
    const p = this.pendingPoll;
    if (!p || this.busy) return;
    this.pendingPoll = null;
    this.busy = true;
    this.gradingFile = p.key;
    this.updateResult(p.key, { phase: 'grading', message: S.submit.connectionBack });
    try {
      await this.pollAndFinish(p.key, p.problem, p.submissionId, p.countedBefore);
    } catch (err) {
      if (classifyConnectionError(err)) {
        this.pendingPoll = p;
        this.reportError(err, null);
        this.updateResult(p.key, { phase: 'timeout', message: describeSubmitFailure(err, p.submissionId) });
      } else {
        this.updateResult(p.key, { phase: 'error', message: this.describe(err) });
      }
    } finally {
      this.busy = false;
      this.gradingFile = null;
      this.emit();
    }
  }

  private setResult(key: string, r: ResultView): void {
    this.results.set(key, r);
    this.emit();
  }

  private updateResult(key: string, patch: Partial<ResultView>): void {
    const r = this.results.get(key);
    if (!r) return;
    this.results.set(key, { ...r, ...patch });
    this.emit();
  }

  /** Poll the API until graded. Returns null when stopped or timed out (result updated accordingly). */
  private async poll(key: string, problem: Problem, submissionId: number): Promise<SubmissionDetail | null> {
    const abort = new AbortController();
    this.pollAbort = abort;
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Grading ${problem.name} (#${submissionId})`, cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => abort.abort());
        try {
          return await this.client.pollSubmission(submissionId, {
            intervalMs: this.cfg.pollIntervalSeconds * 1000,
            signal: abort.signal,
            onUpdate: (s) => {
              progress.report({ message: s.state === 'graded' ? 'graded' : s.status.replace(/_/g, ' ') });
              this.applySubmission(key, s);
            },
          });
        } catch (err) {
          if (abort.signal.aborted) {
            this.updateResult(key, { phase: 'timeout', message: S.submit.stoppedWaiting });
            return null;
          }
          if (err instanceof PollTimeoutError) {
            this.updateResult(key, { phase: 'timeout', message: err.message });
            return null;
          }
          throw err;
        }
      },
    );
  }

  private applySubmission(key: string, s: SubmissionDetail): void {
    const graded = s.state === 'graded';
    this.updateResult(key, {
      phase: graded ? 'done' : 'grading',
      submissionId: s.id,
      submissionUrl: this.url(`/submissions/${s.id}`),
      number: s.number,
      points: s.points,
      comment: s.comment,
      verdicts: s.verdicts,
      compileError: s.compileError,
      compilerMessage: s.compileError ? (s.compilerMessage ?? '') : null,
      message: graded ? (s.compileError ? 'Compilation error' : null) : `Waiting to be graded… (${s.status.replace(/_/g, ' ')})`,
    });
  }

  /** Latest submission of the current file's problem, from history (refreshes history if stale). */
  async showLastResult(): Promise<void> {
    await vscode.commands.executeCommand('cedtGrader.panel.focus');
    const problem = this.currentProblem();
    const key = this.fileUri?.fsPath;
    if (!problem || !key || this.busy) return;
    if (!(await this.ensureLoggedIn())) return;
    const items = (await this.data.loadHistory(problem.id)) ?? [];
    if (!items.length) {
      this.setResult(key, newResult(problem, 'done', 'No submissions yet.'));
      return;
    }
    const d = await this.data.loadDetail(items[0].id);
    if (!d) return;
    this.setResult(key, newResult(problem, 'grading', null));
    this.applySubmission(key, d);
    if (d.state !== 'graded') this.updateResult(key, { phase: 'timeout', message: S.submit.stillGrading });
  }

  async showCompilerMessage(): Promise<void> {
    const key = this.fileUri?.fsPath;
    const r = key ? this.results.get(key) : undefined;
    if (!r?.compileError) return;
    const doc = await vscode.workspace.openTextDocument({ content: r.compilerMessage ?? '', language: 'log' });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }

  // ---------------------------------------------------------------- browser

  /** Open the read-only statement tab (cached PDF / description; no request when cached). */
  async openStatement(problemId?: number): Promise<void> {
    const id = problemId ?? this.problem?.id;
    if (!id) {
      void vscode.window.showInformationMessage(S.submit.chooseFirst);
      return;
    }
    // A cached statement opens even when logged out (no request); otherwise the viewer explains.
    const p = this.problemById(id);
    await this.statements.open(id, p?.name ?? `#${id}`, {
      outdated: this.unavailableIds.has(id) ? 'This problem is no longer available on the grader; this saved copy may be out of date.' : null,
    });
  }

  async openStatementInBrowser(problemId: number): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(this.url(`/problems/${problemId}/download/statement`)));
  }

  private problemById(id: number): Problem | undefined {
    return this.problems.find((p) => p.id === id) ?? (this.problem?.id === id ? this.problem : undefined);
  }

  async openProblemInBrowser(problemId?: number): Promise<void> {
    const id = problemId ?? this.problem?.id;
    if (!id) return;
    await vscode.env.openExternal(vscode.Uri.parse(this.url(WEB_PATHS.problem(id))));
  }

  async openSubmission(id: number): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(this.url(`/submissions/${id}`)));
  }

  // ----------------------------------------------------------------- errors

  describe(err: unknown): string {
    if (err instanceof NetworkError) return S.errors.checkConnection(err.message);
    if (err instanceof GraderError) return err.message;
    if (err instanceof Error) return S.errors.unexpected(err.message);
    return String(err);
  }

  /** Toast only when the sidebar is hidden (otherwise the panel already shows the message). */
  private async showError(err: unknown, msg: string): Promise<void> {
    this.log(`Error: ${msg}`);
    if (this.data.isVisible()) return;
    const actions: string[] = err instanceof NetworkError ? [S.common.showLog] : [];
    const pick = await vscode.window.showErrorMessage(msg, ...actions);
    if (pick === S.common.showLog) this.output.show();
  }
}

export interface InlinePrompt {
  id: number;
  text: string;
  detail: string | null;
  tone: 'info' | 'warn';
  buttons: { id: string; label: string; primary?: boolean }[];
}

/** VS Code language id for a file name, so "Open this version" gets syntax highlighting. */
function vscodeLanguageId(filename: string): string {
  const ext = /\.([^./]+)$/.exec(filename.toLowerCase())?.[1] ?? '';
  const map: Record<string, string> = {
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', py: 'python', java: 'java', rs: 'rust', go: 'go', php: 'php',
    hs: 'haskell', rb: 'ruby', pas: 'pascal', sql: 'sql', dig: 'xml',
  };
  return map[ext] ?? 'plaintext';
}

function newResult(problem: Problem, phase: ResultView['phase'], message: string | null): ResultView {
  return {
    phase,
    problemId: problem.id,
    problemName: problem.name,
    submissionId: null,
    submissionUrl: null,
    number: null,
    points: null,
    comment: null,
    verdicts: [],
    compileError: false,
    compilerMessage: null,
    improvement: null,
    message,
  };
}

