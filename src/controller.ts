import * as vscode from 'vscode';
import { readConfig, type GraderConfig } from './config';
import {
  AuthError,
  chooseLanguage,
  GraderClient,
  GraderError,
  LanguageNotAllowedError,
  languageForPath,
  NetworkError,
  PollTimeoutError,
  type Problem,
  SessionExpiredError,
  type SubmissionStatus,
  type SubmitPage,
  SubmitRejectedError,
} from './grader';
import { matchCphProblem, readCphProblem } from './mapping/cph';
import { MappingStore } from './mapping/store';
import type { HistoryEntry, ResultView, ViewState } from './shared/messages';

export const EXAM_WARNING =
  'This problem looks like part of an exam/contest. Submitting from VS Code may not be allowed. Check with your instructor.';

const PROBLEMS_TTL_MS = 10 * 60_000;
const SUBMIT_PAGE_TTL_MS = 2 * 60_000;
const HISTORY_KEY = 'cedtGrader.history';
const LANGUAGE_KEY = 'cedtGrader.languageByFile';
const HISTORY_MAX = 10;

type Listener = (s: ViewState) => void;

interface SubmitPageEntry {
  page: SubmitPage;
  at: number;
}

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
  private submitPages = new Map<number, SubmitPageEntry>();
  private languagesLoading = false;
  private languagesError: string | null = null;
  private selectedLanguageId: number | null = null;
  /** Latest result per source file (fsPath), so the panel only shows the active file's result. */
  private results = new Map<string, ResultView>();
  /** File whose submission is being graded right now. */
  private gradingFile: string | null = null;
  private busy = false;
  private pollAbort: AbortController | null = null;
  private refreshSeq = 0;
  /** Set while loginWith() changes the username setting itself. */
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

  async init(): Promise<void> {
    this.hasSavedPassword = !!(await this.getPassword());
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

  get isBusy(): boolean {
    return this.busy;
  }

  // ------------------------------------------------------------ plumbing

  private makeClient(): GraderClient {
    return new GraderClient({
      baseUrl: this.cfg.baseUrl,
      getCredentials: async () => {
        const password = await this.getPassword();
        return this.cfg.username && password ? { username: this.cfg.username, password } : undefined;
      },
      log: (line) => this.output.appendLine(line),
    });
  }

  private onConfigChanged(): void {
    const prev = this.cfg;
    this.cfg = readConfig();
    if (this.changingUsername && prev.baseUrl === this.cfg.baseUrl) {
      this.emit();
      return;
    }
    if (prev.baseUrl !== this.cfg.baseUrl || prev.username !== this.cfg.username) {
      this.client.logout();
      this.client = this.makeClient();
      this.accountStatus = 'logged-out';
      this.problems = [];
      this.problemsAt = 0;
      this.submitPages.clear();
      void this.getPassword().then((p) => {
        this.hasSavedPassword = !!p;
        if (this.fileUri) void this.setActiveFile(this.fileUri);
      });
    }
    this.emit();
  }

  private secretKey(username = this.cfg.username): string {
    return `cedtGrader.password:${this.cfg.baseUrl}:${username}`;
  }

  private async getPassword(): Promise<string | undefined> {
    if (!this.cfg.username) return undefined;
    return this.ctx.secrets.get(this.secretKey());
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

  state(): ViewState {
    const file = this.fileUri;
    const lang = file ? languageForPath(file.fsPath) : null;
    const entry = this.problem ? this.submitPages.get(this.problem.id) : undefined;

    let reason: string | null = null;
    if (this.busy) reason = null;
    else if (!file) reason = 'Open a source file to submit it.';
    else if (this.accountStatus !== 'logged-in' && !this.hasSavedPassword) reason = 'Log in first.';
    else if (!this.problem) reason = 'Choose the grader problem for this file.';
    else if (this.languagesLoading) reason = 'Checking the problem…';
    else if (this.languagesError) reason = this.languagesError;
    else if (entry && !entry.page.canSubmit) reason = 'This problem is not open for your submissions.';

    const enabled =
      !this.busy &&
      !!file &&
      !!this.problem &&
      (this.accountStatus === 'logged-in' || this.hasSavedPassword) &&
      !this.languagesLoading &&
      !(entry && !entry.page.canSubmit);

    return {
      baseUrl: this.cfg.baseUrl,
      account: {
        status: this.accountStatus,
        username: this.cfg.username,
        hasSavedPassword: this.hasSavedPassword,
        error: this.accountError,
      },
      file: file
        ? { path: vscode.workspace.asRelativePath(file, false), name: file.path.split('/').pop() ?? '', languageGuess: lang, supported: lang !== null }
        : null,
      problem: this.problem
        ? {
            id: this.problem.id,
            name: this.problem.name,
            fullName: this.problem.fullName,
            bestScore: this.problem.bestScore,
            source: this.problem.source,
            statementUrl: this.problem.statementUrl ?? null,
          }
        : null,
      languages: {
        loading: this.languagesLoading,
        items: entry?.page.languages.map((l) => ({ id: l.id, name: l.name })) ?? [],
        selectedId: this.selectedLanguageId,
        forced: entry?.page.languageForced ?? false,
        error: this.languagesError,
      },
      submit: { enabled, busy: this.busy, reason, label: 'Submit to Grader' },
      result: file ? (this.results.get(file.fsPath) ?? null) : null,
      gradingElsewhere:
        this.busy && this.gradingFile !== null && this.gradingFile !== file?.fsPath
          ? (this.results.get(this.gradingFile)?.problemName ?? 'another file')
          : null,
      history: this.problem ? this.history(this.problem.id) : [],
      problems: {
        loading: this.problemsLoading,
        loaded: this.problemsAt > 0,
        items: this.problems.map((p) => ({ id: p.id, name: p.name, fullName: p.fullName, bestScore: p.bestScore })),
        error: this.problemsError,
      },
    };
  }

  private history(problemId: number): HistoryEntry[] {
    const all = this.ctx.globalState.get<Record<string, HistoryEntry[]>>(HISTORY_KEY, {});
    return all[`${this.cfg.baseUrl}#${problemId}`] ?? [];
  }

  private async pushHistory(problemId: number, e: HistoryEntry): Promise<void> {
    const all = { ...this.ctx.globalState.get<Record<string, HistoryEntry[]>>(HISTORY_KEY, {}) };
    const key = `${this.cfg.baseUrl}#${problemId}`;
    const list = (all[key] ?? []).filter((x) => x.submissionId !== e.submissionId);
    all[key] = [e, ...list].slice(0, HISTORY_MAX);
    await this.ctx.globalState.update(HISTORY_KEY, all);
  }

  // --------------------------------------------------------------- account

  /** Log in with credentials typed in the sidebar (password goes straight to SecretStorage). */
  async loginWith(username: string, password: string): Promise<boolean> {
    username = username.trim();
    if (!username || !password) {
      this.accountError = 'Enter your username and password.';
      this.emit();
      return false;
    }
    if (username !== this.cfg.username) {
      this.changingUsername = true;
      try {
        await vscode.workspace.getConfiguration('cedtGrader').update('username', username, vscode.ConfigurationTarget.Global);
      } finally {
        this.changingUsername = false;
      }
      this.cfg = readConfig();
      this.client.logout();
      this.client = this.makeClient();
      this.problems = [];
      this.problemsAt = 0;
      this.submitPages.clear();
    }
    await this.ctx.secrets.store(this.secretKey(username), password);
    this.hasSavedPassword = true;
    return this.login();
  }

  /** Log in with the saved credentials (explicit user action only, never on startup). */
  async login(): Promise<boolean> {
    if (!this.cfg.username || !(await this.getPassword())) {
      this.accountError = null;
      this.emit();
      await vscode.commands.executeCommand('cedtGrader.panel.focus');
      return false;
    }
    this.accountStatus = 'logging-in';
    this.accountError = null;
    this.emit();
    try {
      await this.client.login();
      this.accountStatus = 'logged-in';
      this.log(`Logged in to ${this.cfg.baseUrl}.`);
      if (this.client.landingProblems) {
        this.problems = this.client.landingProblems;
        this.problemsAt = Date.now();
        this.problemsError = null;
      }
      if (this.fileUri) await this.setActiveFile(this.fileUri);
      else this.emit();
      return true;
    } catch (err) {
      this.accountStatus = 'logged-out';
      this.accountError = this.describe(err);
      if (err instanceof AuthError && err.reason === 'wrong-password') {
        await this.ctx.secrets.delete(this.secretKey());
        this.hasSavedPassword = false;
      }
      this.emit();
      return false;
    }
  }

  /** Forget the session and the saved password. */
  async logout(): Promise<void> {
    this.pollAbort?.abort();
    this.client.logout();
    this.results.clear();
    if (this.cfg.username) await this.ctx.secrets.delete(this.secretKey());
    this.hasSavedPassword = false;
    this.accountStatus = 'logged-out';
    this.accountError = null;
    this.problems = [];
    this.problemsAt = 0;
    this.submitPages.clear();
    this.emit();
  }

  private async ensureLoggedIn(): Promise<boolean> {
    if (this.client.isLoggedIn) return true;
    return this.login();
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
      problem = { ...(p ?? { id: entry.problemId, name: entry.name || `#${entry.problemId}`, fullName: entry.name, bestScore: null, latestSubmissionId: null }), source: 'mapping' };
    } else if (this.problems.length) {
      const saveLocation = vscode.workspace.getConfiguration('cph').get<string>('general.saveLocation') ?? '';
      const cph = await readCphProblem(uri.fsPath, saveLocation);
      const match = cph ? matchCphProblem(cph, this.problems, this.cfg.baseUrl) : null;
      if (match) problem = { ...match, source: 'cph' };
    }
    if (seq !== this.refreshSeq) return;
    this.problem = problem;
    this.emit();
    if (problem) await this.loadSubmitPage(problem.id, false);
  }

  /** Languages for a problem (cached for a couple of minutes). */
  private async loadSubmitPage(problemId: number, force: boolean): Promise<void> {
    if (!this.client.isLoggedIn) {
      this.emit();
      return;
    }
    const cached = this.submitPages.get(problemId);
    if (!force && cached && Date.now() - cached.at < SUBMIT_PAGE_TTL_MS) {
      this.applySubmitPage(cached.page);
      return;
    }
    const seq = this.refreshSeq;
    this.languagesLoading = true;
    this.languagesError = null;
    this.emit();
    try {
      const page = await this.client.getSubmitPage(problemId);
      this.submitPages.set(problemId, { page, at: Date.now() });
      if (seq === this.refreshSeq || this.problem?.id === problemId) this.applySubmitPage(page);
    } catch (err) {
      this.languagesError = this.describe(err);
      if (err instanceof SessionExpiredError) this.accountStatus = 'logged-out';
    } finally {
      this.languagesLoading = false;
      this.emit();
    }
  }

  private applySubmitPage(page: SubmitPage): void {
    if (this.problem && this.problem.id === page.problemId) {
      if (page.problemName && this.problem.name.startsWith('#')) this.problem.name = page.problemName.replace(/^\[|\]$/g, '');
      if (page.problemFullName && !this.problem.fullName) this.problem.fullName = page.problemFullName;
    }
    const valid = page.languages.some((l) => l.id === this.selectedLanguageId);
    if (!valid && this.fileUri) {
      const c = chooseLanguage(this.fileUri.fsPath, page.languages, page.languageForced);
      this.selectedLanguageId = c.kind === 'match' ? c.language.id : null;
      this.languagesError =
        c.kind === 'not-allowed'
          ? `${c.wanted} is not allowed for this problem (allowed: ${c.allowed.map((l) => l.name).join(', ')}).`
          : null;
    } else {
      this.languagesError = null;
    }
    this.emit();
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

  async refreshProblems(force = true): Promise<void> {
    if (!force && this.problemsAt && Date.now() - this.problemsAt < PROBLEMS_TTL_MS) return;
    if (!(await this.ensureLoggedIn())) return;
    this.problemsLoading = true;
    this.problemsError = null;
    this.emit();
    try {
      this.problems = await this.client.listProblems();
      this.problemsAt = Date.now();
      if (this.problem) {
        const p = this.problems.find((x) => x.id === this.problem!.id);
        if (p) this.problem = { ...p, source: this.problem.source };
      }
    } catch (err) {
      this.problemsError = this.describe(err);
    } finally {
      this.problemsLoading = false;
      this.emit();
    }
    if (this.fileUri && !this.problem) await this.setActiveFile(this.fileUri);
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

  /** Command-palette flow: searchable QuickPick of /main/list. */
  async chooseProblemQuickPick(): Promise<void> {
    if (!this.fileUri) {
      void vscode.window.showInformationMessage('Open a source file first.');
      return;
    }
    await this.refreshProblems(false);
    if (!this.problems.length) return;
    const pick = await vscode.window.showQuickPick(
      this.problems.map((p) => ({
        label: p.name,
        description: p.fullName !== p.name ? p.fullName : undefined,
        detail: p.bestScore !== null ? `best ${p.bestScore}` : undefined,
        id: p.id,
      })),
      { placeHolder: `Grader problem for ${this.fileUri.path.split('/').pop()}`, matchOnDescription: true },
    );
    if (pick) await this.mapCurrentFile(pick.id);
  }

  problemById(id: number): Problem | undefined {
    return this.problems.find((p) => p.id === id) ?? (this.problem?.id === id ? this.problem : undefined);
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
      const page = await this.client.getSubmitPage(problem.id);
      this.submitPages.set(problem.id, { page, at: Date.now() });
      this.applySubmitPage(page);
      if (!page.canSubmit) throw new SubmitRejectedError('This problem is not open for your submissions.');

      // Exam hint (section 2b): a warning only, never remembered.
      let warned = false;
      if (page.contestPage) {
        const open = 'Open in Browser';
        const anyway = 'Submit Anyway';
        const pick = await vscode.window.showWarningMessage(EXAM_WARNING, { modal: true }, open, anyway);
        if (pick === open) await this.openProblemInBrowser(problem.id);
        if (pick !== anyway) return;
        warned = true;
      }

      let languageId = this.selectedLanguageId;
      if (languageId === null || !page.languages.some((l) => l.id === languageId)) {
        const c = chooseLanguage(fileUri.fsPath, page.languages, page.languageForced);
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
      const language = page.languages.find((l) => l.id === languageId)!;

      if (this.cfg.confirmBeforeSubmit && !warned) {
        const ok = 'Submit';
        const pick = await vscode.window.showInformationMessage(
          `Submit ${fileName} to ${problem.name} (#${problem.id}) as ${language.name}?`,
          { modal: true, detail: 'Turn this off with the setting "CEDT Grader: Confirm Before Submit".' },
          ok,
        );
        if (pick !== ok) return;
      }

      this.setResult(key, this.newResult(problem, 'submitting', 'Submitting…'));
      const sub = await this.client.submit(problem.id, languageId!, doc.getText(), { filename: fileName });
      this.updateResult(key, {
        phase: 'grading',
        submissionId: sub.submissionId,
        submissionUrl: this.url(`/submissions/${sub.submissionId}`),
        message: 'Waiting to be graded…',
      });
      await this.poll(key, problem, sub.submissionId, sub.pollUrl);
    } catch (err) {
      const msg = this.describe(err);
      const r = this.results.get(key);
      if (r && r.problemId === problem.id && (r.phase === 'submitting' || r.phase === 'grading')) {
        this.updateResult(key, { phase: 'error', message: msg });
      } else {
        this.setResult(key, this.newResult(problem, 'error', msg));
      }
      void this.showError(err, msg);
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

  private newResult(problem: Problem, phase: ResultView['phase'], message: string | null): ResultView {
    return {
      phase,
      problemId: problem.id,
      problemName: problem.name,
      submissionId: null,
      submissionUrl: null,
      score: null,
      scoreHidden: false,
      tries: null,
      time: null,
      comment: null,
      verdicts: [],
      compileError: false,
      compilerMessage: null,
      message,
    };
  }

  private async poll(key: string, problem: Problem, submissionId: number, pollUrl: string | null): Promise<void> {
    const abort = new AbortController();
    this.pollAbort = abort;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Grading ${problem.name} (#${submissionId})`, cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => abort.abort());
        try {
          const final = await this.client.pollLatest(problem.id, {
            submissionId,
            pollUrl,
            intervalMs: this.cfg.pollIntervalSeconds * 1000,
            signal: abort.signal,
            onUpdate: (s) => {
              if (s.id !== null && s.id < submissionId) return;
              progress.report({ message: s.state === 'graded' ? 'graded' : 'waiting…' });
              this.applyStatus(key, s, s.state === 'graded' ? 'done' : 'grading');
            },
          });
          this.applyStatus(key, final, 'done');
          if (final.compileError) {
            try {
              this.updateResult(key, { compilerMessage: await this.client.getCompilerMessage(submissionId) });
            } catch (err) {
              this.log(`Compiler message unavailable: ${this.describe(err)}`);
            }
          }
          await this.recordDone(problem, final);
        } catch (err) {
          if (abort.signal.aborted) {
            this.updateResult(key, { phase: 'timeout', message: 'Stopped waiting. Use "Show Last Result" or open the submission.' });
            return;
          }
          if (err instanceof PollTimeoutError) {
            this.updateResult(key, { phase: 'timeout', message: err.message });
            return;
          }
          throw err;
        }
      },
    );
  }

  private applyStatus(key: string, s: SubmissionStatus, phase: ResultView['phase']): void {
    const r = this.results.get(key);
    if (!r) return;
    this.updateResult(key, {
      phase,
      submissionId: s.id ?? r.submissionId,
      submissionUrl: s.id ? this.url(`/submissions/${s.id}`) : r.submissionUrl,
      score: s.score,
      scoreHidden: phase === 'done' && s.score === null,
      tries: s.tries,
      time: s.time,
      comment: s.comment,
      verdicts: s.verdicts,
      compileError: s.compileError,
      message: phase === 'done' ? (s.compileError ? 'Compilation error' : null) : 'Waiting to be graded…',
    });
  }

  private async recordDone(problem: Problem, s: SubmissionStatus): Promise<void> {
    if (s.id === null) return;
    await this.pushHistory(problem.id, {
      submissionId: s.id,
      url: this.url(`/submissions/${s.id}`),
      score: s.score,
      comment: s.comment,
      time: s.time ?? new Date().toLocaleTimeString(),
      compileError: s.compileError,
    });
    const p = this.problems.find((x) => x.id === problem.id);
    if (p && s.score !== null) p.bestScore = Math.max(p.bestScore ?? 0, s.score);
    if (this.problem?.id === problem.id && s.score !== null) {
      this.problem.bestScore = Math.max(this.problem.bestScore ?? 0, s.score);
    }
    this.emit();
  }

  /** Refresh the latest status of the current file's problem once (no polling loop). */
  async showLastResult(): Promise<void> {
    await vscode.commands.executeCommand('cedtGrader.panel.focus');
    const problem = this.problem;
    const key = this.fileUri?.fsPath;
    if (!problem || !key || this.busy) return;
    if (!(await this.ensureLoggedIn())) return;
    try {
      const s = await this.client.getLatestStatus(problem.id);
      if (s.state === 'none') {
        this.setResult(key, this.newResult(problem, 'done', 'No submissions yet.'));
        return;
      }
      this.setResult(key, this.newResult(problem, 'grading', null));
      this.applyStatus(key, s, s.state === 'graded' ? 'done' : 'timeout');
      if (s.state !== 'graded') this.updateResult(key, { message: 'Still being graded. Check again in a moment.' });
    } catch (err) {
      void this.showError(err, this.describe(err));
    }
  }

  async showCompilerMessage(): Promise<void> {
    const key = this.fileUri?.fsPath;
    const r = key ? this.results.get(key) : undefined;
    if (!key || !r?.submissionId) return;
    let msg = r.compilerMessage;
    if (msg === null) {
      try {
        msg = await this.client.getCompilerMessage(r.submissionId);
        this.updateResult(key, { compilerMessage: msg });
      } catch (err) {
        void this.showError(err, this.describe(err));
        return;
      }
    }
    const doc = await vscode.workspace.openTextDocument({ content: msg ?? '', language: 'log' });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }

  // ---------------------------------------------------------------- browser

  async openStatement(problemId?: number): Promise<void> {
    const id = problemId ?? this.problem?.id;
    if (!id) {
      void vscode.window.showInformationMessage('Choose a problem first.');
      return;
    }
    const p = this.problemById(id);
    await vscode.env.openExternal(vscode.Uri.parse(this.url(p?.statementUrl ?? `/problems/${id}/download/statement`)));
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
    if (err instanceof AuthError) return err.message;
    if (err instanceof SessionExpiredError) return err.message;
    if (err instanceof LanguageNotAllowedError) return err.message;
    if (err instanceof NetworkError) return `${err.message} Check your internet connection.`;
    if (err instanceof GraderError) return err.message;
    if (err instanceof Error) return `Unexpected error: ${err.message}`;
    return String(err);
  }

  private async showError(err: unknown, msg: string): Promise<void> {
    this.log(`Error: ${msg}`);
    const actions: string[] = [];
    if (err instanceof SessionExpiredError || err instanceof AuthError) actions.push('Log In');
    if (err instanceof NetworkError) actions.push('Show Log');
    const pick = await vscode.window.showErrorMessage(msg, ...actions);
    if (pick === 'Log In') await vscode.commands.executeCommand('cedtGrader.panel.focus');
    if (pick === 'Show Log') this.output.show();
  }
}
