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
  languageForPath,
  matchLanguages,
  NetworkError,
  parseGraderComment,
  PollTimeoutError,
  type Problem,
  resultWord,
  type StoredToken,
  type SubmissionDetail,
  summarize,
} from './grader';
import { dirname } from 'node:path';
import { chooseTestcaseTarget, CPH_EXTENSION_ID, CphPresence, saveTestcasesAsFiles, testsFolderFor } from './cphIntegration';
import { TestcaseStore } from './data/testcaseStore';
import { cphProbPath as cphProbPathFor, readCphProblem } from './mapping/cph';
import { importIntoCph } from './mapping/cphImport';
import { createFileNoOverwrite, pathExists as exists } from './mapping/newFile';
import { dismissKey, type LocatedEntry, moveCphProblem, reconnectCandidates, remapPath } from './mapping/mappingOps';
import { cleanName, fileNameFor, type MatchSource, placeholder, resolveProblem, SOURCE_LABEL } from './mapping/match';
import { MappingStore } from './mapping/store';
import type { HistoryEntry, ProblemView, ResultView, SubmissionDetailView, ViewState } from './shared/messages';

export const EXAM_WARNING =
  'This problem looks like part of an exam/contest. Submitting from VS Code may not be allowed. Check with your instructor.';

/** URI scheme serving the source of a past submission (for the diff view). */
export const SUBMISSION_SCHEME = 'cedt-grader-submission';

const LANGUAGE_KEY = 'cedtGrader.languageByFile';
const DISMISSED_KEY = 'cedtGrader.dismissedReconnects';
const CLEANUP_KEY = 'cedtGrader.lastMappingCleanup';
const TESTCASE_TARGET_KEY = 'cedtGrader.testcaseTarget';
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
  private matchInfo: { suggestions: Problem[]; ambiguous: Problem[] | null; ambiguousSource: 'cph' | 'filename' | null; staleMappingId: number | null } = {
    suggestions: [],
    ambiguous: null,
    ambiguousSource: null,
    staleMappingId: null,
  };
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
    this.data.onError = (e, key) => this.reportError(e, () => this.reloadKey(key));
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
      // Deleted mapped files: mark stale (not removed), so a moved file can reconnect.
      vscode.workspace.onDidDeleteFiles((e) => {
        void Promise.all(e.files.map((f) => this.mapping.markDeleted(f))).then(async () => {
          this.mappedIds = await this.mapping.mappedProblemIds(this.cfg.baseUrl);
          this.emit();
        });
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.fileName.endsWith('.cedt-grader.json')) {
          this.mapping.invalidate();
          if (this.fileUri) void this.setActiveFile(this.fileUri);
        }
      }),
    );
  }

  /** Restores a stored API token (no network). Never logs in on its own. */
  async init(): Promise<void> {
    await this.dailyCleanup();
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
    l(this.state());
    return new vscode.Disposable(() => this.listeners.delete(l));
  }

  /** The sidebar was shown or hidden. */
  setPanelVisible(v: boolean): void {
    this.data.setVisible(v);
    if (v) void this.ensureLanguages();
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
        .showInformationMessage('Request logging is off. Turn on the setting "CEDT Grader: Debug Requests".', 'Open Setting')
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
    return `cedtGrader.problems:${this.cfg.baseUrl}:${this.cfg.username}`;
  }

  private secretKey(kind: 'password' | 'token', username = this.cfg.username): string {
    return `cedtGrader.${kind}:${this.cfg.baseUrl}:${username}`;
  }

  private async getPassword(): Promise<string | undefined> {
    if (!this.cfg.username) return undefined;
    return this.ctx.secrets.get(this.secretKey('password'));
  }

  private emit(): void {
    const s = this.state();
    for (const l of this.listeners) l(s);
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
    const wanted = languageForPath(this.fileUri.fsPath);
    const allowed = this.allowedLanguages(problem);
    if (!wanted || !allowed.length || matchLanguages(wanted, allowed).length) return null;
    return { wanted, allowed: allowed.map((l) => l.name) };
  }

  // ---------------------------------------------------------------- state

  private problemView(p: Problem): ProblemView {
    return {
      id: p.id,
      name: cleanName(p.name),
      fullName: cleanName(p.fullName),
      score: summarize(p),
      hasFile: this.mappedIds.has(p.id),
      hasTestcase: p.hasTestcase,
    };
  }

  state(): ViewState {
    const file = this.fileUri;
    const lang = file ? languageForPath(file.fsPath) : null;
    const loggedIn = this.accountStatus === 'logged-in';
    const problem = this.currentProblem();
    const languagesLoading = this.data.cache.peek('languages') === undefined && loggedIn && !!problem && this.data.isVisible();

    const mismatch = problem ? this.languageMismatch(problem) : null;
    let reason: string | null = null;
    if (this.busy) reason = null;
    else if (!file) reason = 'Open a source file to submit it.';
    else if (!loggedIn && !this.hasSavedPassword) reason = 'Log in first.';
    else if (!problem) reason = 'Choose the grader problem for this file.';
    else if (mismatch) reason = `This problem doesn't accept ${mismatch.wanted}.`;
    else if (this.languagesError) reason = this.languagesError;

    const enabled = !this.busy && !!file && !!problem && (loggedIn || this.hasSavedPassword) && !mismatch;
    const pState = this.data.state('problems');
    const list = this.data.problemList();

    return {
      baseUrl: this.cfg.baseUrl,
      account: {
        status: this.accountStatus,
        username: this.cfg.username,
        hasSavedPassword: this.hasSavedPassword,
        rememberPassword: this.rememberPassword,
        error: this.accountError,
      },
      file: file
        ? { path: vscode.workspace.asRelativePath(file, false), name: file.path.split('/').pop() ?? '', languageGuess: lang, supported: lang !== null }
        : null,
      problem: problem ? { ...this.problemView(problem), source: problem.source, sourceLabel: SOURCE_LABEL[problem.source] } : null,
      matching: {
        suggestions: this.matchInfo.suggestions.map((p) => this.problemView(p)),
        ambiguous: this.matchInfo.ambiguous?.map((p) => this.problemView(p)) ?? null,
        note: this.matchInfo.ambiguous
          ? `Several problems match this ${this.matchInfo.ambiguousSource === 'cph' ? "file's CPH data" : 'file name'}. Choose one.`
          : this.matchInfo.staleMappingId !== null
            ? `The saved problem #${this.matchInfo.staleMappingId} no longer exists; the mapping is ignored.`
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
      submit: { enabled, busy: this.busy, reason, label: 'Submit to Grader' },
      result: file ? (this.results.get(file.fsPath) ?? null) : null,
      gradingElsewhere:
        this.busy && this.gradingFile !== null && this.gradingFile !== file?.fsPath
          ? (this.results.get(this.gradingFile)?.problemName ?? 'another file')
          : null,
      history: problem ? this.historyView(problem) : { loading: false, stale: false, error: null, items: [], expanded: null },
      problems: {
        loading: pState.loading,
        loaded: list !== undefined,
        stale: pState.stale,
        items: this.problems.map((p) => this.problemView(p)),
        error: pState.error,
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

  private allowedLanguages(p: Pick<Problem, 'permittedLanguageIds'>): Language[] {
    return p.permittedLanguageIds === null ? this.languages : this.languages.filter((l) => p.permittedLanguageIds!.includes(l.id));
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
      this.selectedLanguageId = this.ctx.workspaceState.get<Record<string, number>>(LANGUAGE_KEY, {})[uri.fsPath] ?? null;
      this.languagesError = null;
      this.expandedSubmission = null;
    }

    // Matching order: saved → CPH .prob → exact file name → suggestions (never saved automatically).
    const entry = await this.mapping.get(uri, this.cfg.baseUrl);
    const list = this.data.problemList()?.problems;
    const cph = entry ? null : await readCphProblem(uri.fsPath, this.cphSaveLocation());
    const m = resolveProblem({ savedProblemId: entry?.problemId ?? null, cph, filePath: uri.fsPath, problems: list, baseUrl: this.cfg.baseUrl });
    const mapped = await this.mapping.mappedProblemIds(this.cfg.baseUrl);
    if (seq !== this.refreshSeq) return;
    this.mappedIds = mapped;
    let problem: (Problem & { source: MatchSource }) | null = null;
    this.matchInfo = { suggestions: [], ambiguous: null, ambiguousSource: null, staleMappingId: null };
    if (m.kind === 'match') {
      problem = { ...(m.problem.name.startsWith('#') && entry?.name ? placeholder(m.problem.id, entry.name) : m.problem), source: m.source };
    } else if (m.kind === 'ambiguous') {
      this.matchInfo.ambiguous = m.candidates;
      this.matchInfo.ambiguousSource = m.source;
    } else {
      this.matchInfo.suggestions = m.suggestions;
      this.matchInfo.staleMappingId = m.staleMappingId;
      // The closest candidate is pre-selected but marked "suggested" (submit asks first).
      if (m.suggestions.length) problem = { ...m.suggestions[0], source: 'suggested' };
    }
    this.problem = problem;
    this.applyLanguageChoice();
    this.emit();
    // A suggestion is only a guess: don't fetch its history until it is confirmed.
    this.data.focusProblem(problem && problem.source !== 'suggested' ? problem.id : null);
    if (!entry && !this.reconnectAsked.has(uri.fsPath)) void this.offerReconnect(uri);
  }

  // ------------------------------------------------------ moved files

  /** Stale mappings (older than 30 days) are removed, at most once a day. */
  private async dailyCleanup(): Promise<void> {
    const last = this.ctx.globalState.get<number>(CLEANUP_KEY, 0);
    if (Date.now() - last < 86_400_000) return;
    await this.ctx.globalState.update(CLEANUP_KEY, Date.now());
    const n = await this.mapping.expireStale();
    if (n) this.log(`Removed ${n} mapping(s) whose file has been missing for 30 days.`);
  }

  /** Update mappings (and per-file state) for files renamed or moved inside VS Code. */
  private async onFilesRenamed(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    const moved: { from: string; to: string }[] = [];
    for (const f of files) moved.push(...(await this.mapping.rename(f.oldUri, f.newUri)));
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
    const yes = 'Move Test Cases';
    const pick = await vscode.window.showInformationMessage(
      withCph.length === 1
        ? `Move CPH test cases to the new file too? (${vscode.workspace.asRelativePath(withCph[0].to)})`
        : `Move CPH test cases of ${withCph.length} renamed files too?`,
      yes,
      'No',
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
      `Moved CPH test cases for ${done} file${done === 1 ? '' : 's'} (old files kept as .bak)` +
        (skipped ? `; ${skipped} skipped because the new file already has CPH tests.` : '.') +
        ' CPH shows them when you switch to the file.',
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
      const keep = 'Keep';
      const pick = await vscode.window.showInformationMessage(`This looks like ${describeEntry(candidates[0])}. Keep the link?`, keep, 'Not this one');
      if (pick === keep) chosen = candidates[0];
      else if (pick) await this.dismissReconnect(candidates, uri);
    } else {
      const pick = await vscode.window.showQuickPick(
        [
          ...candidates.map((c) => ({ label: vscode.workspace.asRelativePath(c.fsPath), description: this.problemById(c.entry.problemId)?.name ?? c.entry.name, c })),
          { label: 'Skip', description: 'none of these', c: undefined },
        ],
        { placeHolder: `${uri.path.split('/').pop()} may be a moved file. Keep which link?` },
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
      const c = chooseLanguage(this.fileUri.fsPath, allowed);
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
      void vscode.window.showInformationMessage('Open a source file first, then choose its problem.');
      return;
    }
    const p = this.problems.find((x) => x.id === problemId);
    await this.mapping.set(this.fileUri, { problemId, name: p?.name ?? '', baseUrl: this.cfg.baseUrl });
    await this.setActiveFile(this.fileUri);
  }

  /** Clear the saved mapping of the active file (auto-detection applies again). */
  async unmapCurrentFile(): Promise<void> {
    if (!this.fileUri) return;
    await this.mapping.set(this.fileUri, undefined);
    this.problem = null;
    await this.setActiveFile(this.fileUri);
  }

  // ------------------------------------------------------------ linking

  /** Copy the clean problem name (zero-width characters removed): a file named like it is matched exactly. */
  async copyProblemName(problemId: number): Promise<void> {
    const p = this.problemById(problemId);
    if (!p) return;
    const name = cleanName(p.name);
    await vscode.env.clipboard.writeText(name);
    void vscode.window.setStatusBarMessage(`$(check) Copied "${name}"`, 2500);
  }

  /** Create `<clean name>.<ext>` next to the active file (or in the workspace root), open it and map it. */
  async newFileForProblem(problemId: number): Promise<void> {
    const p = this.problemById(problemId);
    if (!p) return;
    const folder =
      (this.fileUri ? vscode.Uri.joinPath(this.fileUri, '..') : undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) {
      void vscode.window.showInformationMessage('Open a folder first.');
      return;
    }
    await this.data.languages().catch(() => undefined);
    const ext = this.allowedLanguages(p)[0]?.ext || (this.fileUri ? /\.([^./]+)$/.exec(this.fileUri.path)?.[1] : undefined) || 'cpp';
    const target = vscode.Uri.joinPath(folder, fileNameFor(p.name, ext));
    const created = await createFileNoOverwrite(target.fsPath, async () => {
      const open = 'Open Existing';
      const overwrite = 'Overwrite';
      const pick = await vscode.window.showWarningMessage(`${vscode.workspace.asRelativePath(target)} already exists.`, { modal: true }, open, overwrite);
      return pick === overwrite ? 'overwrite' : pick === open ? 'open' : 'cancel';
    });
    if (created === 'cancel') return;
    await this.mapping.set(target, { problemId: p.id, name: p.name, baseUrl: this.cfg.baseUrl });
    await vscode.window.showTextDocument(target);
  }

  /** Open the file(s) mapped to a problem (saved mappings only; one stat per file). */
  async goToFile(problemId: number): Promise<void> {
    const files = await this.mapping.filesFor(problemId, this.cfg.baseUrl);
    const existing: vscode.Uri[] = [];
    const gone: vscode.Uri[] = [];
    for (const f of files) ((await exists(f.fsPath)) ? existing : gone).push(f);
    if (gone.length) {
      const remove = 'Remove Mapping';
      const pick = await vscode.window.showWarningMessage(
        `${gone.length === 1 ? vscode.workspace.asRelativePath(gone[0]) + ' no longer exists' : `${gone.length} mapped files no longer exist`}.`,
        remove,
      );
      if (pick === remove) for (const g of gone) await this.mapping.set(g, undefined);
      this.mappedIds = await this.mapping.mappedProblemIds(this.cfg.baseUrl);
      this.emit();
    }
    if (!existing.length) return;
    const target =
      existing.length === 1
        ? existing[0]
        : (await vscode.window.showQuickPick(existing.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })), { placeHolder: 'Files for this problem' }))?.uri;
    if (target) await vscode.window.showTextDocument(target);
  }

  /** One workspace.findFiles for the clean name, only when asked (max 20 results). */
  async findFileByName(problemId: number): Promise<void> {
    const p = this.problemById(problemId);
    if (!p) return;
    const name = cleanName(p.name).replace(/[{}[\]*?,]/g, '?');
    const found = await vscode.workspace.findFiles(`**/${name}.*`, '**/{node_modules,.git,.cph,build,dist,out,target,.vscode-test}/**', 20);
    if (!found.length) {
      void vscode.window.showInformationMessage(`No file named "${cleanName(p.name)}.*" in the workspace.`);
      return;
    }
    const target =
      found.length === 1
        ? found[0]
        : (await vscode.window.showQuickPick(found.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })), { placeHolder: `Files named ${cleanName(p.name)}` }))?.uri;
    if (target) await vscode.window.showTextDocument(target); // the file name matches exactly → auto-linked
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
      void vscode.window.showInformationMessage(`${problem.name} has no test cases you can download.`);
      return;
    }
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
        void vscode.window.showInformationMessage(`The grader does not let you download the test cases of ${problem.name}.`);
        return;
      }
      const { set } = res;
      const total = set.cases.length + set.truncated.length;
      const tooLarge = set.truncated.length
        ? `; ${set.truncated.length} ${set.truncated.length === 1 ? 'was' : 'were'} too large to download`
        : '';
      const refetch = 'Download Again';

      const target = chooseTestcaseTarget(this.cph.installed, this.ctx.workspaceState.get<'files'>(TESTCASE_TARGET_KEY));
      if (target !== 'cph') {
        if (target === 'ask') {
          const files = 'Save as Files';
          const install = 'Install CPH';
          const pick = await vscode.window.showInformationMessage(
            `Downloaded ${set.cases.length} test case${set.cases.length === 1 ? '' : 's'}. Where should they go?`,
            { detail: 'Save them as .in / .out files next to your source, or install CPH to run them inside VS Code.' },
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
          const create = 'Create Folder';
          const ok = await vscode.window.showInformationMessage(
            `Create ${vscode.workspace.asRelativePath(folder)}/ for ${set.cases.length} test case${set.cases.length === 1 ? '' : 's'}?`,
            { modal: true },
            create,
          );
          if (ok !== create) return;
        }
        const r = await saveTestcasesAsFiles(folder, set.cases);
        const extra = [r.unchanged ? `${r.unchanged} unchanged` : '', r.keptExisting ? `${r.keptExisting} existing files kept (not overwritten)` : '']
          .filter(Boolean)
          .join(', ');
        const open = 'Show Folder';
        const install = 'Install CPH';
        const pick = await vscode.window.showInformationMessage(
          `Saved ${r.written} of ${total} test case${total === 1 ? '' : 's'} to ${vscode.workspace.asRelativePath(folder)}/${tooLarge}${extra ? ` (${extra})` : ''}. Install CPH to run these tests in VS Code.`,
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
        problemUrl: this.url(`/submissions/direct_edit_problem/${problem.id}`),
        cases: set.cases,
      });
      const parts = [`Saved to CPH: loaded ${set.cases.length} of ${total} test case${total === 1 ? '' : 's'}${tooLarge}`];
      if (result.alreadyPresent) parts.push(`${result.alreadyPresent} already present`);
      if (result.updated) parts.push(`${result.updated} updated`);
      if (result.added) parts.push(`${result.added} added`);
      const reload = 'Reload in CPH';
      const pick = await vscode.window.showInformationMessage(
        `${parts.join('; ')}.${result.backupPath ? ' Previous CPH file backed up (.bak).' : ''} CPH reloads tests when you switch to the file; don't run tests in CPH before that.`,
        reload,
        ...(res.fromCache ? [refetch] : []),
      );
      if (pick === reload) await this.reloadCph(file);
      if (pick === refetch) await this.loadTestcases(true);
    } catch (err) {
      if (classifyConnectionError(err)) this.reportError(err, () => this.loadTestcases(refresh));
      else void vscode.window.showErrorMessage(`Could not load test cases: ${this.describe(err)}`);
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
      void vscode.window.showInformationMessage('Open a source file first.');
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
          detail: `#${p.id}${s.counted !== null ? ` · counted ${s.counted}` : ''}`,
          id: p.id,
        };
      }),
      { placeHolder: `Grader problem for ${this.fileUri.path.split('/').pop()}`, matchOnDescription: true, matchOnDetail: true },
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
    if (d && d.source === null) void vscode.window.showInformationMessage('The grader does not return the source of this submission.');
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
      void vscode.window.showInformationMessage('A submission is already being graded.');
      return;
    }
    const fileUri = this.fileUri;
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === fileUri?.toString());
    const doc = editor?.document ?? (fileUri ? await vscode.workspace.openTextDocument(fileUri) : undefined);
    if (!doc || !fileUri) {
      void vscode.window.showInformationMessage('Open a source file to submit it.');
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

    this.busy = true;
    this.gradingFile = key;
    this.emit();
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
        const open = 'Open in Browser';
        const anyway = 'Submit Anyway';
        const pick = await vscode.window.showWarningMessage(EXAM_WARNING, { modal: true }, open, anyway);
        if (pick === open) await this.openProblemInBrowser(problem.id);
        if (pick !== anyway) return;
        warned = true;
      }

      let languageId = this.selectedLanguageId;
      if (languageId === null || !allowed.some((l) => l.id === languageId)) {
        const c = chooseLanguage(fileUri.fsPath, allowed);
        if (c.kind === 'match') languageId = c.language.id;
        else if (c.kind === 'not-allowed') throw new LanguageNotAllowedError(`${c.wanted} is not allowed for this problem.`);
        else {
          const options = c.kind === 'ambiguous' ? c.candidates : c.allowed;
          const pick = await vscode.window.showQuickPick(options.map((l) => ({ label: l.name, id: l.id })), {
            placeHolder: 'Language for this submission',
          });
          if (!pick) return;
          languageId = pick.id;
        }
        await this.selectLanguage(languageId);
      }
      const language = allowed.find((l) => l.id === languageId);

      // A suggested (unconfirmed) match always asks, even with confirmations off.
      if (problem.source === 'suggested') {
        const use = 'Use This Problem and Submit';
        const pick = await vscode.window.showWarningMessage(
          `${problem.name} (#${problem.id}) was only suggested from the file name.`,
          { modal: true, detail: `Submit ${fileName} to ${problem.name} (#${problem.id})? The file will be linked to this problem.` },
          use,
        );
        if (pick !== use) return;
        await this.mapping.set(fileUri, { problemId: problem.id, name: problem.name, baseUrl: this.cfg.baseUrl });
        if (this.problem) this.problem = { ...this.problem, source: 'saved' };
        warned = true;
      }

      if (this.cfg.confirmBeforeSubmit && !warned) {
        const ok = 'Submit';
        const pick = await vscode.window.showInformationMessage(
          `Submit ${fileName} to ${problem.name} (#${problem.id})${language ? ` as ${language.name}` : ''}?`,
          { modal: true, detail: 'Turn this off with the setting "CEDT Grader: Confirm Before Submit".' },
          ok,
        );
        if (pick !== ok) return;
      }

      this.setResult(key, newResult(problem, 'submitting', 'Submitting…'));
      const sub = await this.client.submit(problem.id, languageId!, doc.getText(), fileName);
      sentId = sub.id;
      this.connectionOk();
      this.updateResult(key, {
        phase: 'grading',
        submissionId: sub.id,
        number: sub.number,
        submissionUrl: this.url(`/submissions/${sub.id}`),
        message: 'Waiting to be graded…',
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
      if (!connectionMsg) void this.showError(err, msg);
    } finally {
      this.busy = false;
      this.gradingFile = null;
      this.pollAbort = null;
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
    this.updateResult(p.key, { phase: 'grading', message: 'Connection back. Loading the result…' });
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
            this.updateResult(key, { phase: 'timeout', message: 'Stopped waiting. Use "Show Last Result" to check again.' });
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
    if (d.state !== 'graded') this.updateResult(key, { phase: 'timeout', message: 'Still being graded. Check again in a moment.' });
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
      void vscode.window.showInformationMessage('Choose a problem first.');
      return;
    }
    // A cached statement opens even when logged out (no request); otherwise the viewer explains.
    const p = this.problemById(id);
    await this.statements.open(id, p?.name ?? `#${id}`);
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
    await vscode.env.openExternal(vscode.Uri.parse(this.url(`/submissions/direct_edit_problem/${id}`)));
  }

  async openSubmission(id: number): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(this.url(`/submissions/${id}`)));
  }

  // ----------------------------------------------------------------- errors

  describe(err: unknown): string {
    if (err instanceof NetworkError) return `${err.message} Check your internet connection.`;
    if (err instanceof GraderError) return err.message;
    if (err instanceof Error) return `Unexpected error: ${err.message}`;
    return String(err);
  }

  /** Toast only when the sidebar is hidden (otherwise the panel already shows the message). */
  private async showError(err: unknown, msg: string): Promise<void> {
    this.log(`Error: ${msg}`);
    if (this.data.isVisible()) return;
    const actions: string[] = err instanceof NetworkError ? ['Show Log'] : [];
    const pick = await vscode.window.showErrorMessage(msg, ...actions);
    if (pick === 'Show Log') this.output.show();
  }
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

