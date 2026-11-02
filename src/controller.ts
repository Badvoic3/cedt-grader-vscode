import * as vscode from 'vscode';
import { readConfig, type GraderConfig } from './config';
import {
  AuthError,
  chooseLanguage,
  countedScore,
  type Credentials,
  describeImprovement,
  GraderClient,
  GraderError,
  type Language,
  LanguageNotAllowedError,
  languageForPath,
  NetworkError,
  PollTimeoutError,
  type Problem,
  SessionExpiredError,
  type StoredToken,
  type SubmissionBrief,
  type SubmissionResult,
  summarize,
} from './grader';
import { matchCphProblem, readCphProblem } from './mapping/cph';
import { MappingStore } from './mapping/store';
import type { HistoryEntry, ProblemView, ResultView, ViewState } from './shared/messages';

export const EXAM_WARNING =
  'This problem looks like part of an exam/contest. Submitting from VS Code may not be allowed. Check with your instructor.';

const HISTORY_TTL_MS = 2 * 60_000;
const LANGUAGE_KEY = 'cedtGrader.languageByFile';
const REMEMBER_KEY = 'cedtGrader.rememberPassword';

type Listener = (s: ViewState) => void;

/**
 * Single owner of the grader session and all UI state. The sidebar webview,
 * the commands and the status bar all go through this class.
 */
export class GraderController implements vscode.Disposable {
  private cfg: GraderConfig = readConfig();
  private client: GraderClient;
  private readonly mapping: MappingStore;
  private readonly listeners = new Set<Listener>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly output: vscode.OutputChannel;

  private accountStatus: ViewState['account']['status'] = 'logged-out';
  private accountError: string | null = null;
  private hasSavedPassword = false;

  private fileUri: vscode.Uri | null = null;
  private problem: (Problem & { source: 'mapping' | 'cph' }) | null = null;
  private problems: Problem[] = [];
  private problemsAt = 0;
  private problemsLoading = false;
  private problemsError: string | null = null;
  private penaltyNote: string | null = null;
  private languages: Language[] = [];
  private languagesLoading = false;
  private languagesError: string | null = null;
  private selectedLanguageId: number | null = null;
  private history = new Map<number, { at: number; items: SubmissionBrief[] }>();
  private historyLoading = false;
  /** Latest result per source file (fsPath): the panel only shows the active file's result. */
  private results = new Map<string, ResultView>();
  private gradingFile: string | null = null;
  private busy = false;
  private pollAbort: AbortController | null = null;
  private refreshSeq = 0;
  private changingUsername = false;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('CEDT Grader');
    this.mapping = new MappingStore(ctx);
    this.client = this.makeClient();
    this.disposables.push(
      this.output,
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e && e.document.uri.scheme === 'file') void this.setActiveFile(e.document.uri);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('cedtGrader')) this.onConfigChanged();
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
    this.hasSavedPassword = !!(await this.getPassword());
    if (await this.client.restore()) this.accountStatus = 'logged-in';
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.scheme === 'file') await this.setActiveFile(ed.document.uri);
    else this.emit();
  }

  dispose(): void {
    this.pollAbort?.abort();
    for (const d of this.disposables) d.dispose();
  }

  onState(l: Listener): vscode.Disposable {
    this.listeners.add(l);
    l(this.state());
    return new vscode.Disposable(() => this.listeners.delete(l));
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
      log: (line) => this.output.appendLine(line),
    });
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
    this.problems = [];
    this.problemsAt = 0;
    this.languages = [];
    this.history.clear();
    this.results.clear();
    this.penaltyNote = null;
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

  // ---------------------------------------------------------------- state

  private problemView(p: Problem): ProblemView {
    return { id: p.id, name: p.name, fullName: p.fullName, score: summarize(p) };
  }

  state(): ViewState {
    const file = this.fileUri;
    const lang = file ? languageForPath(file.fsPath) : null;
    const loggedIn = this.accountStatus === 'logged-in';

    let reason: string | null = null;
    if (this.busy) reason = null;
    else if (!file) reason = 'Open a source file to submit it.';
    else if (!loggedIn && !this.hasSavedPassword) reason = 'Log in first.';
    else if (!this.problem) reason = 'Choose the grader problem for this file.';
    else if (this.languagesLoading) reason = 'Loading languages…';
    else if (this.languagesError) reason = this.languagesError;

    const enabled =
      !this.busy && !!file && !!this.problem && (loggedIn || this.hasSavedPassword) && !this.languagesLoading;

    const hist = this.problem ? this.history.get(this.problem.id) : undefined;
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
      problem: this.problem ? { ...this.problemView(this.problem), source: this.problem.source } : null,
      languages: {
        loading: this.languagesLoading,
        items: this.problem ? this.allowedLanguages(this.problem).map((l) => ({ id: l.id, name: l.name })) : [],
        selectedId: this.selectedLanguageId,
        error: this.languagesError,
      },
      submit: { enabled, busy: this.busy, reason, label: 'Submit to Grader' },
      result: file ? (this.results.get(file.fsPath) ?? null) : null,
      gradingElsewhere:
        this.busy && this.gradingFile !== null && this.gradingFile !== file?.fsPath
          ? (this.results.get(this.gradingFile)?.problemName ?? 'another file')
          : null,
      history: {
        loading: this.historyLoading,
        items: (hist?.items ?? []).slice(0, 10).map(
          (h): HistoryEntry => ({
            submissionId: h.id,
            number: h.number,
            points: h.points,
            status: h.status,
            comment: h.comment,
            submittedAt: h.submittedAt,
            compileError: h.status === 'compilation_error',
          }),
        ),
      },
      problems: {
        loading: this.problemsLoading,
        loaded: this.problemsAt > 0,
        items: this.problems.map((p) => this.problemView(p)),
        error: this.problemsError,
        penaltyNote: this.penaltyNote,
      },
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
      this.log(`Logged in to ${this.cfg.baseUrl}.`);
      await this.refreshProblems(true);
      return true;
    } catch (err) {
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

  /** Errors that mean "logged out" switch the panel back to the login form. */
  private async handleSessionError(err: unknown): Promise<boolean> {
    if (err instanceof SessionExpiredError || (err instanceof AuthError && err.reason !== 'unknown')) {
      await this.onAuthFailure(err);
      return true;
    }
    return false;
  }

  // ----------------------------------------------------------- active file

  async setActiveFile(uri: vscode.Uri): Promise<void> {
    const seq = ++this.refreshSeq;
    const changed = this.fileUri?.toString() !== uri.toString();
    this.fileUri = uri;
    if (changed) {
      this.selectedLanguageId = this.ctx.workspaceState.get<Record<string, number>>(LANGUAGE_KEY, {})[uri.fsPath] ?? null;
      this.languagesError = null;
    }

    let problem: (Problem & { source: 'mapping' | 'cph' }) | null = null;
    const entry = await this.mapping.get(uri, this.cfg.baseUrl);
    if (entry) {
      const p = this.problems.find((x) => x.id === entry.problemId);
      problem = { ...(p ?? placeholderProblem(entry.problemId, entry.name)), source: 'mapping' };
    } else if (this.problems.length) {
      const saveLocation = vscode.workspace.getConfiguration('cph').get<string>('general.saveLocation') ?? '';
      const cph = await readCphProblem(uri.fsPath, saveLocation);
      const match = cph ? matchCphProblem(cph, this.problems, this.cfg.baseUrl) : null;
      if (match) problem = { ...match, source: 'cph' };
    }
    if (seq !== this.refreshSeq) return;
    this.problem = problem;
    this.emit();
    if (problem) {
      await this.loadLanguages();
      this.applyLanguageChoice();
      void this.loadHistory(problem.id, false);
    }
  }

  /** All languages once per session (`GET /api/v1/languages`). */
  private async loadLanguages(): Promise<void> {
    if (this.languages.length || !this.client.isLoggedIn) return;
    this.languagesLoading = true;
    this.emit();
    try {
      this.languages = await this.client.languages();
    } catch (err) {
      if (!(await this.handleSessionError(err))) this.languagesError = this.describe(err);
    } finally {
      this.languagesLoading = false;
      this.emit();
    }
  }

  private applyLanguageChoice(): void {
    if (!this.problem || !this.fileUri || !this.languages.length) return;
    const allowed = this.allowedLanguages(this.problem);
    if (allowed.some((l) => l.id === this.selectedLanguageId)) {
      this.languagesError = null;
    } else {
      const c = chooseLanguage(this.fileUri.fsPath, allowed);
      this.selectedLanguageId = c.kind === 'match' ? c.language.id : null;
      this.languagesError =
        c.kind === 'not-allowed' ? `${c.wanted} is not allowed for this problem (allowed: ${c.allowed.map((l) => l.name).join(', ')}).` : null;
    }
    this.emit();
  }

  private async loadHistory(problemId: number, force: boolean): Promise<void> {
    const cached = this.history.get(problemId);
    if (!this.client.isLoggedIn || (!force && cached && Date.now() - cached.at < HISTORY_TTL_MS)) return;
    this.historyLoading = true;
    this.emit();
    try {
      this.history.set(problemId, { at: Date.now(), items: await this.client.listSubmissions(problemId) });
    } catch (err) {
      if (!(await this.handleSessionError(err))) this.log(`History unavailable: ${this.describe(err)}`);
    } finally {
      this.historyLoading = false;
      this.emit();
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

  /** `GET /api/v1/problems` (+ `/main/list` penalties). Only on login and on Refresh. */
  async refreshProblems(force = true): Promise<void> {
    if (!force && this.problemsAt) return;
    if (!(await this.ensureLoggedIn())) return;
    this.problemsLoading = true;
    this.problemsError = null;
    this.emit();
    try {
      const { problems, listStatus } = await this.client.listProblems();
      this.problems = problems;
      this.problemsAt = Date.now();
      this.penaltyNote =
        listStatus === 'loaded'
          ? null
          : listStatus === 'no-web-session'
            ? 'Hint/AI penalties not loaded (password not remembered). Scores shown are best scores.'
            : 'Could not read hint/AI penalties from the problem list. Scores shown are best scores.';
      if (this.problem) {
        const p = problems.find((x) => x.id === this.problem!.id);
        if (p) this.problem = { ...p, source: this.problem.source };
      }
      await this.loadLanguages();
    } catch (err) {
      if (!(await this.handleSessionError(err))) this.problemsError = this.describe(err);
    } finally {
      this.problemsLoading = false;
      this.emit();
    }
    if (this.fileUri) await this.setActiveFile(this.fileUri);
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

  async unmapCurrentFile(): Promise<void> {
    if (!this.fileUri) return;
    await this.mapping.set(this.fileUri, undefined);
    this.problem = null;
    await this.setActiveFile(this.fileUri);
  }

  /** Command-palette flow: searchable QuickPick of the problem list. */
  async chooseProblemQuickPick(): Promise<void> {
    if (!this.fileUri) {
      void vscode.window.showInformationMessage('Open a source file first.');
      return;
    }
    await this.refreshProblems(false);
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
    const problem = this.problem;
    const key = fileUri.fsPath;
    const fileName = fileUri.path.split('/').pop() ?? '';

    this.busy = true;
    this.gradingFile = key;
    this.emit();
    try {
      // Fresh problem info: counted score before, permitted languages.
      const before = await this.client.getProblem(problem.id);
      const listInfo = this.problems.find((p) => p.id === problem.id)?.list ?? null;
      const countedBefore = countedScore(before.bestScore, listInfo?.cost ?? 0, listInfo?.rawSum ?? false);
      await this.loadLanguages();
      const allowed = this.allowedLanguages(before);

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
      this.updateResult(key, {
        phase: 'grading',
        submissionId: sub.id,
        number: sub.number,
        submissionUrl: this.url(`/submissions/${sub.id}`),
        message: 'Waiting to be graded…',
      });
      const final = await this.poll(key, problem, sub.id);
      if (final) await this.afterGraded(key, problem, final, countedBefore);
    } catch (err) {
      const msg = this.describe(err);
      const r = this.results.get(key);
      if (r && r.problemId === problem.id && (r.phase === 'submitting' || r.phase === 'grading')) {
        this.updateResult(key, { phase: 'error', message: msg });
      } else {
        this.setResult(key, newResult(problem, 'error', msg));
      }
      if (!(await this.handleSessionError(err))) void this.showError(err, msg);
    } finally {
      this.busy = false;
      this.gradingFile = null;
      this.pollAbort = null;
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
  private async poll(key: string, problem: Problem, submissionId: number): Promise<SubmissionResult | null> {
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

  private applySubmission(key: string, s: SubmissionResult): void {
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

  /** Refresh this problem's scores and history, then say whether the counted score changed. */
  private async afterGraded(key: string, problem: Problem, s: SubmissionResult, countedBefore: number | null): Promise<void> {
    this.applySubmission(key, s);
    try {
      const fresh = await this.client.getProblem(problem.id);
      const list = this.problems.find((p) => p.id === problem.id)?.list ?? null;
      const updated: Problem = { ...fresh, list };
      this.problems = this.problems.map((p) => (p.id === problem.id ? updated : p));
      if (this.problem?.id === problem.id) this.problem = { ...updated, source: this.problem.source };
      const after = countedScore(updated.bestScore, list?.cost ?? 0, list?.rawSum ?? false);
      this.updateResult(key, { improvement: describeImprovement(countedBefore, after, s.points) });
    } catch (err) {
      this.log(`Could not refresh scores: ${this.describe(err)}`);
    }
    await this.loadHistory(problem.id, true);
  }

  /** Fetch the latest submission of the current file's problem once (no polling loop). */
  async showLastResult(): Promise<void> {
    await vscode.commands.executeCommand('cedtGrader.panel.focus');
    const problem = this.problem;
    const key = this.fileUri?.fsPath;
    if (!problem || !key || this.busy) return;
    if (!(await this.ensureLoggedIn())) return;
    try {
      const p = await this.client.getProblem(problem.id);
      const lastId = p.submissionIds[0] ?? p.lastSubmissionId;
      if (!lastId) {
        this.setResult(key, newResult(problem, 'done', 'No submissions yet.'));
        return;
      }
      const s = await this.client.getSubmission(lastId);
      this.setResult(key, newResult(problem, 'grading', null));
      this.applySubmission(key, s);
      if (s.state !== 'graded') this.updateResult(key, { phase: 'timeout', message: 'Still being graded. Check again in a moment.' });
      await this.loadHistory(problem.id, true);
    } catch (err) {
      if (!(await this.handleSessionError(err))) void this.showError(err, this.describe(err));
    }
  }

  async showCompilerMessage(): Promise<void> {
    const key = this.fileUri?.fsPath;
    const r = key ? this.results.get(key) : undefined;
    if (!r?.compileError) return;
    const doc = await vscode.workspace.openTextDocument({ content: r.compilerMessage ?? '', language: 'log' });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }

  // ---------------------------------------------------------------- browser

  async openStatement(problemId?: number): Promise<void> {
    const id = problemId ?? this.problem?.id;
    if (!id) {
      void vscode.window.showInformationMessage('Choose a problem first.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(this.url(`/problems/${id}/download/statement`)));
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

  private async showError(err: unknown, msg: string): Promise<void> {
    this.log(`Error: ${msg}`);
    const actions: string[] = err instanceof NetworkError ? ['Show Log'] : [];
    const pick = await vscode.window.showErrorMessage(msg, ...actions);
    if (pick === 'Show Log') this.output.show();
  }
}

function placeholderProblem(id: number, name: string): Problem {
  return {
    id,
    name: name || `#${id}`,
    fullName: name,
    bestScore: null,
    lastScore: null,
    lastResult: null,
    lastSubmissionId: null,
    lastSubmissionTime: null,
    submissionCount: 0,
    hasTestcase: false,
    hasAttachment: false,
    permittedLanguageIds: null,
    list: null,
  };
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
