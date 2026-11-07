import * as vscode from 'vscode';
import { readConfig, type GraderConfig } from './config';
import type { CrashReporter } from './crashReporter';
import { DataService } from './data/dataService';
import { StatementStore } from './data/statementStore';
import { StatementPanels } from './ui/statementPanel';
import {
  AuthError,
  chooseLanguage,
  classifyConnectionError,
  type ConnectionProblem,
  type Credentials,
  checkGraderServer,
  createGrader,
  type GraderProvider,
  GraderError,
  type Language,
  languageForPath,
  languageNameForPath,
  NetworkError,
  ProblemUnavailableError,
  type Problem,
  type ProblemList,
  resultWord,
  type StoredToken,
  type SubmissionDetail,
  summarize,
  problemStatus,
} from './grader';
import { dirname } from 'node:path';
import { CPH_AUTO_SHOW_KEY, CPH_AUTO_SHOW_SECTION, CPH_EXTENSION_ID, cphAutoShowScope, CphPresence } from './cphIntegration';
import { TestcaseStore } from './data/testcaseStore';
import { CaseStore } from './runner/store';
import { pdfjsLoader } from './data/pdfSamples';
import { cphProbPath as cphProbPathFor, readCphProblem } from './mapping/cph';
import { pathExists as exists } from './mapping/newFile';
import { BINARY_EXTS } from './mapping/findByName';
import { EXTENSION_LANGUAGE } from './grader/languages';
import { stat as fsStat } from 'node:fs/promises';
import { cphFilesAfterFolderRename, moveCphProblem, remapPath } from './mapping/mappingOps';
import { cleanName, placeholder, resolveProblem } from './mapping/match';
import { MappingStore } from './mapping/store';
import { pathKey } from './mapping/paths';
import { matchNote, type MatchInfo, NO_MATCH_INFO } from './mapping/linkActions';
import { nameMatchesProblem, renameProposal } from './mapping/renameToProblem';
import { DEFAULT_BASE_URL, LIMITS, SUBMISSION_SCHEME, TIMING, troubleshootingUrl, WEB_PATHS } from './shared/constants';
import { MATCH_SOURCE, S, W } from './shared/strings';
import { KEYS } from './shared/stateKeys';
import { SecretLedger, type SecretKind, secretKey } from './shared/secrets';
import { cleanTagFilter, cleanTopicFilter, otherTags } from './shared/tags';
import { currentLang, resolveLang, setLanguage } from './shared/i18n';
import type { HistoryEntry, ProblemFilter, ProblemView, SubmissionDetailView, ViewState } from './shared/messages';
import { Attachments } from './flows/attachments';
import { CacheCare } from './flows/cache';
import { FolderMode } from './flows/folderMode';
import type { CurrentProblem, Host } from './flows/host';
import { revealPanelOnStart } from './flows/panelReveal';
import { Links } from './flows/links';
import { type AskOptions, type InlinePrompt, InlinePrompts } from './flows/prompts';
import { countedSubmissionId } from './flows/results';
import { ServerFlow } from './flows/server';
import { SubmitFlow } from './flows/submit';
import { TestCases } from './flows/testcases';

export { SUBMISSION_SCHEME };

type Listener = (s: ViewState) => void;

/**
 * Single owner of the grader session and all UI state. All grader data goes
 * through `DataService` (the shared cache layer). The flows in src/flows/
 * (folder mode, attachments, test cases, submit, links, cache, inline
 * questions) do the work behind the panel's actions; they reach the session
 * through one `Host` object.
 */
export class GraderController implements vscode.Disposable {
  private cfg: GraderConfig = readConfig();
  private client: GraderProvider;
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
  private panelVisible = false;
  /** `init` has read the saved session. */
  isStarted = false;
  private markStarted!: () => void;
  /** Resolves when `init` has read the saved session, also after a failure. */
  readonly started = new Promise<void>((done) => (this.markStarted = done));

  private fileUri: vscode.Uri | null = null;
  private problem: CurrentProblem | null = null;
  private languagesError: string | null = null;
  private selectedLanguageId: number | null = null;
  private expandedSubmission: number | null = null;
  private refreshSeq = 0;
  /** A login is writing the username / address itself: the settings event must not reset the session too. */
  private changingAccount = false;
  /** Raised by each typed login and account change: a login still waiting on its check gives up. */
  private loginAttempt = 0;
  private readonly server: ServerFlow;
  /** Matching details for the active file (picker suggestions, ambiguous candidates). */
  private matchInfo: MatchInfo = NO_MATCH_INFO;
  /** Problems the grader no longer offers (missing from the list, or 404/403 this session). */
  private readonly unavailableIds = new Set<number>();
  /** The active file was explicitly unlinked (auto-detection is off for it). */
  private notLinked = false;
  private fileEventTimer: ReturnType<typeof setTimeout> | undefined;
  /** CPH tip: "Not now" hides it for this session. */
  private cphTipHidden = false;
  /** The "CPH opens its panel on every switch" question was answered this session (or is showing). */
  private cphAutoShowAsked = false;
  /** The problem the statement tab last followed (undefined: not yet). */
  private followedProblemId: number | null | undefined = undefined;
  /** Statement PDFs / descriptions on disk (shared by the statement tabs and "Load sample cases"). */
  private readonly statementStore: StatementStore;
  private readonly cases: CaseStore;
  /** CPH is optional: only used when installed (re-checked when extensions change). */
  readonly cph: CphPresence;
  /** Connection banner (null = all good) and what its Retry button re-runs. */
  private connection: ConnectionProblem | null = null;
  private retryAction: (() => Promise<unknown>) | null = null;
  readonly statements: StatementPanels;

  /** What the flows see of the controller (see src/flows/host.ts). */
  private readonly host: Host;
  private readonly prompts: InlinePrompts;
  private readonly folder: FolderMode;
  private readonly links: Links;
  private readonly tests: TestCases;
  private readonly submitFlow: SubmitFlow;
  private readonly attachments: Attachments;
  private readonly cache: CacheCare;
  /** Password / token writes and deletes (every key written is listed, so Log Out removes them all). */
  private readonly secrets: SecretLedger;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    readonly crash: CrashReporter,
  ) {
    this.secrets = new SecretLedger(ctx.secrets, ctx.globalState);
    this.output = crash.output;
    crash.onChange = () => this.emit();
    crash.panelReady = () => this.isStarted && this.panelVisible;
    this.mapping = new MappingStore(ctx);
    this.client = this.makeClient();
    crash.privateInfo = () => ({ username: this.cfg.username, baseUrl: this.cfg.baseUrl, fullName: this.client.user?.fullName });
    this.data = new DataService({
      client: () => this.client,
      canFetch: () => this.client.isLoggedIn || this.hasSavedPassword,
      log: (l) => this.requestLog(l),
      describe: (e) => this.describe(e),
      // Problem list survives restarts (shown at once, refetched once per session).
      persist: {
        load: () => ctx.workspaceState.get<{ at: number; list: ProblemList }>(this.problemsKey()),
        save: (at, list) => void ctx.workspaceState.update(this.problemsKey(), { at, list }),
      },
    });
    this.cph = new CphPresence(vscode.extensions, () => this.emit());
    this.host = this.makeHost();
    this.server = new ServerFlow({
      verified: () => this.ctx.globalState.get<string[]>(KEYS.verifiedServers, []),
      saveVerified: async (list) => void (await this.ctx.globalState.update(KEYS.verifiedServers, list)),
      check: (url) => checkGraderServer(url, { log: (line) => this.requestLog(line) }),
      confirmInsecure: async (url) => {
        const send = S.account.insecureSend;
        return (await vscode.window.showWarningMessage(S.account.insecureTitle(new URL(url).host), { modal: true, detail: S.account.insecureDetail }, send)) === send;
      },
      changed: () => this.emit(),
    });
    this.prompts = new InlinePrompts(
      () => this.emit(),
      () => void vscode.commands.executeCommand('cedtGrader.panel.focus'),
      () => this.data.isVisible(),
    );
    this.folder = new FolderMode(this.host);
    this.links = new Links(this.host);
    this.submitFlow = new SubmitFlow(this.host);
    this.attachments = new Attachments(this.host);
    this.cache = new CacheCare(this.host, () => this.logout(), (resetData) => this.afterClear(resetData));
    this.statementStore = new StatementStore(ctx.globalStorageUri.fsPath, () => this.client, (l) => this.requestLog(l), (p) => {
      this.cache.written(p);
      void this.tests.refreshStatementKind();
    });
    this.cases = new CaseStore(ctx.globalStorageUri.fsPath, () => this.client.baseUrl, (l) => this.log(l));
    this.tests = new TestCases(
      this.host,
      new TestcaseStore(ctx.globalStorageUri.fsPath, () => this.client, (l) => this.requestLog(l), (p) => this.cache.written(p)),
      pdfjsLoader(vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'pdfjs').fsPath, vscode.Uri.joinPath(ctx.extensionUri, 'media', 'dist', 'pdfjs').fsPath),
    );
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
      this.statementStore,
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
      this.links.invalidateIndex(); // the index depends on the problem list
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
          await this.links.refreshMappedIds();
          this.emit();
        });
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.fileName.endsWith('.cedt-grader.json')) {
          this.mapping.invalidate();
          void this.links.cleanupDuplicates();
          if (this.fileUri) void this.setActiveFile(this.fileUri);
        }
      }),
    );
  }

  /** The `Host` the flows use: live getters over the controller's state, and its shared helpers. */
  private makeHost(): Host {
    const c = this;
    return {
      ctx: c.ctx,
      get cfg() { return c.cfg; },
      get client() { return c.client; },
      data: c.data,
      mapping: c.mapping,
      cph: c.cph,
      get statementStore() { return c.statementStore; },
      get cases() { return c.cases; },
      get prompts() { return c.prompts; },
      get folder() { return c.folder; },
      get links() { return c.links; },
      get tests() { return c.tests; },
      get submitFlow() { return c.submitFlow; },
      get attachments() { return c.attachments; },
      get fileUri() { return c.fileUri; },
      get problem() { return c.problem; },
      currentProblem: () => c.currentProblem(),
      problemById: (id) => c.problemById(id),
      get problems() { return c.problems; },
      get languages() { return c.languages; },
      allowedLanguages: (p) => c.allowedLanguages(p),
      allSourceExts: () => c.allSourceExts(),
      get selectedLanguageId() { return c.selectedLanguageId; },
      selectLanguage: (id) => c.selectLanguage(id),
      markChosen: (id) => {
        if (c.problem?.id === id) c.problem = { ...c.problem, source: 'saved' };
      },
      forgetProblem: () => {
        c.problem = null;
      },
      setActiveFile: (uri) => c.setActiveFile(uri),
      emit: () => c.emit(),
      log: (msg) => c.log(msg),
      requestLog: (line) => c.requestLog(line),
      describe: (err) => c.describe(err),
      askInline: (text, buttons, opts) => c.askInline(text, buttons, opts),
      tellInline: (err, msg) => c.tellInline(err, msg),
      showError: (err, msg) => c.showError(err, msg),
      ensureLoggedIn: () => c.ensureLoggedIn(),
      reportError: (err, retry) => c.reportError(err, retry),
      connectionOk: () => c.connectionOk(),
      markUnavailable: (id) => c.markUnavailable(id),
      isUnavailable: (id) => c.unavailableIds.has(id),
      url: (path) => c.url(path),
      cphSaveLocation: () => c.cphSaveLocation(),
      recordBackup: (path) => c.cache.recordBackup(path),
      onFileEvent: () => c.onFileEvent(),
      focusProblemPicker: () => c.focusProblemPicker(),
      openStatement: (id) => c.openStatement(id),
      refreshProblems: (force) => c.refreshProblems(force),
      openProblemInBrowser: (id) => c.openProblemInBrowser(id),
      chooseProblemQuickPick: (apply) => c.chooseProblemQuickPick(apply),
      focus: (t) => c.focusTarget?.(t),
    };
  }

  /** Restores a stored API token (no network). Never logs in on its own. */
  /**
   * Read the saved login, links and active file. Runs after activation, while the panel's webview
   * loads: commands and panel messages wait for `started`, so they never see a half-read session.
   */
  async init(): Promise<void> {
    try {
      await this.links.cleanupDuplicates();
      this.warnBadPattern();
      this.hasSavedPassword = !!(await this.getPassword());
      if (await this.client.restore()) {
        this.accountStatus = 'logged-in';
        void this.data.loadProblems(); // deferred until the panel is visible
      }
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document.uri.scheme === 'file') await this.setActiveFile(ed.document.uri);
    } catch (err) {
      // Bad saved data must not stop the extension; the panel still works.
      this.logError('Init failed', err);
    }
    this.isStarted = true;
    this.markStarted();
    if (this.panelVisible) this.setPanelVisible(true);
    this.emit();
    revealPanelOnStart(this.cfg.panelOpenOnStartup, this.panelVisible, (c, o) => vscode.commands.executeCommand(c, o)).then(undefined, (err) => this.logError('Reveal failed', err));
    // Housekeeping, after the panel has what it needs.
    try {
      // Problem list saved by versions before v2 (no tags): no longer read, remove it.
      await this.ctx.workspaceState.update(`${KEYS.problemsPrefix}:${this.cfg.baseUrl}:${this.cfg.username}`, undefined);
      await this.cache.dailyCleanup();
    } catch (err) {
      this.logError('Cleanup failed', err);
    }
  }

  dispose(): void {
    this.submitFlow.stop();
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
      this.crash.report(err, 'panel state', { notify: true });
      return null;
    }
  }

  /** The sidebar was shown or hidden. */
  setPanelVisible(v: boolean): void {
    this.panelVisible = v;
    if (!this.isStarted) return; // `init` applies it: loading needs the saved login first
    this.data.setVisible(v);
    if (v) {
      void this.ensureLanguages();
      void this.ensureMe();
      void this.links.refreshLinkedFiles(); // the name search runs only while the panel shows the problem
      void this.maybeAskCphAutoShow();
    }
  }

  // ------------------------------------------------------------ plumbing

  private makeClient(): GraderProvider {
    // Fixed here: a client still finishing after a switch must not read the next account's secrets.
    const { baseUrl, username } = this.cfg;
    const key = (kind: SecretKind) => secretKey(kind, baseUrl, username);
    return createGrader({
      baseUrl,
      getStoredCredentials: async (): Promise<Credentials | undefined> => {
        const password = username ? await this.ctx.secrets.get(key('password')) : undefined;
        return username && password ? { username, password } : undefined;
      },
      tokenStore: {
        load: async () => {
          const raw = await this.ctx.secrets.get(key('token'));
          try {
            return raw ? (JSON.parse(raw) as StoredToken) : undefined;
          } catch {
            return undefined;
          }
        },
        save: async (t) => {
          // The token is persisted only when the user chose to remember the password.
          if (t && this.rememberPassword) await this.secrets.store(key('token'), JSON.stringify(t));
          else await this.secrets.delete(key('token'));
        },
      },
      log: (line) => this.requestLog(line),
    });
  }

  /** `cedtGrader.debugRequests`: method, path, status and cache hit/miss only. Never tokens. */
  private requestLog(line: string): void {
    if (!this.cfg.debugRequests) return;
    if (!this.debugChannel) this.debugChannel = vscode.window.createOutputChannel('Grader Submit: Requests');
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
    if (!this.debugChannel) this.debugChannel = vscode.window.createOutputChannel('Grader Submit: Requests');
    this.debugChannel.show(true);
  }

  private get rememberPassword(): boolean {
    return this.ctx.globalState.get<boolean>(KEYS.rememberPassword, true);
  }

  private onConfigChanged(): void {
    const prev = this.cfg;
    this.cfg = readConfig();
    if (prev.displayLanguage !== this.cfg.displayLanguage) this.applyLanguage();
    if (prev.fileNamePattern.pattern !== this.cfg.fileNamePattern.pattern || prev.fileNamePattern.problem !== this.cfg.fileNamePattern.problem) {
      // The matcher uses the pattern: rebuild the index and re-match the open file.
      this.links.invalidateIndex();
      this.warnBadPattern();
      if (this.fileUri) void this.setActiveFile(this.fileUri);
    }
    if (this.changingAccount) {
      this.emit();
      return;
    }
    if (prev.baseUrl !== this.cfg.baseUrl || prev.username !== this.cfg.username) {
      void this.client.logout();
      // Another user or grader: the previous one's saved password and token don't stay behind.
      void this.secrets.forgetAccount(prev.baseUrl, prev.username);
      this.client = this.makeClient();
      this.resetSessionState();
      this.server.reset();
      void this.getPassword().then((p) => {
        this.hasSavedPassword = !!p;
        if (this.fileUri) void this.setActiveFile(this.fileUri);
      });
    }
    this.emit();
  }

  private resetSessionState(): void {
    this.accountStatus = 'logged-out';
    // Nothing started for the previous account carries over: a Retry or poll would reach the new server.
    this.loginAttempt++;
    this.connection = null;
    this.retryAction = null;
    this.submitFlow.stop();
    this.submitFlow.pendingPoll = null;
    this.submitFlow.results.clear();
    this.expandedSubmission = null;
    this.data.clear();
  }

  private problemsKey(): string {
    // v2: problems carry `tags`; older saved lists are still read safely (normalized), but new ones go here.
    return `${KEYS.problemsPrefix}.v2:${this.cfg.baseUrl}:${this.cfg.username}`;
  }

  private secretKey(kind: SecretKind, username = this.cfg.username): string {
    return secretKey(kind, this.cfg.baseUrl, username);
  }

  private async getPassword(): Promise<string | undefined> {
    if (!this.cfg.username) return undefined;
    return this.ctx.secrets.get(this.secretKey('password'));
  }

  /** An invalid `cedtGrader.fileNamePattern` falls back to `{name}.{ext}`; say why (on start and when the setting changes). */
  private warnBadPattern(): void {
    const why = this.cfg.fileNamePattern.problem;
    if (!why) return;
    const open = S.common.openSetting;
    void vscode.window.showWarningMessage(S.files.badPattern(S.files.patternProblem[why]), open).then((p) => {
      if (p === open) void vscode.commands.executeCommand('workbench.action.openSettings', 'cedtGrader.fileNamePattern');
    });
  }

  /** Rebuilds the sidebar in the new language (set by the sidebar provider). */
  onLanguageChanged: (() => void) | null = null;

  /**
   * Switch the display language live: text tables, open statement tabs,
   * the sidebar (reloaded; scroll and filters are kept) and the status bar.
   */
  private applyLanguage(): void {
    setLanguage(resolveLang(this.cfg.displayLanguage, vscode.env.language));
    this.statements.reloadAll();
    this.onLanguageChanged?.();
  }

  private emit(): void {
    const s = this.safeState();
    if (!s) return;
    for (const l of this.listeners) l(s);
  }

  /** Errors outside a request (e.g. activation) go to the extension's output channel, not the console. */
  logError(context: string, err: unknown): void {
    this.log(`${context}: ${err instanceof Error ? err.message : String(err)}`);
    this.crash.caught(err, context);
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
  private currentProblem(): CurrentProblem | null {
    if (!this.problem) return null;
    const fresh = this.problems.find((p) => p.id === this.problem!.id);
    return fresh ? { ...fresh, source: this.problem.source } : this.problem;
  }

  private cphSaveLocation(): string {
    return vscode.workspace.getConfiguration('cph').get<string>('general.saveLocation') ?? '';
  }

  /** Every known source extension: the server's languages (non-binary) + the fallback table. */
  private allSourceExts(): string[] {
    const exts = new Set<string>(Object.keys(EXTENSION_LANGUAGE).map((e) => e.slice(1)));
    for (const l of this.languages) if (l.ext && !BINARY_EXTS.has(l.ext.toLowerCase())) exts.add(l.ext.toLowerCase().replace(/^\./, ''));
    return [...exts];
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
        void this.secrets.delete(this.secretKey('password'));
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
    if (this.submitFlow.pendingPoll && !this.submitFlow.busy) void this.submitFlow.resumePoll();
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
    if (this.submitFlow.pendingPoll) await this.submitFlow.resumePoll();
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
    const target = this.folder.targetUri();
    if (!target || !this.languages.length) return null;
    const allowed = this.allowedLanguages(problem);
    if (!allowed.length) return null;
    const c = chooseLanguage(target.fsPath, allowed, this.languages);
    if (c.kind !== 'not-allowed') return null;
    return { wanted: c.wanted, allowed: allowed.map((l) => l.name) };
  }

  // ---------------------------------------------------------------- state

  private problemView(p: Problem): ProblemView {
    return {
      id: p.id,
      name: cleanName(p.name),
      fullName: cleanName(p.fullName),
      score: summarize(p),
      hasFile: this.links.mappedIds.has(p.id),
      hasTestcase: p.hasTestcase,
      hasAttachment: p.hasAttachment,
      status: problemStatus(p),
      tags: p.tags ?? [],
      lastSubmissionTime: p.lastSubmissionTime,
      lastOpened: this.ctx.workspaceState.get<Record<string, number>>(KEYS.recentlyOpened, {})[p.id] ?? null,
    };
  }

  state(): ViewState {
    const file = this.fileUri;
    const target = this.folder.targetUri();
    const lang = target ? languageNameForPath(target.fsPath, this.languages) : null;
    const loggedIn = this.accountStatus === 'logged-in';
    const problem = this.currentProblem();
    const languagesLoading = this.data.cache.peek('languages') === undefined && loggedIn && !!problem && this.data.isVisible();
    const { busy, gradingFile, results } = this.submitFlow;
    const folderLink = this.folder.link;

    const unavailable = !!problem && this.unavailableIds.has(problem.id);
    const mismatch = problem && !unavailable ? this.languageMismatch(problem) : null;
    let reason: string | null = null;
    if (busy) reason = null;
    else if (!file) reason = S.submit.openToSubmit;
    else if (!loggedIn && !this.hasSavedPassword) reason = S.submit.logInFirst;
    else if (!problem) reason = S.submit.chooseProblemForFile;
    else if (unavailable) reason = S.submit.unavailable;
    else if (mismatch) reason = S.submit.notAccepted(mismatch.wanted);
    else if (this.languagesError) reason = this.languagesError;

    const enabled = !busy && !!file && !!problem && (loggedIn || this.hasSavedPassword) && !mismatch && !unavailable;
    const pState = this.data.state('problems');
    const list = this.data.problemList();

    return {
      baseUrl: this.cfg.baseUrl,
      layout: { sections: this.cfg.panelSections, compact: this.cfg.panelCompact },
      account: {
        status: this.accountStatus,
        username: this.cfg.username,
        fullName: this.client.user?.fullName || null,
        hasSavedPassword: this.hasSavedPassword,
        rememberPassword: this.rememberPassword,
        error: this.accountError,
        server: this.server.view(),
      },
      file: file
        ? {
            path: vscode.workspace.asRelativePath(file, false),
            name: file.path.split('/').pop() ?? '',
            languageGuess: lang,
            supported: lang !== null,
            // Folder mode / matched by the folder's name: the folder carries the name, not the file.
            renameTo: problem && !folderLink && problem.source !== 'folder' && !problem.name.startsWith('#') && !nameMatchesProblem(file.fsPath, problem.name, this.cfg.fileNamePattern.pattern, problem.id) ? renameProposal(file.fsPath, problem.name, this.cfg.fileNamePattern.pattern, problem.id) : null,
          }
        : null,
      problem: problem ? { ...this.problemView(problem), source: problem.source, sourceLabel: MATCH_SOURCE[problem.source], unavailable } : null,
      // Explicitly unlinked, or no confident match (candidates are only offered in the picker).
      notLinked: !problem && !!file && (this.notLinked || (!!this.data.problemList()?.problems.length && !this.matchInfo.ambiguous)),
      prompt: this.prompts.current,
      crash: this.crash.view,
      ...this.links.noticeView(problem, file),
      folder: this.folder.view(),
      runTests: this.cph.installed && problem && file ? { disabledReason: this.tests.runTestCount ? null : S.runTests.noTestsShort } : null,
      folderMode: file ? { on: !!folderLink && !this.folder.matched, disabledReason: folderLink ? null : this.folder.modeTarget().reason } : null,
      attachment: { busy: problem && this.data.isDownloading(problem.id) ? problem.id : null },
      cphTip:
        !this.cph.installed && !this.cphTipHidden && !this.ctx.globalState.get<boolean>(KEYS.cphTipDismissed, false) && !!problem?.hasTestcase,
      matching: {
        suggestions: this.matchInfo.suggestions.map((p) => this.problemView(p)),
        ambiguous: this.matchInfo.ambiguous?.map((p) => this.problemView(p)) ?? null,
        note: matchNote(this.matchInfo),
      },
      testcases: { busy: this.tests.busy },
      samples: { busy: this.tests.samplesBusy, available: !this.tests.statementNoPdf },
      cph: { installed: this.cph.installed },
      languages: {
        loading: languagesLoading,
        items: problem ? this.allowedLanguages(problem).map((l) => ({ id: l.id, name: l.name })) : [],
        selectedId: this.selectedLanguageId,
        mismatch,
      },
      connection: this.connection,
      submit: { enabled, busy, reason, label: S.submitLabel },
      result: results.get(target?.fsPath) ?? null,
      gradingElsewhere: busy && gradingFile !== null && gradingFile !== target?.fsPath ? (results.get(gradingFile)?.problemName ?? S.submit.anotherFile) : null,
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
        tags: otherTags(list?.problems ?? [], this.topics(list), this.problemFilter().tags ?? []),
        topicClickOrder: this.cfg.topicClickOrder,
        penaltyNote:
          !list || list.listStatus === 'loaded'
            ? null
            : list.listStatus === 'no-web-session'
              ? S.penaltyNote.noWebSession
              : S.penaltyNote.unreadable,
      },
    };
  }

  private historyView(problem: Problem): ViewState['history'] {
    const st = this.data.historyState(problem.id);
    const items = this.data.history(problem.id) ?? [];
    const pretty = new Map(this.languages.map((l) => [l.code, l.name]));
    const countedId = countedSubmissionId(items);
    const entries: HistoryEntry[] = items.map((h) => ({
      submissionId: h.id,
      number: h.number,
      points: h.points,
      status: h.status,
      comment: h.comment,
      submittedAt: h.submittedAt,
      language: h.language ? (pretty.get(h.language) ?? h.language) : null,
      compileError: h.status === 'compilation_error',
      counted: h.id === countedId,
      verdicts: h.status === 'compilation_error' ? [] : this.client.parseVerdicts(h.comment),
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
      url: this.url(WEB_PATHS.submission(d.id)),
      status: d.status,
      compilerMessage: msg,
      maxRuntimeMs: d.maxRuntimeMs,
      peakMemoryKb: d.peakMemoryKb,
      hasSource: d.source !== null,
      sourceFilename: d.sourceFilename,
      evaluations: evals.map((e, i) => ({
        index: i + 1,
        kind: e.result ?? 'unknown',
        label: S.submit.testLabel(i + 1, resultWord(e.result)),
        score: e.score,
        timeMs: e.timeMs,
        memoryKb: e.memoryKb,
      })),
    };
  }

  /** The filter is kept per workspace; a window with no folder open has no lasting workspace. */
  private problemFilter(): ProblemFilter {
    return this.mapping.local.get<ProblemFilter>(KEYS.problemFilter, { status: 'all', topic: null });
  }

  /** Persist the problem-list filter per workspace. */
  async setProblemFilter(f: ProblemFilter): Promise<void> {
    const valid: ProblemFilter['status'][] = ['all', 'unsolved', 'inprogress', 'solved'];
    const sorts = ['default', 'default-reversed', 'name-asc', 'name-desc', 'latest', 'score-asc', 'score-desc', 'recent'];
    await this.mapping.local.update(KEYS.problemFilter, {
      status: valid.includes(f.status) ? f.status : 'all',
      ...cleanTopicFilter(f),
      sort: f.sort && sorts.includes(f.sort) ? f.sort : 'default',
      ...cleanTagFilter(f.tags, f.tagMode),
    });
    this.emit();
  }

  /** Topic pills: the website's topic tags (from /main/list). Unknown → none, and every tag goes to the "Tags" dropdown. */
  private topics(list: ProblemList | undefined): { name: string; description: string | null }[] {
    return list?.topics?.length ? list.topics : [];
  }

  private allowedLanguages(p: Pick<Problem, 'permittedLanguageIds'>): Language[] {
    return p.permittedLanguageIds === null ? this.languages : this.languages.filter((l) => p.permittedLanguageIds!.includes(l.id));
  }

  // ------------------------------------------------------ inline questions

  /**
   * Ask in the panel with plain buttons (no OS dialog). Resolves with the
   * chosen button id, or undefined when replaced, dismissed or the active
   * file changes. Native modal dialogs are only for actions that can't be
   * undone or lose data (overwrite a file, clear data, exam submit).
   */
  askInline(text: string, buttons: InlinePrompt['buttons'], opts: AskOptions = {}): Promise<string | undefined> {
    return this.prompts.ask(text, buttons, opts);
  }

  answerPrompt(id: number, button: string | null): void {
    this.prompts.answer(id, button);
  }

  /** An error the user should read once: inline in the panel, a toast only when the panel is hidden. */
  private async tellInline(err: unknown, msg: string): Promise<void> {
    this.log(msg);
    if (this.data.isVisible()) void this.askInline(msg, [{ id: 'ok', label: S.common.ok }], { tone: 'warn' });
    else await this.showError(err, msg);
  }

  private markUnavailable(problemId: number): void {
    if (this.unavailableIds.has(problemId)) return;
    this.unavailableIds.add(problemId);
    this.emit();
  }

  /** Remember when a problem was last worked on (for "Recently opened" sorting). */
  private async noteOpened(problemId: number): Promise<void> {
    const all = { ...this.ctx.workspaceState.get<Record<string, number>>(KEYS.recentlyOpened, {}) };
    all[problemId] = Date.now();
    const keep = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, LIMITS.recentlyOpenedMax);
    await this.ctx.workspaceState.update(KEYS.recentlyOpened, Object.fromEntries(keep));
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

  // ---------------------------------------------------------------- CPH

  async cphTip(action: 'install' | 'later' | 'never'): Promise<void> {
    if (action === 'install') await vscode.commands.executeCommand('extension.open', CPH_EXTENSION_ID);
    if (action === 'never') await this.ctx.globalState.update(KEYS.cphTipDismissed, true);
    this.cphTipHidden = true; // never more than once per session
    this.emit();
  }

  /**
   * CPH's "Auto Show Judge" (on by default) opens CPH's panel on every switch to a
   * source file, which can cover this one. Ask once per session, in the panel, only
   * while the panel is visible and nothing else is being asked. A question cancelled
   * by a file switch or another question comes back later; "Keep it" = this session,
   * "Don't ask again" = never.
   */
  private async maybeAskCphAutoShow(): Promise<void> {
    if (this.cphAutoShowAsked || this.prompts.current || !this.cph.installed || !this.fileUri || !this.data.isVisible()) return;
    if (this.ctx.globalState.get<boolean>(KEYS.cphAutoShowDismissed, false)) return;
    const cfg = vscode.workspace.getConfiguration(CPH_AUTO_SHOW_SECTION, this.fileUri);
    const scope = cphAutoShowScope(cfg.inspect(CPH_AUTO_SHOW_KEY));
    if (!scope) return;
    this.cphAutoShowAsked = true;
    const pick = await this.askInline(S.cphAutoShow.question, [
      { id: 'off', label: S.cphAutoShow.turnOff, primary: true },
      { id: 'keep', label: S.cphAutoShow.keep },
      { id: 'never', label: S.cphAutoShow.never },
    ], { detail: S.cphAutoShow.detail });
    if (pick === undefined) {
      this.cphAutoShowAsked = false; // replaced or cancelled by a file switch: ask again later
      return;
    }
    if (pick === 'never') await this.ctx.globalState.update(KEYS.cphAutoShowDismissed, true);
    if (pick !== 'off') return;
    // Turn it off where it is turned on (a workspace value would override a user-level change).
    const target =
      scope === 'workspaceFolder' ? vscode.ConfigurationTarget.WorkspaceFolder : scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    try {
      await cfg.update(CPH_AUTO_SHOW_KEY, false, target);
      void this.askInline(S.cphAutoShow.done, [{ id: 'ok', label: S.common.ok }]);
    } catch (err) {
      void this.askInline(S.cphAutoShow.failed(this.describe(err)), [{ id: 'ok', label: S.common.ok }], { tone: 'warn' });
    }
  }

  // --------------------------------------------------------------- account

  /**
   * Log in with credentials typed in the sidebar. With `remember`, the
   * password goes to SecretStorage (macOS Keychain); without it, only the
   * token is kept, in memory.
   */
  async loginWith(username: string, password: string, remember: boolean, server?: string): Promise<boolean> {
    username = username.trim();
    if (!username || !password) {
      this.accountError = S.account.enterBoth;
      this.emit();
      return false;
    }
    // Before anything is stored or sent: a blocked address leaves the account as it was.
    const attempt = ++this.loginAttempt;
    const gate = await this.server.gate(server, this.cfg.baseUrl);
    if (!gate.ok || attempt !== this.loginAttempt) return false; // blocked, or something newer took over
    this.server.reset();
    await this.ctx.globalState.update(KEYS.rememberPassword, remember);
    if ((username !== this.cfg.username || gate.url !== this.cfg.baseUrl) && !(await this.switchAccount(username, gate.url))) {
      this.accountError = S.account.settingsNotSaved;
      this.emit();
      return false;
    }
    if (remember) await this.secrets.store(this.secretKey('password'), password);
    else await this.secrets.delete(this.secretKey('password'));
    this.hasSavedPassword = remember;
    return this.doLogin({ username, password });
  }

  /** Another user or grader: the previous one's saved password and token don't stay behind. */
  private async switchAccount(username: string, baseUrl: string): Promise<boolean> {
    const prev = this.cfg;
    const settings = vscode.workspace.getConfiguration('cedtGrader');
    const target = vscode.ConfigurationTarget.Global;
    this.changingAccount = true;
    try {
      if (username !== prev.username) await settings.update('username', username, target);
      if (baseUrl !== prev.baseUrl) await settings.update('baseUrl', baseUrl === DEFAULT_BASE_URL ? undefined : baseUrl, target);
    } catch (err) {
      // Secrets are forgotten only after this worked, so the old account is still whole.
      this.log(`Couldn't save the account settings: ${this.describe(err)}`);
      if (username !== prev.username) await settings.update('username', prev.username || undefined, target).then(undefined, () => undefined);
      this.cfg = readConfig();
      return false;
    } finally {
      this.changingAccount = false;
    }
    await this.secrets.forgetAccount(prev.baseUrl, prev.username);
    this.cfg = readConfig();
    await this.client.logout();
    this.client = this.makeClient();
    this.resetSessionState();
    return true;
  }

  /** Show whether an address typed at login answers like a grader. Sends no credentials. */
  checkServer(url: string): Promise<void> {
    return this.server.inspect(url);
  }

  /**
   * Log in with the stored password (explicit user action). It isn't checked
   * again: a password is stored per address, so this one has already gone there.
   */
  async login(): Promise<boolean> {
    const password = await this.getPassword();
    if (!this.cfg.username || !password) {
      await vscode.commands.executeCommand('cedtGrader.panel.focus');
      return false;
    }
    return this.doLogin({ username: this.cfg.username, password });
  }

  private async doLogin(creds: Credentials): Promise<boolean> {
    const client = this.client;
    this.accountStatus = 'logging-in';
    this.accountError = null;
    this.emit();
    try {
      await client.login(creds);
      if (client !== this.client) return false; // the account changed meanwhile
      this.accountStatus = 'logged-in';
      this.connection = null;
      this.retryAction = null;
      this.log(`Logged in to ${this.cfg.baseUrl}.`);
      this.data.clear();
      await this.data.loadProblems(true);
      await this.ensureLanguages();
      return true;
    } catch (err) {
      if (client !== this.client) return false; // a Retry would send these credentials to the new server
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
      await this.secrets.delete(this.secretKey('password'));
      this.hasSavedPassword = false;
    }
    this.emit();
  }

  /** Remove the token and the stored password. */
  async logout(): Promise<void> {
    this.submitFlow.stop();
    await this.client.logout();
    // Every saved password / token (also of earlier users or grader addresses), and the current ones.
    await this.secrets.forgetAll(this.cfg.username ? [this.secretKey('password'), this.secretKey('token')] : []);
    this.hasSavedPassword = false;
    this.accountError = null;
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
    const targetBefore = this.folder.targetUri()?.fsPath;
    if (changed) {
      this.prompts.cancel();
      this.links.onFileChanged(uri);
      this.languagesError = null;
      this.expandedSubmission = null;
    }

    // Matching order: saved (the file's own link, else its folder's link) → CPH .prob → exact file name
    // → exact folder name → suggestions (never saved automatically).
    // An explicitly unlinked file (or folder) is left alone ("Not linked to a problem").
    const link = await this.mapping.activeLink(uri, this.cfg.baseUrl);
    const entry = link?.entry;
    const unlinked = !entry && this.mapping.isUnlinkedHere(uri);
    await this.folder.load(link?.folder ? { fsPath: link.folder, entry: link.entry } : null);
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
          folders: this.links.sourceFile(uri.fsPath).folders,
          namePattern: this.cfg.fileNamePattern.pattern,
        });
    this.notLinked = unlinked;
    if (seq !== this.refreshSeq) return;
    let problem: CurrentProblem | null = null;
    this.matchInfo = { ...NO_MATCH_INFO };
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
    // Matched by the name of its folder, or at the top of a workspace folder holding a package: the
    // folder is a package like a linked folder (submit and run files detected), but nothing is saved
    // until the user chooses something.
    if (!this.folder.link && problem) {
      const isPackage = problem.source === 'folder' || (await this.folder.atRootPackage(uri, problem.source));
      // Another file became active during the check: loading this one's package would make Submit send it for that file.
      if (seq !== this.refreshSeq) return;
      if (isPackage) {
        await this.folder.load({ fsPath: dirname(uri.fsPath), entry: { problemId: problem.id, name: problem.name, baseUrl: this.cfg.baseUrl, folder: true } }, true);
        if (seq !== this.refreshSeq) return;
      }
    }
    // The chosen language belongs to the file Submit sends (folder mode: the folder's submit file).
    const target = this.folder.targetUri()?.fsPath;
    if (changed || target !== targetBefore) {
      this.selectedLanguageId = target ? (this.ctx.workspaceState.get<Record<string, number>>(KEYS.languageByFile, {})[target] ?? null) : null;
    }
    // Opened from a problem row: show that problem as a temporary link ("Suggested · Use this")
    // unless the file already resolves to it. Saving it is up to the user.
    const temp = !entry && !unlinked ? this.links.tempProblemFor(uri) : undefined;
    if (temp && !(problem && problem.id === temp.id)) {
      problem = { ...temp, source: 'suggested' };
      this.matchInfo = { suggestions: [temp, ...this.matchInfo.suggestions.filter((x) => x.id !== temp.id)], ambiguous: null, ambiguousSource: null };
    }
    // Remember automatic matches of open files (never over a manual link or "not linked").
    if (!entry && !unlinked && m.kind === 'match' && (m.source === 'filename' || m.source === 'folder' || m.source === 'cph' || m.source === 'suggested')) await this.mapping.recordAuto(uri, m.problem.id, m.source);
    else if (!entry && list?.length && m.kind !== 'match') await this.mapping.dropAuto(uri);
    await this.links.refreshMappedIds();
    if (seq !== this.refreshSeq) return;
    this.problem = problem;
    // Cached name search only here; a missing search runs right after the first render.
    // Suggestions (confident ones only) behave like links for everything read-only.
    this.links.linkedFiles = problem ? await this.links.filesForProblem(problem.id, 'cached') : [];
    if (problem && !this.links.hasIndex() && this.data.isVisible()) void this.links.refreshLinkedFiles();
    if (problem) await this.noteOpened(problem.id);
    await this.tests.onActiveFile(problem);
    this.applyLanguageChoice();
    this.emit();
    this.followStatement(uri, problem);
    // One problem only (the top suggestion at most, never several candidates).
    this.data.focusProblem(problem ? problem.id : null);
    if (!entry) this.links.maybeOfferReconnect(uri);
    void this.maybeAskCphAutoShow();
  }

  /**
   * An open statement tab follows the active source file's problem (when it
   * changes; a problem chosen from a row's statement icon stays until then);
   * no problem → that tab closes. Other files (.in, README, …) change nothing.
   */
  private followStatement(uri: vscode.Uri, problem: Problem | null): void {
    if (!this.cfg.statementFollowsFile || !languageForPath(uri.fsPath)) return;
    const id = problem?.id ?? null;
    if (id === this.followedProblemId) return;
    this.followedProblemId = id;
    this.statements.follow(problem ? { problemId: problem.id, name: problem.name, outdated: this.unavailableIds.has(problem.id) ? S.statementOutdated : null } : null);
  }

  /** File created / deleted / renamed: drop cached name searches (debounced), then refresh what is shown. */
  private onFileEvent(): void {
    clearTimeout(this.fileEventTimer);
    this.fileEventTimer = setTimeout(() => {
      this.links.invalidateIndex();
      // Folder mode: files created / deleted / renamed → detect the submit / run files again (choices kept).
      if (this.folder.link && this.fileUri) void this.setActiveFile(this.fileUri);
      if (this.data.isVisible()) void this.links.refreshLinkedFiles();
    }, TIMING.fileEventDebounceMs);
  }

  /** Update mappings (and per-file state) for files renamed or moved inside VS Code. */
  private async onFilesRenamed(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    const moved: { from: string; to: string }[] = [];
    for (const f of files) moved.push(...(await this.mapping.rename(f.oldUri, f.newUri)));
    // Auto-matches follow the file only while the new name still matches.
    for (const f of files) await this.mapping.renameAuto(f.oldUri, f.newUri, (path, id) => this.links.matcherSays(path, id));
    this.onFileEvent();
    // Per-file state follows the file even when it had no mapping (results, chosen language).
    const langs = { ...this.ctx.workspaceState.get<Record<string, number>>(KEYS.languageByFile, {}) };
    for (const f of files) {
      this.submitFlow.results.rename(f.oldUri.fsPath, f.newUri.fsPath);
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
    await this.ctx.workspaceState.update(KEYS.languageByFile, langs);
    // CPH names its file after the full source path and does not follow renames. A renamed folder
    // took its `.cph/` along (or the files stayed in CPH's save location): every source inside is orphaned.
    const save = this.cphSaveLocation();
    const inFolders: { prob: string; oldSrc: string; newSrc: string }[] = [];
    for (const f of files) {
      if ((await fsStat(f.newUri.fsPath).catch(() => null))?.isDirectory()) inFolders.push(...(await cphFilesAfterFolderRename(f.oldUri.fsPath, f.newUri.fsPath, save)));
    }
    if (moved.length) this.log(`Updated ${moved.length} mapping(s) after a rename.`);
    if (this.fileUri && (moved.length || this.folder.link)) await this.setActiveFile(this.fileUri); // links / the folder's files may have moved

    // Offer once (for files and folders together).
    const taken = new Set(inFolders.map((x) => pathKey(x.oldSrc)));
    const withCph: { from: string; to: string; prob?: string }[] = inFolders.map((x) => ({ from: x.oldSrc, to: x.newSrc, prob: x.prob }));
    for (const m of moved) if (!taken.has(pathKey(m.from)) && (await exists(cphProbPathFor(m.from, save)))) withCph.push(m);
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
      const r = await moveCphProblem(m.from, m.to, save, m.prob);
      await this.cache.recordBackup(r.backup);
      if (r.status === 'moved') done++;
      else if (r.status === 'target-exists') skipped++;
    }
    void vscode.window.showInformationMessage(S.moved.movedCph(done, skipped));
    await this.tests.refreshRunTests();
  }

  /** "Clear Cached Data": what the controller resets after the cache flow cleared the stores. */
  private async afterClear(resetData: boolean): Promise<void> {
    this.mapping.invalidate();
    this.links.invalidateIndex();
    this.selectedLanguageId = null;
    if (resetData) {
      this.submitFlow.results.clear();
      this.expandedSubmission = null;
      this.unavailableIds.clear();
      this.data.clear();
      if (this.client.isLoggedIn) void this.data.loadProblems();
    }
    await this.links.refreshMappedIds();
    if (this.fileUri) await this.setActiveFile(this.fileUri);
    else this.emit();
  }

  private applyLanguageChoice(): void {
    const problem = this.currentProblem();
    const target = this.folder.targetUri();
    if (!problem || !target || !this.languages.length) return;
    const allowed = this.allowedLanguages(problem);
    if (allowed.some((l) => l.id === this.selectedLanguageId)) {
      this.languagesError = null;
    } else {
      const c = chooseLanguage(target.fsPath, allowed, this.languages);
      this.selectedLanguageId = c.kind === 'match' ? c.language.id : null;
      this.languagesError = null; // a mismatch is reported once, by languageMismatch()
    }
  }

  async selectLanguage(id: number): Promise<void> {
    this.selectedLanguageId = id;
    this.languagesError = null;
    const target = this.folder.targetUri();
    if (target) {
      const all = { ...this.ctx.workspaceState.get<Record<string, number>>(KEYS.languageByFile, {}) };
      all[target.fsPath] = id;
      await this.ctx.workspaceState.update(KEYS.languageByFile, all);
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

  /** Open the problem dropdown in the panel (e.g. "Choose another problem"). */
  async focusProblemPicker(): Promise<void> {
    await vscode.commands.executeCommand('cedtGrader.panel.focus');
    this.focusTarget?.('problem-search');
  }
  /** Set by the sidebar provider: focus something inside the panel. */
  focusTarget: ((t: 'login' | 'problem-search' | 'submit' | 'result') => void) | null = null;

  /** Command-palette flow: searchable QuickPick of the cached problem list. */
  async chooseProblemQuickPick(apply: (problemId: number) => Promise<void> = (id) => this.links.mapCurrentFile(id)): Promise<void> {
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
    if (pick) await apply(pick.id);
  }

  // ------------------------------------------------- panel actions (flows)

  mapCurrentFile = (problemId: number) => this.links.mapCurrentFile(problemId);
  unmapCurrentFile = () => this.links.unmapCurrentFile();
  problemRowClick = (problemId: number) => this.links.problemRowClick(problemId);
  autoDetect = () => this.links.autoDetect();
  openLinkedFile = (index: number) => this.links.openLinkedFile(index);
  unlinkLinkedFile = (index: number) => this.links.unlinkLinkedFile(index);
  renameFileToProblem = () => this.links.renameFileToProblem();
  dismissLinkedNotice = () => this.links.dismissLinkedNotice();
  keepOnlyThisFile = () => this.links.keepOnlyThisFile();
  copyProblemName = (problemId: number) => this.links.copyProblemName(problemId);
  newFileForProblem = (problemId: number) => this.links.newFileForProblem(problemId);
  goToFile = (problemId: number) => this.links.goToFile(problemId);
  findFileByName = (problemId: number) => this.links.findFileByName(problemId);
  toggleFolderMode = () => this.folder.toggle();
  setFolderRole = (role: 'submit' | 'run', rel: string) => this.folder.setRole(role, rel);
  downloadAttachment = (problemId?: number) => this.attachments.download(problemId);
  loadTestcases = (refresh = false, asFiles = false) => this.tests.loadTestcases(refresh, asFiles);
  loadSampleCases = () => this.tests.loadSampleCases();
  runTests = () => this.tests.runTests();
  submit = () => this.submitFlow.submit();
  showLastResult = () => this.submitFlow.showLastResult();
  showCompilerMessage = () => this.submitFlow.showCompilerMessage();
  clearCachedData = () => this.cache.clear();

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
    const right = this.folder.targetUri() ?? this.fileUri; // folder mode: the file Submit sends
    const label = `${d.number !== null ? W.attempt(d.number) : `#${d.id}`} ↔ ${right.path.split('/').pop()}`;
    await vscode.commands.executeCommand('vscode.diff', left, right, label);
  }

  /** Content for `cedt-grader-submission:/<id>/<file>` URIs (cache only, no request). */
  submissionSource(uri: vscode.Uri): string {
    const id = Number(uri.path.split('/')[1]);
    return this.data.detail(id)?.source ?? '';
  }

  // ---------------------------------------------------------------- browser

  /** README troubleshooting section on GitHub, in the display language. */
  async openTroubleshooting(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(troubleshootingUrl(currentLang()), true));
  }

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
      outdated: this.unavailableIds.has(id) ? S.statementOutdated : null,
    });
  }

  async openStatementInBrowser(problemId: number): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(this.url(WEB_PATHS.statement(problemId))));
  }

  private problemById(id: number): Problem | undefined {
    return this.problems.find((p) => p.id === id) ?? (this.problem?.id === id ? this.problem : undefined);
  }

  async openGraderWebsite(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(this.cfg.baseUrl));
  }

  async openProblemInBrowser(problemId?: number): Promise<void> {
    const id = problemId ?? this.problem?.id;
    if (!id) return;
    await vscode.env.openExternal(vscode.Uri.parse(this.url(WEB_PATHS.problem(id))));
  }

  async openSubmission(id: number): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(this.url(WEB_PATHS.submission(id))));
  }

  // ----------------------------------------------------------------- errors

  describe(err: unknown): string {
    if (err instanceof NetworkError) return S.errors.checkConnection(err.message);
    if (err instanceof GraderError) return err.message;
    if (err instanceof Error) {
      this.crash.caught(err, 'handled error');
      return S.errors.unexpected(err.message);
    }
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

/** VS Code language id for a file name, so "Open this version" gets syntax highlighting. */
function vscodeLanguageId(filename: string): string {
  const ext = /\.([^./]+)$/.exec(filename.toLowerCase())?.[1] ?? '';
  const map: Record<string, string> = {
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', py: 'python', java: 'java', rs: 'rust', go: 'go', php: 'php',
    hs: 'haskell', rb: 'ruby', pas: 'pascal', sql: 'sql', dig: 'xml',
  };
  return map[ext] ?? 'plaintext';
}
