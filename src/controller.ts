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
  type Attachment,
  type Credentials,
  describeImprovement,
  GraderClient,
  GraderError,
  type Language,
  LanguageNotAllowedError,
  languageForPath,
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
import { dirname, join, relative, sep } from 'node:path';
import {
  chooseTestcaseTarget,
  CPH_AUTO_SHOW_KEY,
  CPH_AUTO_SHOW_SECTION,
  CPH_EXTENSION_ID,
  CPH_RUN_COMMAND,
  cphAutoShowScope,
  CphPresence,
  saveTestcasesAsFiles,
  testsFolderFor,
} from './cphIntegration';
import { detectFolderRoles, type FolderRoles, type RunWhy, type SubmitWhy, submitFor } from './mapping/folderRoles';
import { stripGraderKey, TestcaseStore } from './data/testcaseStore';
import { cleanupCache, clearCacheFiles, enforceLimit, formatBytes, scanCache, statementIds, totalBytes } from './data/cacheFiles';
import { type BackupRecord, backupsToDelete, CLEAR_DEFAULTS, CLEAR_ORDER, type ClearCategory, keepIds, planClear, recordBackup } from './data/cacheClear';
import { cphProbPath as cphProbPathFor, readCphProblem } from './mapping/cph';
import { type GraderCase, importIntoCph, STATEMENT_ID_BASE } from './mapping/cphImport';
import { sampleCasesToImport } from './mapping/sampleImport';
import { type Pdfjs, pdfjsLoader, readSampleTables } from './data/pdfSamples';
import type { SampleTable } from './data/sampleTables';
import { createFileNoOverwrite, pathExists as exists } from './mapping/newFile';
import { chooseNewFileLanguage } from './mapping/newFileLanguage';
import { BINARY_EXTS, excludeGlob, filterSourceFiles, rankCandidates, sourceGlob } from './mapping/findByName';
import { buildMatchIndex, type IndexedFile, matchFile, OnceCache, type SourceFile } from './mapping/matchIndex';
import { EXTENSION_LANGUAGE } from './grader/languages';
import { stat as fsStat, readFile as fsReadFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { cphFilesAfterFolderRename, dismissKey, type LocatedEntry, moveCphProblem, reconnectCandidates, remapPath, submitFilePath } from './mapping/mappingOps';
import { cleanName, fileNameFor, folderNameFor, type MatchSource, placeholder, resolveProblem } from './mapping/match';
import type { MappingEntry } from './mapping/mappingFile';
import { attachmentKind, AttachmentError, fileToOpen, freeFolderName, planZip, submitCandidates, writeExtracted, writeNewFile } from './mapping/attachment';
import { MappingStore } from './mapping/store';
import { comparePaths, linkedNotice, mergeProblemFiles, noticeDismissed, noticeSignature, type ProblemFile } from './mapping/problemFiles';
import { isAtOrInside, pathKey } from './mapping/paths';
import { confirmSuggestion, submitQuestion } from './mapping/suggestionGate';
import { freeName, invalidFileName, nameMatchesProblem, renameProposal } from './mapping/renameToProblem';
import { ATTACHMENT, CACHE, LIMITS, TIMING, troubleshootingUrl, WEB_PATHS } from './shared/constants';
import { needsSave, shouldRevealResult } from './shared/submitOptions';
import { HOW_LINKED, MATCH_SOURCE, PICK_HOW, S } from './shared/strings';
import { KEYS } from './shared/stateKeys';
import { cleanTagFilter, otherTags } from './shared/tags';
import { currentLang, dateLocale, resolveLang, setLanguage } from './shared/i18n';
import type { HistoryEntry, ProblemFilter, ProblemView, ResultView, SubmissionDetailView, ViewState } from './shared/messages';

/** Dismissed "files for this problem" notices: problem id → notice signature (workspaceState; "Clear Cached Data" resets it). */
export const DISMISSED_NOTICES_KEY = KEYS.dismissedNotices;

/** URI scheme serving the source of a past submission (for the diff view). */
export const SUBMISSION_SCHEME = 'cedt-grader-submission';

const LANGUAGE_KEY = KEYS.languageByFile;
const DISMISSED_KEY = KEYS.dismissedReconnects;
const CLEANUP_KEY = KEYS.lastCleanup;
const TESTCASE_TARGET_KEY = KEYS.testcaseTarget;
const NEWFILE_LANG_KEY = KEYS.lastNewFileLanguage;
const FILTER_KEY = KEYS.problemFilter;
const OPENED_KEY = KEYS.recentlyOpened;
const CPH_TIP_KEY = KEYS.cphTipDismissed;
const CPH_AUTO_SHOW_DISMISSED_KEY = KEYS.cphAutoShowDismissed;
const REMEMBER_KEY = KEYS.rememberPassword;

type Listener = (s: ViewState) => void;

/** Why a folder's submit / run file is what it is (tooltip in the card). */
type RoleWhy = SubmitWhy | RunWhy | 'chosen' | 'only-file';
/** C/C++ sources and headers (role detection reads these). */
const CODE_FILE = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i;
/** C/C++ sources (run file choices). */
const CODE_SOURCE = /\.(c|cc|cpp|cxx)$/i;

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
  private matchInfo: { suggestions: Problem[]; ambiguous: Problem[] | null; ambiguousSource: 'cph' | 'filename' | 'folder' | 'suggested' | null } = {
    suggestions: [],
    ambiguous: null,
    ambiguousSource: null,
  };
  /** Problems the grader no longer offers (missing from the list, or 404/403 this session). */
  private readonly unavailableIds = new Set<number>();
  /** The active file was explicitly unlinked (auto-detection is off for it). */
  private notLinked = false;
  /** Folder mode: the folder link the active file belongs to (null: the file is on its own). */
  private folderLink: { fsPath: string; entry: MappingEntry } | null = null;
  /** The folder is only matched by its name (not saved): folder mode as if linked; a choice saves the link. */
  private folderMatched = false;
  /** Folder mode: the linked folder's source files (relative paths), the choices for the submit file. */
  private folderFiles: string[] = [];
  /** Folder mode: the folder's C/C++ texts and the detected submit / run files (folderRoles.ts). */
  private folderTexts = new Map<string, string>();
  private folderRoles: FolderRoles | null = null;
  /** Files for the current problem (duplicate notice): saved links, remembered auto-matches, name matches. */
  private linkedFiles: ProblemFile[] = [];
  /**
   * Problem → files with the ONE matcher (matchIndex.ts): one workspace.findFiles of source
   * files, cached until a file is created / deleted / renamed (debounced) or the list reloads.
   */
  private readonly matchIndex = new OnceCache<Map<number, IndexedFile[]>>(() => this.buildIndex(), () => new Map());
  /**
   * Temporary link (row click opened a name-matched / suggested file): the panel shows that
   * problem for the file, marked "Suggested · Use this", until another file becomes active.
   */
  private tempLink: { key: string; problemId: number } | null = null;
  private fileEventTimer: ReturnType<typeof setTimeout> | undefined;
  /** CPH tip: "Not now" hides it for this session. */
  private cphTipHidden = false;
  /** The "CPH opens its panel on every switch" question was answered this session (or is showing). */
  private cphAutoShowAsked = false;
  /** Inline question in the panel (calm alternative to modal dialogs). */
  private prompt: InlinePrompt | null = null;
  private promptResolve: ((v: string | undefined) => void) | null = null;
  private promptSeq = 0;
  /** Problems with at least one mapped file (for "go to file"). */
  private mappedIds = new Set<number>();
  private testcasesBusy = false;
  private samplesBusy = false;
  /** The cached statement of the current problem is not a PDF (no "Load samples" button). Unknown = false. */
  private statementNoPdf = false;
  /** The problem the statement tab last followed (undefined: not yet). */
  private followedProblemId: number | null | undefined = undefined;
  /** Statement PDFs / descriptions on disk (shared by the statement tabs and "Load sample cases"). */
  private readonly statementStore: StatementStore;
  /** pdf.js (legacy build, dist/pdfjs) for "Load sample cases": imported on first use only. */
  private readonly pdfjs: () => Promise<Pdfjs>;
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
  /** Cache size-limit runs, one at a time. */
  private cacheJob: Promise<void> = Promise.resolve();

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
    this.testcases = new TestcaseStore(ctx.globalStorageUri.fsPath, () => this.client, (l) => this.requestLog(l), (p) => this.cacheWritten(p));
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
    this.statementStore = new StatementStore(ctx.globalStorageUri.fsPath, () => this.client, (l) => this.requestLog(l), (p) => {
      this.cacheWritten(p);
      void this.refreshStatementKind();
    });
    this.pdfjs = pdfjsLoader(vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'pdfjs').fsPath);
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
      this.matchIndex.invalidate(); // the index depends on the problem list
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
    await this.ctx.workspaceState.update(`${KEYS.problemsPrefix}:${this.cfg.baseUrl}:${this.cfg.username}`, undefined);
    await this.dailyCleanup();
    await this.cleanupDuplicateLinks();
    this.warnBadPattern();
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
      void this.maybeAskCphAutoShow();
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
    if (prev.displayLanguage !== this.cfg.displayLanguage) this.applyLanguage();
    if (prev.fileNamePattern.pattern !== this.cfg.fileNamePattern.pattern || prev.fileNamePattern.problem !== this.cfg.fileNamePattern.problem) {
      // The matcher uses the pattern: rebuild the index and re-match the open file.
      this.matchIndex.invalidate();
      this.warnBadPattern();
      if (this.fileUri) void this.setActiveFile(this.fileUri);
    }
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
    return `${KEYS.problemsPrefix}.v2:${this.cfg.baseUrl}:${this.cfg.username}`;
  }

  private secretKey(kind: 'password' | 'token', username = this.cfg.username): string {
    return `cedtGrader.${kind}:${this.cfg.baseUrl}:${username}`;
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

  // ----------------------------------------------------------- folder mode

  /**
   * Folder mode: the file Submit sends and the file CPH runs (relative to the
   * folder), with why: the user's choice, else detected (folderRoles.ts),
   * else the folder's only source file; null = asked when needed.
   */
  private folderRole(role: 'submit' | 'run'): { file: string; why: RoleWhy } | null {
    const link = this.folderLink;
    if (!link) return null;
    const has = (f: string | undefined) => !!f && this.folderFiles.some((x) => pathKey(x) === pathKey(f));
    const chosen = role === 'submit' ? link.entry.submitFile : link.entry.runFile;
    if (has(chosen)) return { file: chosen!, why: 'chosen' };
    const roles = this.folderRoles;
    if (role === 'run') return roles?.run ?? null;
    // A run file chosen by the user decides which header is the submit file.
    const runChosen = has(link.entry.runFile) ? submitFor(this.folderTexts, link.entry.runFile!) : null;
    const detected = runChosen ?? roles?.submit ?? null;
    if (detected) return detected;
    return this.folderFiles.length === 1 ? { file: this.folderFiles[0], why: 'only-file' } : null;
  }

  /** Folder mode for `link` (null = off): its source files, their texts and the detected roles. */
  private async loadFolder(link: { fsPath: string; entry: MappingEntry } | null): Promise<void> {
    this.folderLink = link;
    this.folderFiles = link ? await this.folderSources(link.fsPath) : [];
    this.folderTexts = link ? await this.folderTextsOf(link.fsPath, this.folderFiles) : new Map();
    this.folderRoles = link ? detectFolderRoles(this.folderTexts) : null;
  }

  /**
   * Remember the user's submit / run file for the folder (undefined = detect
   * again). A folder only matched by its name gets its link saved with it.
   */
  private async saveFolderRole(key: 'submitFile' | 'runFile', rel: string | undefined): Promise<void> {
    const link = this.folderLink;
    if (!link) return;
    const folder = vscode.Uri.file(link.fsPath);
    if (this.folderMatched) {
      if (!rel) return; // automatic already
      await this.mapping.set(folder, { ...link.entry, [key]: rel });
      this.folderMatched = false;
      await this.refreshMappedIds();
    } else await this.mapping.setFolderRole(folder, this.cfg.baseUrl, key, rel);
    this.folderLink = { ...link, entry: { ...link.entry, [key]: rel } };
  }

  /** The card's folder-mode block (submit / run file with why). */
  private folderView(): ViewState['folder'] {
    const link = this.folderLink;
    if (!link) return null;
    const sub = this.folderRole('submit');
    const run = this.folderRole('run');
    const why = (w: RoleWhy | undefined, run?: string) => (w ? S.folder.why[w](run ?? '') : null);
    return {
      path: `${vscode.workspace.asRelativePath(link.fsPath, false)}/`,
      matched: this.folderMatched,
      submitFile: sub?.file ?? null,
      submitWhy: why(sub?.why, run?.file),
      submitChosen: sub?.why === 'chosen',
      runFile: run?.file ?? null,
      runWhy: why(run?.why),
      runChosen: run?.why === 'chosen',
      candidates: this.folderFiles,
      runCandidates: this.folderFiles.filter((f) => CODE_SOURCE.test(f)),
    };
  }

  private submitFileRel(): string | null {
    return this.folderRole('submit')?.file ?? null;
  }

  /** The file Submit sends: folder mode → the folder's submit file (null until known); otherwise the active file. */
  private targetUri(): vscode.Uri | null {
    if (!this.folderLink) return this.fileUri;
    const p = submitFilePath(this.folderLink.fsPath, this.submitFileRel() ?? undefined);
    return p ? vscode.Uri.file(p) : null;
  }

  /** The file test cases belong to and CPH runs: folder mode → the run file (null until known); otherwise the active file. */
  private runUri(): vscode.Uri | null {
    if (!this.folderLink) return this.fileUri;
    const p = submitFilePath(this.folderLink.fsPath, this.folderRole('run')?.file);
    return p ? vscode.Uri.file(p) : null;
  }

  /** Source files of a linked folder (relative, "/" separators, path order; build output and binaries skipped). */
  private async folderSources(folder: string): Promise<string[]> {
    const all = await readdir(folder, { recursive: true }).catch(() => [] as string[]);
    const rels = all.slice(0, ATTACHMENT.maxEntries).map((r) => String(r).split(sep).join('/'));
    const exts = this.allSourceExts();
    return submitCandidates(filterSourceFiles(rels, exts), exts);
  }

  /** The C/C++ texts of a folder's source files (role detection), each read up to a size cap. */
  private async folderTextsOf(folder: string, files: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const rel of files.filter((f) => CODE_FILE.test(f))) {
      const p = join(folder, ...rel.split('/'));
      const st = await fsStat(p).catch(() => null);
      if (st && st.size <= ATTACHMENT.maxRoleFileBytes) out.set(rel, await fsReadFile(p, 'utf8').catch(() => ''));
    }
    return out;
  }

  /** The folder "Link the whole folder" would link for the active file, or why it can't. */
  private folderModeTarget(): { dir: vscode.Uri | null; reason: string | null } {
    const file = this.fileUri;
    if (!file) return { dir: null, reason: S.folder.openFile };
    const dir = vscode.Uri.joinPath(file, '..');
    const ws = vscode.workspace.getWorkspaceFolder(file);
    if (!ws) return { dir: null, reason: S.folder.outsideWorkspace };
    if (pathKey(ws.uri.fsPath) === pathKey(dir.fsPath)) return { dir: null, reason: S.folder.atRoot };
    return { dir, reason: null };
  }

  /**
   * Switch the current problem between "this file" and "the whole folder"
   * (command, header icon, header menu). File → folder: the active file's
   * folder is linked; its submit / run files are detected (when no submit
   * file is found, the active file is it). Folder → file: the folder link goes
   * and the submit file (else the active file) is linked on its own.
   */
  async toggleFolderMode(): Promise<void> {
    const file = this.fileUri;
    const problem = this.currentProblem();
    if (!file || !problem) {
      void vscode.window.showInformationMessage(file ? S.submit.chooseFirst : S.submit.openToSubmit);
      return;
    }
    const entry = { problemId: problem.id, name: problem.name, baseUrl: this.cfg.baseUrl };
    if (this.folderLink && !this.folderMatched) {
      const folder = vscode.Uri.file(this.folderLink.fsPath);
      const keep = this.targetUri() ?? file;
      await this.mapping.set(folder, undefined);
      await this.mapping.set(keep, entry);
      await this.setActiveFile(file);
      void vscode.window.setStatusBarMessage(S.folder.nowFile(keep.path.split('/').pop() ?? ''), TIMING.statusMessageMs);
      return;
    }
    const { dir, reason } = this.folderModeTarget();
    if (!dir) {
      void this.askInline(reason ?? S.folder.atRoot, [{ id: 'ok', label: S.common.ok }]);
      return;
    }
    const existing = await this.mapping.get(dir, this.cfg.baseUrl);
    if (existing?.folder && existing.problemId !== problem.id) {
      const pick = await this.askInline(S.folder.replaceQ(vscode.workspace.asRelativePath(dir), existing.name || `#${existing.problemId}`, problem.name), [
        { id: 'replace', label: S.folder.replace, primary: true },
        { id: 'cancel', label: S.common.cancel },
      ]);
      if (pick !== 'replace') return;
    }
    // Links of files inside to this same problem are now covered by the folder; links to other problems stay (they win).
    for (const l of await this.mapping.linksFor(problem.id, this.cfg.baseUrl)) {
      if (!l.folder && isAtOrInside(l.uri.fsPath, dir.fsPath)) await this.mapping.set(l.uri, undefined);
    }
    const files = await this.folderSources(dir.fsPath);
    const detected = detectFolderRoles(await this.folderTextsOf(dir.fsPath, files)).submit;
    const own = relative(dir.fsPath, file.fsPath).split(sep).join('/');
    await this.mapping.set(dir, { ...entry, folder: true, ...(detected || files.length === 1 ? {} : { submitFile: own }) });
    await this.mapping.setUnlinked(file, false); // an explicit choice clears "not linked"
    this.tempLink = null;
    await this.refreshMappedIds();
    await this.setActiveFile(file);
    void vscode.window.setStatusBarMessage(S.folder.nowFolder(vscode.workspace.asRelativePath(dir)), TIMING.statusMessageMs);
  }

  /**
   * The file that stands for a folder item (row click, notice, newer-file
   * check): its submit file (chosen or detected), else the run file, else
   * the first source file; null when it has none.
   */
  private async folderItemFile(folder: string): Promise<string | null> {
    if (!(await fsStat(folder).catch(() => null))?.isDirectory()) return null;
    const e = await this.mapping.get(vscode.Uri.file(folder), this.cfg.baseUrl);
    const files = await this.folderSources(folder);
    if (!files.length) return null;
    const chosen = e?.folder && e.submitFile && files.includes(e.submitFile) ? e.submitFile : null;
    const roles = chosen ? null : detectFolderRoles(await this.folderTextsOf(folder, files));
    const pick = chosen ?? roles?.submit?.file ?? roles?.run?.file ?? files[0];
    return join(folder, ...pick.split('/'));
  }

  /** Open a file, or the stand-in file of a folder. */
  private async openItem(fsPath: string): Promise<void> {
    const file = (await this.folderItemFile(fsPath)) ?? fsPath;
    if ((await fsStat(file).catch(() => null))?.isDirectory()) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(file));
    else await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  /** Folder mode: the user picks the submit / run file in the card ('' = automatic again). */
  async setFolderRole(role: 'submit' | 'run', rel: string): Promise<void> {
    if (!this.folderLink || (rel && !this.folderFiles.includes(rel))) return;
    await this.saveFolderRole(role === 'submit' ? 'submitFile' : 'runFile', rel || undefined);
    if (this.fileUri) await this.setActiveFile(this.fileUri);
  }

  /** Folder mode: ask once (only when detection found nothing) which file Submit sends / CPH runs. Saved with the folder link. */
  private async askFolderRole(role: 'submit' | 'run', problem: Problem, near?: 'submit'): Promise<string | null> {
    const link = this.folderLink;
    if (!link) return null;
    const known = this.folderRole(role)?.file;
    if (known) return known;
    const files = role === 'submit' ? this.folderFiles : this.folderRoles?.runCandidates.length ? this.folderRoles.runCandidates : this.folderFiles.filter((f) => CODE_SOURCE.test(f));
    if (!files.length) {
      void this.askInline(S.folder.noSources(vscode.workspace.asRelativePath(link.fsPath)), [{ id: 'ok', label: S.common.ok }], { tone: 'warn', near });
      return null;
    }
    let pick: string | undefined;
    const text = role === 'submit' ? S.folder.whichFile(problem.name) : S.folder.whichRunFile(problem.name);
    const detail = role === 'submit' ? S.folder.oneFile : S.folder.runFileDetail;
    if (files.length <= ATTACHMENT.maxInlineChoices) {
      const id = await this.askInline(text, [...files.map((f, i) => ({ id: String(i), label: f })), { id: 'cancel', label: S.common.cancel }], { detail, near });
      pick = id !== undefined && id !== 'cancel' ? files[Number(id)] : undefined;
    } else {
      pick = (await vscode.window.showQuickPick(files, { placeHolder: `${text} ${detail}` })) ?? undefined;
    }
    if (!pick) return null;
    await this.saveFolderRole(role === 'submit' ? 'submitFile' : 'runFile', pick);
    return pick;
  }

  /**
   * Folder mode, another source file of the folder is open (e.g. main.cpp):
   * "Submit student.h" (the submit file) or "Submit main.cpp (open file)".
   * Asked when the submit file is only detected (then the answer is saved as
   * the folder's choice, so it isn't asked again). true = answered, false =
   * not asked, null = cancelled.
   */
  private async askSubmitFileOrOpen(problem: Problem): Promise<boolean | null> {
    const link = this.folderLink;
    const open = this.fileUri;
    const target = this.targetUri();
    if (!link || !open || !target || pathKey(open.fsPath) === pathKey(target.fsPath)) return false;
    const rel = (u: vscode.Uri) => relative(link.fsPath, u.fsPath).split(sep).join('/');
    const openRel = rel(open);
    const targetRel = rel(target);
    if (!this.folderFiles.includes(openRel)) return false;
    if (link.entry.submitFile) return false; // chosen: never asked again
    const pick = await this.askInline(
      S.submit.whichFileQ(problem.name, problem.id),
      [
        { id: 'target', label: S.submit.submitNamed(targetRel), primary: true },
        { id: 'open', label: S.submit.submitOpen(openRel) },
        { id: 'cancel', label: S.common.cancel },
      ],
      { detail: S.submit.whichFileDetail, near: 'submit' },
    );
    if (pick !== 'target' && pick !== 'open') return null;
    const chosen = pick === 'open' ? openRel : targetRel;
    if (link.entry.submitFile !== chosen) await this.setFolderRole('submit', chosen); // remembered; the card's Submits shows it
    return true;
  }

  // ----------------------------------------------------------- run tests (CPH)

  /** Tests in CPH for the run file (null: CPH not installed / no file). Read on file switch and after loading test cases. */
  private runTestCount: number | null = null;

  private async refreshRunTests(): Promise<void> {
    const run = this.runUri();
    const before = this.runTestCount;
    this.runTestCount = this.cph.installed && run ? ((await readCphProblem(run.fsPath, this.cphSaveLocation()))?.tests.length ?? 0) : null;
    if (before !== this.runTestCount) this.emit();
  }

  /**
   * "Run tests" (only with CPH): save the files of the folder (or the file),
   * show the run file (CPH runs the active editor and reloads its tests only
   * when the active editor changes), then CPH's run command. Folder mode runs
   * the driver (main.cpp), which includes the submit file from the folder.
   */
  async runTests(): Promise<void> {
    if (!this.cph.installed) return;
    const problem = this.currentProblem();
    if (this.folderLink && problem && !(await this.askFolderRole('run', problem))) return;
    const run = this.runUri();
    if (!run) {
      void vscode.window.showInformationMessage(S.submit.openToSubmit);
      return;
    }
    const tests = (await readCphProblem(run.fsPath, this.cphSaveLocation()))?.tests.length ?? 0;
    if (!tests) {
      const pick = await this.askInline(S.runTests.noTests, [
        ...(problem?.hasTestcase ? [{ id: 'load', label: S.testcases.load, primary: true }] : []),
        { id: 'cancel', label: S.common.cancel },
      ]);
      if (pick === 'load') await this.loadTestcases(false);
      return;
    }
    const scope = this.folderLink?.fsPath;
    for (const d of vscode.workspace.textDocuments) {
      if (d.isDirty && !d.isUntitled && (scope ? isAtOrInside(d.uri.fsPath, scope) : d.uri.toString() === run.toString())) await d.save();
    }
    if (vscode.window.activeTextEditor?.document.uri.toString() === run.toString()) await this.reloadCph(run);
    else await vscode.window.showTextDocument(run, { preview: false });
    await vscode.commands.executeCommand(CPH_RUN_COMMAND);
  }

  // ----------------------------------------------------------- attachments

  /**
   * The problem's attachment (the website's "File"), only on click: a single
   * file is saved next to the active file (or in the workspace root) and may
   * be renamed to match the problem; a zip is extracted into a NEW folder,
   * after one question that also offers folder mode. Never overwrites.
   */
  async downloadAttachment(problemId?: number): Promise<void> {
    const id = problemId ?? this.currentProblem()?.id;
    const p = id === undefined ? undefined : this.problemById(id);
    if (!p) {
      void vscode.window.showInformationMessage(S.submit.chooseFirst);
      return;
    }
    const dir = (this.fileUri ? vscode.Uri.joinPath(this.fileUri, '..') : undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!dir) {
      void vscode.window.showInformationMessage(S.files.openFolderFirst);
      return;
    }
    if (!(await this.ensureLoggedIn())) return;
    let a: Awaited<ReturnType<DataService['downloadAttachment']>>;
    try {
      const pending = this.data.downloadAttachment(p.id);
      this.emit(); // busy
      a = await pending;
    } catch (err) {
      if (err instanceof ProblemUnavailableError) this.markUnavailable(p.id);
      if (classifyConnectionError(err)) this.reportError(err, null);
      else await this.tellInline(err, this.describe(err));
      return;
    } finally {
      this.emit();
    }
    if (a.status !== 200) {
      await this.tellInline(null, S.attachment.none(p.name));
      return;
    }
    try {
      if (attachmentKind(a.filename, a.contentType, a.bytes) === 'zip') await this.extractAttachment(p, dir, a);
      else await this.saveAttachmentFile(p, dir, a);
    } catch (err) {
      await this.tellInline(err, err instanceof AttachmentError ? err.message : S.attachment.writeFailed(this.describe(err)));
    }
  }

  /** An error the user should read once: inline in the panel, a toast only when the panel is hidden. */
  private async tellInline(err: unknown, msg: string): Promise<void> {
    this.log(msg);
    if (this.data.isVisible()) void this.askInline(msg, [{ id: 'ok', label: S.common.ok }], { tone: 'warn' });
    else await this.showError(err, msg);
  }

  /** A single-file attachment: saved under its own name (`_2` if taken), opened, then "Rename to match the problem?". */
  private async saveAttachmentFile(p: Problem, dir: vscode.Uri, a: Attachment): Promise<void> {
    const ext = a.filename?.includes('.') ? a.filename.split('.').pop()! : 'txt';
    const desired = a.filename ?? fileNameFor(p.name, ext, this.cfg.fileNamePattern.pattern, p.id);
    const name = await freeName(desired, (n) => exists(vscode.Uri.joinPath(dir, n).fsPath));
    let target = vscode.Uri.joinPath(dir, name);
    await writeNewFile(target.fsPath, a.bytes);
    const source = this.allSourceExts().includes(ext.toLowerCase());
    if (source) await this.mapping.set(target, { problemId: p.id, name: p.name, baseUrl: this.cfg.baseUrl });
    await this.openDownloaded(target, source);
    if (!source || nameMatchesProblem(target.fsPath, p.name, this.cfg.fileNamePattern.pattern, p.id)) return;
    const proposal = await freeName(renameProposal(target.fsPath, p.name, this.cfg.fileNamePattern.pattern, p.id), (n) => exists(vscode.Uri.joinPath(dir, n).fsPath));
    const pick = await this.askInline(S.attachment.renameQ(name, proposal), [
      { id: 'rename', label: S.attachment.rename, primary: true },
      { id: 'keep', label: S.attachment.keepName },
    ]);
    if (pick !== 'rename') return;
    const to = vscode.Uri.joinPath(dir, proposal);
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(target, to, { overwrite: false });
    if (await vscode.workspace.applyEdit(edit)) target = to; // links and editors follow (onDidRenameFiles)
    else void vscode.window.showWarningMessage(S.rename.failed(proposal));
  }

  private async openDownloaded(uri: vscode.Uri, text: boolean): Promise<void> {
    try {
      if (text) await vscode.window.showTextDocument(uri);
      else await vscode.commands.executeCommand('vscode.open', uri);
    } catch {
      await vscode.commands.executeCommand('revealInExplorer', uri);
    }
  }

  /**
   * A zip attachment: checked completely in memory first (paths, sizes), then
   * one question: extract into "<problem name>/" and link it (folder mode),
   * extract under its own name without linking, or cancel. A new folder only.
   */
  private async extractAttachment(p: Problem, dir: vscode.Uri, a: Attachment): Promise<void> {
    const plan = planZip(a.bytes);
    const taken = (n: string) => exists(vscode.Uri.joinPath(dir, n).fsPath);
    const linkedName = await freeFolderName(folderNameFor(p.name, this.cfg.fileNamePattern.pattern, p.id), taken);
    const ownStem = (plan.topFolder ?? (a.filename ?? 'attachment').replace(/\.zip$/i, '')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'attachment';
    const ownName = await freeFolderName(ownStem, taken);
    const names = plan.files.map((f) => f.rel);
    const pick = await this.askInline(
      S.attachment.extractQ(a.filename ?? 'zip', plan.files.length, vscode.workspace.asRelativePath(dir) || '.'),
      [
        { id: 'link', label: S.attachment.extractAndLink(linkedName), primary: true },
        ...(ownName !== linkedName ? [{ id: 'own', label: S.attachment.extractOnly(ownName) }] : []),
        { id: 'cancel', label: S.common.cancel },
      ],
      { detail: S.attachment.contents(names.slice(0, 6).join(', '), names.length) },
    );
    if (pick !== 'link' && pick !== 'own') return;
    const folder = vscode.Uri.joinPath(dir, pick === 'link' ? linkedName : ownName);
    await writeExtracted(folder.fsPath, plan.files);
    this.onFileEvent();
    const candidates = submitCandidates(names, this.allSourceExts());
    // Submit / run files are detected from the folder (folderRoles.ts); open the file to edit.
    const roles = detectFolderRoles(new Map(plan.files.filter((f) => CODE_FILE.test(f.rel)).map((f) => [f.rel, new TextDecoder().decode(f.data)])));
    if (pick === 'link') {
      await this.mapping.set(folder, { problemId: p.id, name: p.name, baseUrl: this.cfg.baseUrl, folder: true });
      await this.refreshMappedIds();
    }
    await vscode.commands.executeCommand('revealInExplorer', folder);
    const open = roles.submit?.file ?? roles.run?.file ?? fileToOpen(plan.files, candidates);
    if (open) await this.openDownloaded(vscode.Uri.joinPath(folder, ...open.split('/')), true);
    else this.emit();
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
    const target = this.targetUri();
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
      hasFile: this.mappedIds.has(p.id),
      hasTestcase: p.hasTestcase,
      hasAttachment: p.hasAttachment,
      status: problemStatus(p),
      tags: p.tags ?? [],
      lastSubmissionTime: p.lastSubmissionTime,
      lastOpened: this.ctx.workspaceState.get<Record<string, number>>(OPENED_KEY, {})[p.id] ?? null,
    };
  }

  state(): ViewState {
    const file = this.fileUri;
    const target = this.targetUri();
    const lang = target ? languageNameForPath(target.fsPath, this.languages) : null;
    const loggedIn = this.accountStatus === 'logged-in';
    const problem = this.currentProblem();
    const languagesLoading = this.data.cache.peek('languages') === undefined && loggedIn && !!problem && this.data.isVisible();

    const unavailable = !!problem && this.unavailableIds.has(problem.id);
    const mismatch = problem && !unavailable ? this.languageMismatch(problem) : null;
    let reason: string | null = null;
    if (this.busy) reason = null;
    else if (!file) reason = S.submit.openToSubmit;
    else if (!loggedIn && !this.hasSavedPassword) reason = S.submit.logInFirst;
    else if (!problem) reason = S.submit.chooseProblemForFile;
    else if (unavailable) reason = S.submit.unavailable;
    else if (mismatch) reason = S.submit.notAccepted(mismatch.wanted);
    else if (this.languagesError) reason = this.languagesError;

    const enabled = !this.busy && !!file && !!problem && (loggedIn || this.hasSavedPassword) && !mismatch && !unavailable;
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
      },
      file: file
        ? {
            path: vscode.workspace.asRelativePath(file, false),
            name: file.path.split('/').pop() ?? '',
            languageGuess: lang,
            supported: lang !== null,
            // Folder mode / matched by the folder's name: the folder carries the name, not the file.
            renameTo: problem && !this.folderLink && problem.source !== 'folder' && !problem.name.startsWith('#') && !nameMatchesProblem(file.fsPath, problem.name, this.cfg.fileNamePattern.pattern, problem.id) ? renameProposal(file.fsPath, problem.name, this.cfg.fileNamePattern.pattern, problem.id) : null,
          }
        : null,
      problem: problem ? { ...this.problemView(problem), source: problem.source, sourceLabel: MATCH_SOURCE[problem.source], unavailable } : null,
      // Explicitly unlinked, or no confident match (candidates are only offered in the picker).
      notLinked: !problem && !!file && (this.notLinked || (!!this.data.problemList()?.problems.length && !this.matchInfo.ambiguous)),
      prompt: this.prompt,
      ...(() => {
        const hidden = !!problem && noticeDismissed(this.ctx.workspaceState.get<Record<string, string>>(DISMISSED_NOTICES_KEY, {}), problem.id, this.linkedFiles);
        const n = problem && file && !hidden ? linkedNotice(this.linkedFiles, file.fsPath, (f) => vscode.workspace.asRelativePath(f)) : null;
        return { linkedFiles: n ? n.files.map(({ path, current, how }) => ({ path, current, how })) : [], linkedNotice: n?.text ?? null };
      })(),
      folder: this.folderView(),
      runTests: this.cph.installed && problem && file ? { disabledReason: this.runTestCount ? null : S.runTests.noTestsShort } : null,
      folderMode: problem && file ? { on: !!this.folderLink && !this.folderMatched, disabledReason: this.folderLink ? null : this.folderModeTarget().reason } : null,
      attachment: { busy: problem && this.data.isDownloading(problem.id) ? problem.id : null },
      cphTip:
        !this.cph.installed && !this.cphTipHidden && !this.ctx.globalState.get<boolean>(CPH_TIP_KEY, false) && !!problem?.hasTestcase,
      matching: {
        suggestions: this.matchInfo.suggestions.map((p) => this.problemView(p)),
        ambiguous: this.matchInfo.ambiguous?.map((p) => this.problemView(p)) ?? null,
        note: this.matchInfo.ambiguous
          ? this.matchInfo.ambiguousSource === 'suggested'
            ? S.match.severalCould
            : this.matchInfo.ambiguousSource === 'folder'
              ? S.match.severalMatchFolder
              : S.match.severalMatch(this.matchInfo.ambiguousSource === 'cph')
          : null,
      },
      testcases: { busy: this.testcasesBusy },
      samples: { busy: this.samplesBusy, available: !this.statementNoPdf },
      cph: { installed: this.cph.installed },
      languages: {
        loading: languagesLoading,
        items: problem ? this.allowedLanguages(problem).map((l) => ({ id: l.id, name: l.name })) : [],
        selectedId: this.selectedLanguageId,
        mismatch,
      },
      connection: this.connection,
      submit: { enabled, busy: this.busy, reason, label: S.submitLabel },
      result: target ? (this.results.get(target.fsPath) ?? null) : null,
      gradingElsewhere:
        this.busy && this.gradingFile !== null && this.gradingFile !== target?.fsPath
          ? (this.results.get(this.gradingFile)?.problemName ?? S.submit.anotherFile)
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
        tags: otherTags(list?.problems ?? [], this.topics(list), this.problemFilter().tags ?? []),
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
        label: S.submit.testLabel(i + 1, resultWord(e.result)),
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
      ...cleanTagFilter(f.tags, f.tagMode),
    });
    this.emit();
  }

  /** Topic pills: the website's topic tags when known, otherwise every tag in use. */
  /** Topic pills: the website's topic tags (from /main/list). Unknown → none, and every tag goes to the "Tags" dropdown. */
  private topics(list: import('./grader').ProblemList | undefined): { name: string; description: string | null }[] {
    return list?.topics?.length ? list.topics : [];
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
  askInline(text: string, buttons: InlinePrompt['buttons'], opts: { detail?: string; tone?: 'info' | 'warn'; near?: 'submit' } = {}): Promise<string | undefined> {
    this.promptResolve?.(undefined);
    const id = ++this.promptSeq;
    this.prompt = { id, text, detail: opts.detail ?? null, tone: opts.tone ?? 'info', buttons, near: opts.near ?? null };
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

  /**
   * CPH's "Auto Show Judge" (on by default) opens CPH's panel on every switch to a
   * source file, which can cover this one. Ask once per session, in the panel, only
   * while the panel is visible and nothing else is being asked. A question cancelled
   * by a file switch or another question comes back later; "Keep it" = this session,
   * "Don't ask again" = never.
   */
  private async maybeAskCphAutoShow(): Promise<void> {
    if (this.cphAutoShowAsked || this.prompt || !this.cph.installed || !this.fileUri || !this.data.isVisible()) return;
    if (this.ctx.globalState.get<boolean>(CPH_AUTO_SHOW_DISMISSED_KEY, false)) return;
    const cfg = vscode.workspace.getConfiguration(CPH_AUTO_SHOW_SECTION, this.fileUri);
    const scope = cphAutoShowScope(cfg.inspect(CPH_AUTO_SHOW_KEY));
    if (!scope) return;
    this.cphAutoShowAsked = true;
    const t = S.cphAutoShow;
    const pick = await this.askInline(t.question, [
      { id: 'off', label: t.turnOff, primary: true },
      { id: 'keep', label: t.keep },
      { id: 'never', label: t.never },
    ], { detail: t.detail });
    if (pick === undefined) {
      this.cphAutoShowAsked = false; // replaced or cancelled by a file switch: ask again later
      return;
    }
    if (pick === 'never') await this.ctx.globalState.update(CPH_AUTO_SHOW_DISMISSED_KEY, true);
    if (pick !== 'off') return;
    // Turn it off where it is turned on (a workspace value would override a user-level change).
    const target =
      scope === 'workspaceFolder' ? vscode.ConfigurationTarget.WorkspaceFolder : scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    try {
      await cfg.update(CPH_AUTO_SHOW_KEY, false, target);
      void this.askInline(t.done, [{ id: 'ok', label: S.common.ok }]);
    } catch (err) {
      void this.askInline(t.failed(this.describe(err)), [{ id: 'ok', label: S.common.ok }], { tone: 'warn' });
    }
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
      this.accountError = S.account.enterBoth;
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
    const targetBefore = this.targetUri()?.fsPath;
    if (changed) {
      this.cancelPrompt();
      if (this.tempLink && this.tempLink.key !== pathKey(uri.fsPath)) this.tempLink = null; // "for that action only"
      this.languagesError = null;
      this.expandedSubmission = null;
    }

    // Matching order: saved (the file's own link, else its folder's link) → CPH .prob → exact file name
    // → exact folder name → suggestions (never saved automatically).
    // An explicitly unlinked file (or folder) is left alone ("Not linked to a problem").
    let link = await this.mapping.resolve(uri, this.cfg.baseUrl);
    if (link?.folder && this.mapping.isUnlinkedHere(uri)) link = undefined;
    const entry = link?.entry;
    const unlinked = !entry && this.mapping.isUnlinkedHere(uri);
    await this.loadFolder(link?.folder ? { fsPath: link.folder, entry: link.entry } : null);
    this.folderMatched = false;
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
          folders: this.sourceFile(uri.fsPath).folders,
          namePattern: this.cfg.fileNamePattern.pattern,
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
    // Matched by the name of its folder: the folder is a package like a linked folder (submit and
    // run files detected), but nothing is saved until the user chooses something.
    if (!this.folderLink && problem?.source === 'folder') {
      await this.loadFolder({ fsPath: dirname(uri.fsPath), entry: { problemId: problem.id, name: problem.name, baseUrl: this.cfg.baseUrl, folder: true } });
      this.folderMatched = true;
      if (seq !== this.refreshSeq) return;
    }
    // The chosen language belongs to the file Submit sends (folder mode: the folder's submit file).
    const target = this.targetUri()?.fsPath;
    if (changed || target !== targetBefore) {
      this.selectedLanguageId = target ? (this.ctx.workspaceState.get<Record<string, number>>(LANGUAGE_KEY, {})[target] ?? null) : null;
    }
    // Opened from a problem row: show that problem as a temporary link ("Suggested · Use this")
    // unless the file already resolves to it. Saving it is up to the user.
    const temp = this.tempLink && this.tempLink.key === pathKey(uri.fsPath) && !entry && !unlinked ? this.problemById(this.tempLink.problemId) : undefined;
    if (temp && !(problem && problem.id === temp.id)) {
      problem = { ...temp, source: 'suggested' };
      this.matchInfo = { suggestions: [temp, ...this.matchInfo.suggestions.filter((x) => x.id !== temp.id)], ambiguous: null, ambiguousSource: null };
    }
    // Remember automatic matches of open files (never over a manual link or "not linked").
    if (!entry && !unlinked && m.kind === 'match' && (m.source === 'filename' || m.source === 'folder' || m.source === 'cph' || m.source === 'suggested')) await this.mapping.recordAuto(uri, m.problem.id, m.source);
    else if (!entry && list?.length && m.kind !== 'match') await this.mapping.dropAuto(uri);
    await this.refreshMappedIds();
    if (seq !== this.refreshSeq) return;
    this.problem = problem;
    // Cached name search only here; a missing search runs right after the first render.
    // Suggestions (confident ones only) behave like links for everything read-only.
    this.linkedFiles = problem ? await this.filesForProblem(problem.id, 'cached') : [];
    if (problem && !this.matchIndex.peek() && this.data.isVisible()) void this.refreshLinkedFiles();
    if (problem) await this.noteOpened(problem.id);
    this.statementNoPdf = problem ? (await this.statementStore.cachedKind(problem.id)) === 'other' : false;
    this.runTestCount = this.cph.installed && problem ? ((await readCphProblem(this.runUri()?.fsPath ?? '', this.cphSaveLocation()))?.tests.length ?? 0) : null;
    this.applyLanguageChoice();
    this.emit();
    this.followStatement(uri, problem);
    // One problem only (the top suggestion at most, never several candidates).
    this.data.focusProblem(problem ? problem.id : null);
    if (!entry && !this.reconnectAsked.has(uri.fsPath)) void this.offerReconnect(uri);
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

  // ------------------------------------------------ files for a problem

  /**
   * The one "files for this problem" answer (duplicate notice, row click /
   * go to file, before-submit check): saved links, remembered auto-matches and
   * what the one matcher assigns to this problem (match index). Explicit "not
   * linked" files and files linked to another problem are left out.
   * `search`: 'run' builds the index if needed; 'cached' uses only a finished one.
   */
  async filesForProblem(problemId: number, search: 'run' | 'cached' | 'none' = 'run', includeSuggested = true): Promise<ProblemFile[]> {
    const chosen = (await this.mapping.filesFor(problemId, this.cfg.baseUrl)).map((u) => u.fsPath);
    let index: Map<number, IndexedFile[]> | undefined;
    if (search === 'run') index = await this.matchIndex.get();
    else if (search === 'cached') index = await this.matchIndex.peek();
    return mergeProblemFiles({
      problemId,
      chosen,
      auto: this.mapping.autoMatches(),
      matched: index?.get(problemId) ?? [],
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
      this.matchIndex.invalidate();
      // Folder mode: files created / deleted / renamed → detect the submit / run files again (choices kept).
      if (this.folderLink && this.fileUri) void this.setActiveFile(this.fileUri);
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

  /** Every known source extension: the server's languages (non-binary) + the fallback table. */
  private allSourceExts(): string[] {
    const exts = new Set<string>(Object.keys(EXTENSION_LANGUAGE).map((e) => e.slice(1)));
    for (const l of this.languages) if (l.ext && !BINARY_EXTS.has(l.ext.toLowerCase())) exts.add(l.ext.toLowerCase().replace(/^\./, ''));
    return [...exts];
  }

  /** A workspace file as the matcher sees it (path + workspace-relative parent folders for the folder/tag bonus). */
  private sourceFile(fsPath: string): SourceFile {
    const relDir = vscode.workspace.asRelativePath(vscode.Uri.joinPath(vscode.Uri.file(fsPath), '..'), false);
    return { fsPath, folders: relDir.split('/').filter((x) => x && x !== '.' && !x.includes(':')) };
  }

  /**
   * Build the match index: one workspace.findFiles of source files (same
   * exclusions as everywhere: settings, .gitignore, build folders, binaries),
   * then the one matcher per file. Logged as a file search.
   */
  private async buildIndex(): Promise<Map<number, IndexedFile[]>> {
    const problems = this.data.problemList()?.problems;
    if (!problems?.length) {
      queueMicrotask(() => this.matchIndex.invalidate()); // not ready yet: don't keep an empty index
      return new Map();
    }
    const cfg = (section: string) => vscode.workspace.getConfiguration(section).get<Record<string, unknown>>('exclude') ?? {};
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    let gitignore: string | null = null;
    if (root) gitignore = await fsReadFile(vscode.Uri.joinPath(root, '.gitignore').fsPath, 'utf8').catch(() => null);
    const t0 = Date.now();
    const exts = this.allSourceExts();
    const found = await vscode.workspace.findFiles(sourceGlob(exts), excludeGlob([cfg('files'), cfg('search')], gitignore), LIMITS.indexMaxFiles);
    const files = filterSourceFiles(found.map((u) => u.fsPath), exts).map((f) => this.sourceFile(f));
    const index = buildMatchIndex(files, problems, this.cfg.baseUrl, this.cfg.fileNamePattern.pattern);
    const matched = [...index.values()].reduce((n, l) => n + l.length, 0);
    this.requestLog(`FILE SEARCH source files: ${files.length} → ${matched} matched to ${index.size} problems (${Date.now() - t0} ms)`);
    return index;
  }

  /** Does the one matcher (without saved links) give `problemId` for this path? */
  private matcherSays(fsPath: string, problemId: number): boolean {
    const problems = this.data.problemList()?.problems ?? [];
    return matchFile(this.sourceFile(fsPath), problems, this.cfg.baseUrl, this.cfg.fileNamePattern.pattern)?.problemId === problemId;
  }

  /** Existing files for a problem, in the stable path order; missing saved links reported, missing auto-matches dropped. */
  private async existingFilesFor(problemId: number): Promise<{ found: { uri: vscode.Uri; t: number; how: ProblemFile['how'] }[]; gone: vscode.Uri[] }> {
    const found: { uri: vscode.Uri; t: number; how: ProblemFile['how'] }[] = [];
    const gone: vscode.Uri[] = [];
    // Opening a file never links it, so suggestions are fine here.
    for (const f of await this.filesForProblem(problemId, 'run', true)) {
      const st = await fsStat(f.fsPath).catch(() => null);
      // Same answer as opening the file: CPH data pointing to another problem wins over the name.
      if (st && f.how !== 'chosen' && f.how !== 'cph') {
        const cph = await readCphProblem(f.fsPath, this.cphSaveLocation());
        if (cph) {
          const r = resolveProblem({ savedProblemId: null, cph, filePath: f.fsPath, problems: this.data.problemList()?.problems, baseUrl: this.cfg.baseUrl, folders: this.sourceFile(f.fsPath).folders, namePattern: this.cfg.fileNamePattern.pattern });
          if (r.kind === 'match' && r.problem.id !== problemId) continue;
        }
      }
      // A folder (folder mode / matched by its name) opens its submit file or main file.
      const open = st?.isDirectory() ? await this.folderItemFile(f.fsPath) : f.fsPath;
      if (st && open) found.push({ uri: vscode.Uri.file(open), t: (await fsStat(open).catch(() => null))?.mtimeMs ?? st.mtimeMs, how: f.how });
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

  private async pickAndOpen(found: { uri: vscode.Uri; t: number; how: ProblemFile['how'] }[], name: string, problemId?: number): Promise<void> {
    const how = PICK_HOW;
    const target =
      found.length === 1
        ? found[0].uri
        : (
            await vscode.window.showQuickPick(
              found.map((f) => ({ label: vscode.workspace.asRelativePath(f.uri), description: how[f.how], detail: S.common.edited(new Date(f.t).toLocaleString(dateLocale())), uri: f.uri })),
              { placeHolder: S.files.filesFor(name) },
            )
          )?.uri;
    if (target && problemId !== undefined) {
      // Opening never links: a name-matched / suggested file shows this problem as a temporary link.
      const how = found.find((f) => f.uri.fsPath === target.fsPath)?.how;
      this.tempLink = how && how !== 'chosen' ? { key: pathKey(target.fsPath), problemId } : null;
    }
    if (target) await vscode.window.showTextDocument(target);
  }

  /** Problems with a file (saved links + remembered auto-matches), for the row menus. */
  private async refreshMappedIds(): Promise<void> {
    const ids = await this.mapping.mappedProblemIds(this.cfg.baseUrl);
    const blocked = this.mapping.unlinkedPaths();
    for (const a of this.mapping.autoMatches()) if (!blocked.some((u) => isAtOrInside(a.fsPath, u))) ids.add(a.problemId);
    this.mappedIds = ids;
  }

  // ------------------------------------------------------ moved files

  /**
   * At most once a day: stale mappings older than 30 days, downloaded files
   * unused for 30 days, leftover temporary files, then the size limit.
   * Never touches the workspace.
   */
  private async dailyCleanup(): Promise<void> {
    const last = this.ctx.globalState.get<number>(CLEANUP_KEY, 0);
    if (Date.now() - last < TIMING.dailyCleanupMs) return;
    await this.ctx.globalState.update(CLEANUP_KEY, Date.now());
    const n = await this.mapping.expireStale();
    if (n) this.log(`Removed ${n} mapping(s) whose file has been missing for 30 days.`);
    const r = await cleanupCache(this.cacheRoot(), {
      now: Date.now(),
      maxBytes: this.cfg.cacheMaxMB * 1024 * 1024,
      unusedDays: CACHE.unusedDays,
      tempDays: CACHE.tempDays,
    });
    if (r.removed) this.log(`Cache cleanup: removed ${r.removed} file(s), ${formatBytes(r.bytes)}.`);
    await this.pruneStatementViews();
  }

  private cacheRoot(): string {
    return this.ctx.globalStorageUri.fsPath;
  }

  /** A downloaded file was written: keep the cache under `cedtGrader.cacheMaxMB` (one run at a time; the new file stays). */
  private cacheWritten(path: string): void {
    this.cacheJob = this.cacheJob
      .then(async () => {
        const r = await enforceLimit(this.cacheRoot(), this.cfg.cacheMaxMB * 1024 * 1024, [path]);
        if (r.removed) {
          this.requestLog(`cache limit: removed ${r.removed} least recently used file(s), ${formatBytes(r.bytes)}`);
          await this.pruneStatementViews();
        }
      })
      .catch((err) => this.logError('Cache limit', err));
  }

  /** Forget the saved page / zoom of statements that are no longer cached. */
  private async pruneStatementViews(): Promise<void> {
    const views = this.ctx.globalState.get<Record<string, unknown>>(KEYS.statementView, {});
    if (!Object.keys(views).length) return;
    const kept = keepIds(views, statementIds(await scanCache(this.cacheRoot())));
    if (Object.keys(kept).length !== Object.keys(views).length) await this.ctx.globalState.update(KEYS.statementView, kept);
  }

  /** Remember a `.prob.bak` this extension wrote, so "Clear Cached Data" can offer to remove it (and nothing else). */
  private async recordBackup(path: string | null | undefined): Promise<void> {
    if (!path) return;
    await this.ctx.globalState.update(KEYS.backups, recordBackup(this.backups(), path, new Date()));
  }

  private backups(): BackupRecord[] {
    return this.ctx.globalState.get<BackupRecord[]>(KEYS.backups, []);
  }

  /**
   * "Clear Cached Data": shows the size in use, lets the user tick what to
   * clear (`CLEAR_DEFAULTS`), confirms (modal: can't be undone), then clears.
   */
  async clearCachedData(): Promise<void> {
    const files = await scanCache(this.cacheRoot());
    const fileBytes = totalBytes(files);
    const listKeys = this.ctx.workspaceState.keys().filter((k) => k.startsWith(KEYS.problemsPrefix));
    const listBytes = listKeys.reduce((n, k) => n + Buffer.byteLength(JSON.stringify(this.ctx.workspaceState.get(k)) ?? ''), 0);
    const backups = backupsToDelete(this.backups(), existsSync);
    const linkCount = (await this.mapping.allEntries()).length;
    const C = S.cache;
    const rows: Record<ClearCategory, { label: string; detail: string; description?: string; show: boolean }> = {
      files: { label: C.files, detail: C.filesDetail, description: formatBytes(fileBytes), show: true },
      lists: { label: C.lists, detail: C.listsDetail, description: formatBytes(listBytes), show: true },
      links: { label: C.links, detail: C.linksDetail, description: linkCount ? String(linkCount) : undefined, show: true },
      login: { label: C.login, detail: C.loginDetail, show: true },
      backups: { label: C.backups, detail: C.backupsDetail(backups.length), show: backups.length > 0 },
    };
    const items = CLEAR_ORDER.filter((c) => rows[c].show).map((c) => ({
      id: c,
      label: rows[c].label,
      description: rows[c].description,
      detail: rows[c].detail,
      picked: CLEAR_DEFAULTS[c],
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: C.title(formatBytes(fileBytes + listBytes)),
      placeHolder: C.placeholder,
      ignoreFocusOut: true,
    });
    if (!picked?.length) return;
    const what = picked.map((p) => p.label.toLowerCase()).join(', ');
    if ((await vscode.window.showWarningMessage(C.confirm(what), { modal: true }, C.clear)) !== C.clear) return;

    const plan = planClear(new Set(picked.map((p) => p.id)), {
      workspace: this.ctx.workspaceState.keys(),
      global: this.ctx.globalState.keys(),
    });
    let freed = 0;
    let skippedDirty = 0;
    if (plan.logout) await this.logout();
    if (plan.cacheFiles) {
      freed += (await clearCacheFiles(this.cacheRoot())).bytes;
      this.data.forgetDetails();
      await this.refreshStatementKind();
    }
    if (plan.staleLinks) await this.mapping.removeStale();
    if (plan.allLinks) skippedDirty = (await this.mapping.emptyMappingFiles()).skippedDirty;
    for (const k of plan.workspaceKeys) await this.ctx.workspaceState.update(k, undefined);
    for (const k of plan.globalKeys) await this.ctx.globalState.update(k, undefined);
    if (plan.resetData) freed += listBytes;
    if (plan.backups) {
      for (const b of backups) {
        try {
          const size = (await fsStat(b.path)).size;
          await rm(b.path, { force: true });
          freed += size;
        } catch {
          /* already gone */
        }
      }
      await this.ctx.globalState.update(KEYS.backups, undefined);
    }
    this.mapping.invalidate();
    this.matchIndex.invalidate();
    this.selectedLanguageId = null;
    if (plan.resetData) {
      this.results.clear();
      this.expandedSubmission = null;
      this.unavailableIds.clear();
      this.data.clear();
      if (this.client.isLoggedIn) void this.data.loadProblems();
    }
    await this.refreshMappedIds();
    if (this.fileUri) await this.setActiveFile(this.fileUri);
    else this.emit();
    void vscode.window.setStatusBarMessage(C.cleared(formatBytes(freed)), TIMING.statusMessageMs * 2);
    if (skippedDirty) void vscode.window.showWarningMessage(C.skippedDirty(skippedDirty));
  }

  /** Update mappings (and per-file state) for files renamed or moved inside VS Code. */
  private async onFilesRenamed(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    const moved: { from: string; to: string }[] = [];
    for (const f of files) moved.push(...(await this.mapping.rename(f.oldUri, f.newUri)));
    // Auto-matches follow the file only while the new name still matches.
    for (const f of files) await this.mapping.renameAuto(f.oldUri, f.newUri, (path, id) => this.matcherSays(path, id));
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
    // CPH names its file after the full source path and does not follow renames. A renamed folder
    // took its `.cph/` along (or the files stayed in CPH's save location): every source inside is orphaned.
    const save = this.cphSaveLocation();
    const inFolders: { prob: string; oldSrc: string; newSrc: string }[] = [];
    for (const f of files) {
      if ((await fsStat(f.newUri.fsPath).catch(() => null))?.isDirectory()) inFolders.push(...(await cphFilesAfterFolderRename(f.oldUri.fsPath, f.newUri.fsPath, save)));
    }
    if (moved.length) this.log(`Updated ${moved.length} mapping(s) after a rename.`);
    if (this.fileUri && (moved.length || this.folderLink)) await this.setActiveFile(this.fileUri); // links / the folder's files may have moved

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
      await this.recordBackup(r.backup);
      if (r.status === 'moved') done++;
      else if (r.status === 'target-exists') skipped++;
    }
    void vscode.window.showInformationMessage(
      S.moved.movedCph(done, skipped),
    );
    await this.refreshRunTests();
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
      S.moved.entry(vscode.workspace.asRelativePath(c.fsPath), this.problemById(c.entry.problemId)?.name ?? c.entry.name ?? `#${c.entry.problemId}`);
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
    const target = this.targetUri();
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
    const target = this.targetUri();
    if (target) {
      const all = { ...this.ctx.workspaceState.get<Record<string, number>>(LANGUAGE_KEY, {}) };
      all[target.fsPath] = id;
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
    // Folder mode / matched by the folder's name: the folder is unlinked ("not linked", sticky).
    const folder = this.folderLink ? vscode.Uri.file(this.folderLink.fsPath) : this.problem?.source === 'folder' ? vscode.Uri.joinPath(this.fileUri, '..') : null;
    if (folder) {
      if (this.folderLink && !this.folderMatched) await this.mapping.set(folder, undefined);
      await this.mapping.setUnlinked(folder, true);
      this.tempLink = null;
      this.problem = null;
      await this.refreshMappedIds();
      await this.setActiveFile(this.fileUri);
      return;
    }
    // Works for every state: a chosen link is removed; a name / CPH match, a suggestion
    // or a temporary link just becomes "not linked" (sticky; auto-detect leaves it alone).
    await this.mapping.set(this.fileUri, undefined);
    await this.mapping.dropAuto(this.fileUri);
    await this.mapping.setUnlinked(this.fileUri, true);
    this.tempLink = null;
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
  /**
   * The user confirmed an automatic match by submitting: save it as their choice ("Chosen by
   * you"), so Submit doesn't ask again. A folder matched by its name is saved as a folder link.
   */
  private async keepAutoMatch(problem: Problem): Promise<void> {
    const link = this.folderLink;
    if (link && this.folderMatched) {
      await this.mapping.set(vscode.Uri.file(link.fsPath), { ...link.entry });
      this.folderMatched = false;
    } else if (this.fileUri) {
      await this.mapping.set(this.fileUri, { problemId: problem.id, name: problem.name, baseUrl: this.cfg.baseUrl });
    } else return;
    if (this.problem?.id === problem.id) this.problem = { ...this.problem, source: 'saved' };
    await this.refreshMappedIds();
    this.emit();
  }

  private confirmSuggestedFor(file: vscode.Uri, problem: Problem & { source: MatchSource }, question: string, yesLabel: string, near?: 'submit'): Promise<boolean> {
    return confirmSuggestion({
      source: problem.source,
      ask: async () => {
        const pick = await this.askInline(
          question,
          [
            { id: 'yes', label: yesLabel, primary: true },
            { id: 'choose', label: S.submit.chooseAnother },
          ],
          { near },
        );
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
  focusTarget: ((t: 'login' | 'problem-search' | 'submit' | 'result') => void) | null = null;

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
      await this.pickAndOpen(found, p.name, problemId);
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
    await this.mapping.setUnlinked(uri, false); // Auto-detect clears "not linked" (also of folders above it)
    for (const u of this.mapping.unlinkedPaths()) if (isAtOrInside(uri.fsPath, u)) await this.mapping.setUnlinked(vscode.Uri.file(u), false);
    const list = this.data.problemList()?.problems;
    if (!list) {
      await this.refreshProblems(false);
      if (!this.data.problemList()) return;
    }
    const cph = await readCphProblem(uri.fsPath, this.cphSaveLocation());
    const m = resolveProblem({ savedProblemId: null, cph, filePath: uri.fsPath, problems: this.data.problemList()!.problems, baseUrl: this.cfg.baseUrl, folders: this.sourceFile(uri.fsPath).folders, namePattern: this.cfg.fileNamePattern.pattern });
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
    return linkedNotice(this.linkedFiles, file.fsPath, (f) => f)?.files.map(({ fsPath, how, folder }) => ({ fsPath, how, ...(folder ? { folder } : {}) })) ?? [];
  }

  /** Jump to one of the files for the current problem (index into the list the panel shows). */
  async openLinkedFile(index: number): Promise<void> {
    const f = this.noticeFiles()[index];
    if (!f) return;
    if (!(await exists(f.fsPath))) {
      void this.goToFile(this.problem?.id ?? -1); // offers removing the stale link
      return;
    }
    await this.openItem(f.fsPath);
  }

  /**
   * Unlink one other file from the notice: a chosen link is removed; a name /
   * CPH match gets the explicit "not linked" state ("Don't match this file").
   * Either way auto-detection leaves that file alone afterwards.
   */
  async unlinkLinkedFile(index: number): Promise<void> {
    const f = this.noticeFiles()[index];
    if (!f || pathKey(f.fsPath) === pathKey(this.fileUri?.fsPath ?? '') || (f.folder && isAtOrInside(this.fileUri?.fsPath ?? '', f.fsPath))) return;
    await this.detachFile(f);
    if (this.fileUri) await this.setActiveFile(this.fileUri);
  }

  private async detachFile(f: ProblemFile): Promise<void> {
    const uri = vscode.Uri.file(f.fsPath);
    if (f.how === 'chosen') await this.mapping.set(uri, undefined); // a file or a folder link
    await this.mapping.dropAuto(uri);
    await this.mapping.setUnlinked(uri, true);
  }

  /**
   * Rename the active file to "<clean problem name>.<ext>" (editable first).
   * Goes through WorkspaceEdit.renameFile, so open editors, links, our rename
   * handling and the CPH prompt follow, and Undo works. Never overwrites.
   */
  async renameFileToProblem(): Promise<void> {
    const file = this.fileUri;
    const problem = this.currentProblem();
    if (!file || !problem) return;
    const dir = vscode.Uri.joinPath(file, '..');
    const taken = async (name: string) => {
      const target = vscode.Uri.joinPath(dir, name);
      return pathKey(target.fsPath) !== pathKey(file.fsPath) && (await exists(target.fsPath));
    };
    const proposal = renameProposal(file.fsPath, problem.name, this.cfg.fileNamePattern.pattern, problem.id);
    const first = await freeName(proposal, taken); // never overwrite: "<name>_2.<ext>" if taken
    const stemLen = first.lastIndexOf('.') > 0 ? first.lastIndexOf('.') : first.length;
    const name = await vscode.window.showInputBox({
      title: S.rename.title,
      prompt: first === proposal ? S.rename.prompt(file.path.split('/').pop() ?? '') : S.rename.existsSuggest(proposal, first),
      value: first,
      valueSelection: [0, stemLen],
      validateInput: async (v) => {
        const bad = invalidFileName(v);
        if (bad) return S.rename.invalid[bad];
        if (await taken(v.trim())) return S.rename.existsSuggest(v.trim(), await freeName(v.trim(), taken));
        return null;
      },
    });
    if (!name) return;
    const target = vscode.Uri.joinPath(dir, name.trim().normalize('NFC'));
    if (pathKey(target.fsPath) === pathKey(file.fsPath)) return;
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(file, target, { overwrite: false });
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) void vscode.window.showWarningMessage(S.rename.failed(name.trim()));
  }

  /** Dismiss the "files for this problem" notice until its set of files changes (per workspace). */
  async dismissLinkedNotice(): Promise<void> {
    const p = this.problem;
    if (!p || this.linkedFiles.length < 2) return;
    const all = { ...this.ctx.workspaceState.get<Record<string, string>>(DISMISSED_NOTICES_KEY, {}) };
    all[String(p.id)] = noticeSignature(this.linkedFiles);
    await this.ctx.workspaceState.update(DISMISSED_NOTICES_KEY, all);
    this.emit();
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
    const target = vscode.Uri.joinPath(folder, fileNameFor(p.name, language.ext && language.ext !== 'null' ? language.ext : 'txt', this.cfg.fileNamePattern.pattern, p.id));
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
    if (found.length) await this.pickAndOpen(found, p?.name ?? `#${problemId}`, problemId);
  }

  /**
   * "Find a matching file" (only when clicked): one workspace.findFiles for source
   * files named like the problem (case-insensitive) with an extension of a
   * permitted language; build output, binaries and excluded folders are skipped.
   */
  async findFileByName(problemId: number): Promise<void> {
    const p = this.problemById(problemId);
    if (!p) return;
    await this.data.languages().catch(() => undefined);
    // The one matcher decides (same as opening a file): name matches and confident suggestions.
    const kept = ((await this.matchIndex.get()).get(problemId) ?? [])
      .map((f) => f.fsPath)
      .filter((f) => !this.mapping.unlinkedPaths().some((u) => pathKey(u) === pathKey(f)));
    if (!kept.length) {
      void vscode.window.showInformationMessage(S.files.noFileNamed(cleanName(p.name), this.sourceExtsFor(p).map((e) => `.${e}`).join(', ')));
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
            detail: S.common.modified(new Date(mtimes.get(f) ?? 0).toLocaleString(dateLocale())),
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
   * `asFiles` ("Save test cases as files"): always the files, CPH or not.
   */
  async loadTestcases(refresh = false, asFiles = false): Promise<void> {
    const problem = this.currentProblem();
    if (!problem || !this.fileUri || this.testcasesBusy) return;
    // Folder mode: test cases belong to the run file (the driver), whichever file of the folder is open.
    if (this.folderLink && !(await this.askFolderRole('run', problem))) return;
    const file = this.runUri();
    if (!file) return;
    if (!problem.hasTestcase) {
      void vscode.window.showInformationMessage(S.testcases.none(problem.name));
      return;
    }
    // Writing test cases for a guess: ask once (yes confirms the link).
    if (!(await this.confirmSuggestedFor(this.fileUri, problem, S.testcases.suggestedQ(problem.name, this.subtitleOf(problem)), S.testcases.load))) return;
    if (!(await this.ensureLoggedIn())) return;
    this.testcasesBusy = true;
    this.emit();
    // The spinner is for the download only; the questions and the final notification
    // (which stays open until dismissed) come after it.
    const downloaded = () => {
      if (!this.testcasesBusy) return;
      this.testcasesBusy = false;
      this.emit();
    };
    try {
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: S.testcases.progressTitle(problem.name), cancellable: true },
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
      downloaded();
      if (res.status === 'not-available') {
        void vscode.window.showInformationMessage(S.testcases.notAllowed(problem.name));
        return;
      }
      const { set } = res;
      const total = set.cases.length + set.truncated.length;
      const tooLarge = set.truncated.length ? S.testcases.tooLarge(set.truncated.length) : '';
      const programText = await fsReadFile(file.fsPath, 'utf8').catch(() => '');
      const { cases, key } = stripGraderKey(set.cases, programText);
      const keyNote = key ? S.testcases.keyRemoved : '';
      const refetch = S.testcases.downloadAgain;

      const target = asFiles ? 'files' : await this.testcaseTarget(S.testcases.whereTo(set.cases.length));
      if (!target) return;
      if (target === 'files') {
        const folder = this.testsFolder(file, this.folderLink?.fsPath ?? null, problem.name);
        if (!(await this.confirmTestsFolder(folder, set.cases.length))) return;
        const r = await saveTestcasesAsFiles(folder, cases);
        const extra = [r.unchanged ? S.testcases.unchanged(r.unchanged) : '', r.keptExisting ? S.testcases.keptExisting(r.keptExisting) : '']
          .filter(Boolean)
          .join(', ');
        const open = S.testcases.showFolder;
        const install = S.common.installCph;
        const pick = await vscode.window.showInformationMessage(
          S.testcases.savedFiles(r.written, total, vscode.workspace.asRelativePath(folder), tooLarge, extra) + keyNote,
          open,
          ...(this.cph.installed ? [] : [install]),
          ...(res.fromCache ? [refetch] : []),
        );
        if (pick === open) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(folder));
        if (pick === install) await vscode.commands.executeCommand('extension.open', CPH_EXTENSION_ID);
        if (pick === refetch) await this.loadTestcases(true, asFiles);
        return;
      }

      const result = await importIntoCph({
        srcPath: file.fsPath,
        saveLocation: this.cphSaveLocation(),
        problemName: cleanName(problem.name),
        problemUrl: this.url(WEB_PATHS.problem(problem.id)),
        cases,
      });
      await this.recordBackup(result.backupPath);
      await this.refreshRunTests(); // "Run tests" becomes available
      const parts = [S.testcases.savedCph(set.cases.length, total, tooLarge)];
      if (result.alreadyPresent) parts.push(S.testcases.alreadyPresent(result.alreadyPresent));
      if (result.updated) parts.push(S.testcases.updated(result.updated));
      if (result.added) parts.push(S.testcases.added(result.added));
      const reloaded = await this.reloadCphIfActive(file);
      const reload = S.testcases.reloadCph;
      const pick = await vscode.window.showInformationMessage(
        S.testcases.cphDone(parts.join('; '), !!result.backupPath, reloaded) + keyNote,
        ...(reloaded ? [] : [reload]),
        ...(res.fromCache ? [refetch] : []),
      );
      if (pick === reload) await this.reloadCph(file);
      if (pick === refetch) await this.loadTestcases(true);
    } catch (err) {
      if (classifyConnectionError(err)) this.reportError(err, () => this.loadTestcases(refresh, asFiles));
      else void vscode.window.showErrorMessage(S.testcases.failed(this.describe(err)));
    } finally {
      downloaded();
    }
  }

  /** Where test cases go: CPH's .prob when installed, else files (asked once per workspace, remembered); null = cancelled. */
  private async testcaseTarget(question: string): Promise<'cph' | 'files' | null> {
    const target = chooseTestcaseTarget(this.cph.installed, this.ctx.workspaceState.get<'files'>(TESTCASE_TARGET_KEY));
    if (target !== 'ask') return target;
    const files = S.testcases.saveAsFiles;
    const install = S.common.installCph;
    const pick = await vscode.window.showInformationMessage(question, { detail: S.testcases.whereToDetail }, files, install);
    if (pick === install) await vscode.commands.executeCommand('extension.open', CPH_EXTENSION_ID);
    if (pick !== files) return null;
    await this.ctx.workspaceState.update(TESTCASE_TARGET_KEY, 'files'); // remembered per workspace
    return 'files';
  }

  /** `tests/` for a file's cases. Folder mode: the folder already carries the problem's name → `<folder>/tests`. */
  private testsFolder(file: vscode.Uri, folder: string | null, problemName: string): string {
    return folder ? join(folder, 'tests') : testsFolderFor(dirname(file.fsPath), problemName);
  }

  /** Creating the tests folder is confirmed first. */
  private async confirmTestsFolder(folder: string, n: number): Promise<boolean> {
    if (await exists(folder)) return true;
    const create = S.testcases.createFolder;
    return (await vscode.window.showInformationMessage(S.testcases.createFolderQ(vscode.workspace.asRelativePath(folder), n), create)) === create;
  }

  // ------------------------------------------------------- sample cases

  /** "Load samples" is hidden only when the cache says the statement is not a PDF (no request to find out). */
  private async refreshStatementKind(): Promise<void> {
    const id = this.problem?.id;
    const noPdf = id ? (await this.statementStore.cachedKind(id)) === 'other' : false;
    if (noPdf === this.statementNoPdf || id !== this.problem?.id) return;
    this.statementNoPdf = noPdf;
    this.emit();
  }

  /**
   * "Load sample cases": the example input/output table of the problem's
   * statement PDF, read in the host (src/data/pdfSamples.ts). The PDF comes
   * from the statement cache; when it isn't cached it is fetched once with the
   * same request as opening the statement (and cached). Same targets and rules
   * as "Load test cases": folder mode → the run file; CPH .prob (ids
   * STATEMENT_ID_BASE + n, backup recorded, duplicates skipped) or
   * `tests/sample<n>.in|out`, never overwriting.
   */
  async loadSampleCases(): Promise<void> {
    const problem = this.currentProblem();
    if (!problem || !this.fileUri || this.samplesBusy) return;
    if (this.folderLink && !(await this.askFolderRole('run', problem))) return;
    const file = this.runUri();
    if (!file) return;
    if (!(await this.confirmSuggestedFor(this.fileUri, problem, S.samples.suggestedQ(problem.name, this.subtitleOf(problem)), S.samples.load))) return;
    this.samplesBusy = true;
    this.emit();
    let tables: SampleTable[];
    try {
      let st = await this.statementStore.cached(problem.id);
      if (!st) {
        if (!(await this.ensureLoggedIn())) return;
        st = await this.statementStore.get(problem.id);
        this.connectionOk();
      }
      if (st.kind !== 'pdf') {
        this.statementNoPdf = true; // the button goes away (and stays away for this problem while cached)
        void this.tellInline(null, S.samples.noPdf);
        return;
      }
      tables = await readSampleTables(st.bytes, await this.pdfjs());
    } catch (err) {
      if (classifyConnectionError(err)) this.reportError(err, () => this.loadSampleCases());
      else void this.tellInline(err, S.samples.failed(this.describe(err)));
      return;
    } finally {
      this.samplesBusy = false;
      this.emit();
    }
    const found = tables.flatMap((t) => t.cases);
    if (!found.length) {
      void this.tellInline(null, S.samples.none);
      return;
    }
    // A sample table with rows that couldn't be read is an incomplete read: load nothing (not into
    // CPH, not as files) rather than part of the cases. Misread text that still looks like a case
    // can't be detected; the tooltip asks to check the cases.
    const skipped = tables.reduce((n, t) => n + (t.skipped ?? 0), 0);
    if (skipped) {
      void this.tellInline(null, S.samples.incomplete(skipped));
      return;
    }
    const annotated = found.filter((c) => c.annotated).length;
    const cases: GraderCase[] = sampleCasesToImport(found);
    const loaded = S.samples.loaded(cases.length) + (annotated ? S.samples.annotated(annotated) : '');
    try {
      const where = await this.testcaseTarget(S.samples.whereTo(cases.length));
      if (!where) return;
      if (where === 'files') {
        const folder = this.testsFolder(file, this.folderLink?.fsPath ?? null, problem.name);
        if (!(await this.confirmTestsFolder(folder, cases.length))) return;
        const r = await saveTestcasesAsFiles(folder, cases, 'sample');
        const extra = [r.unchanged ? S.testcases.unchanged(r.unchanged) : '', r.keptExisting ? S.testcases.keptExisting(r.keptExisting) : '']
          .filter(Boolean)
          .join(', ');
        const open = S.testcases.showFolder;
        const pick = await vscode.window.showInformationMessage(`${loaded} ${S.samples.savedFiles(r.written, vscode.workspace.asRelativePath(folder), extra)}`, open);
        if (pick === open) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(folder));
        return;
      }
      const result = await importIntoCph({
        srcPath: file.fsPath,
        saveLocation: this.cphSaveLocation(),
        problemName: cleanName(problem.name),
        problemUrl: this.url(WEB_PATHS.problem(problem.id)),
        cases,
        idBase: STATEMENT_ID_BASE,
      });
      await this.recordBackup(result.backupPath);
      await this.refreshRunTests(); // "Run tests" becomes available
      const parts: string[] = [];
      if (result.alreadyPresent) parts.push(S.testcases.alreadyPresent(result.alreadyPresent));
      if (result.updated) parts.push(S.testcases.updated(result.updated));
      if (result.added) parts.push(S.testcases.added(result.added));
      const reloaded = await this.reloadCphIfActive(file);
      const reload = S.testcases.reloadCph;
      const pick = await vscode.window.showInformationMessage(
        `${loaded} ${S.testcases.cphDone(S.samples.savedCph(parts.join('; ')), !!result.backupPath, reloaded)}`,
        ...(reloaded ? [] : [reload]),
      );
      if (pick === reload) await this.reloadCph(file);
    } catch (err) {
      void vscode.window.showErrorMessage(S.samples.failed(this.describe(err)));
    }
  }

  /**
   * CPH only re-reads a .prob when the active editor changes (no reload
   * command exists). Briefly show a read-only placeholder and come back. Only
   * the placeholder is ever closed (if it didn't become the active editor,
   * nothing is closed).
   */
  async reloadCph(file: vscode.Uri): Promise<void> {
    const placeholder = vscode.Uri.from({ scheme: SUBMISSION_SCHEME, path: '/0/reloading-cph' });
    const doc = await vscode.workspace.openTextDocument(placeholder);
    const shown = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    if (vscode.window.activeTextEditor?.document.uri.toString() === placeholder.toString()) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.window.showTextDocument(file, { preview: false, viewColumn: shown.viewColumn });
  }

  /**
   * After writing a .prob: reload CPH right away when that is safe, i.e. the
   * file is the active editor (the user stays where they are; only a flicker).
   * Otherwise nothing moves: CPH reads the file when the user opens it, and the
   * message offers "Reload in CPH". Returns whether it reloaded.
   */
  private async reloadCphIfActive(file: vscode.Uri): Promise<boolean> {
    if (vscode.window.activeTextEditor?.document.uri.toString() !== file.toString()) return false;
    try {
      await this.reloadCph(file);
      return true;
    } catch (err) {
      this.log(`CPH reload failed: ${this.describe(err)}`);
      return false;
    }
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
    const right = this.targetUri() ?? this.fileUri; // folder mode: the file Submit sends
    const label = `${d.number !== null ? `Attempt ${d.number}` : `#${d.id}`} ↔ ${right.path.split('/').pop()}`;
    await vscode.commands.executeCommand('vscode.diff', left, right, label);
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
    if (!this.fileUri) {
      void vscode.window.showInformationMessage(S.submit.openToSubmit);
      return;
    }
    if (!(await this.ensureLoggedIn())) return;
    if (!this.problem) {
      await this.chooseProblemQuickPick();
      if (!this.problem) return;
    }
    const problem = this.currentProblem()!;
    // Folder mode: the folder's submit file (asked once), whichever file of the folder is open.
    if (this.folderLink && !(await this.askFolderRole('submit', problem, 'submit'))) return;
    // Folder mode with another file of the folder open: submit file or the open file? Asked until
    // the folder has a chosen submit file (the answer is saved, and saving links the folder).
    const confirmed = await this.askSubmitFileOrOpen(problem);
    if (confirmed === null) return;
    const fileUri = this.targetUri();
    const doc = fileUri
      ? (vscode.workspace.textDocuments.find((d) => d.uri.toString() === fileUri.toString()) ?? (await vscode.workspace.openTextDocument(fileUri).then((d) => d, () => undefined)))
      : undefined;
    if (!doc || !fileUri) {
      void vscode.window.showInformationMessage(S.submit.openToSubmit);
      return;
    }
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
        const pick = await vscode.window.showWarningMessage(S.exam.warning, { modal: true }, open, anyway);
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
      // Folder mode: the linked folder (or the folder of the matched files) is "this one".
      const others = (await this.filesForProblem(problem.id, 'run'))
        .filter((f) => (f.folder ? !isAtOrInside(fileUri.fsPath, f.fsPath) : pathKey(f.fsPath) !== pathKey(fileUri.fsPath)))
        .map((f) => f.fsPath);
      const otherFiles = await Promise.all(others.map(async (f) => vscode.Uri.file((await this.folderItemFile(f)) ?? f)));
      if (otherFiles.length) {
        const mine = doc.isDirty ? Date.now() : ((await fsStat(fileUri.fsPath).catch(() => null))?.mtimeMs ?? 0);
        let newest: { uri: vscode.Uri; t: number } | null = null;
        for (const u of otherFiles) {
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
            { tone: 'warn', detail: S.submit.bothLinked(problem.name, problem.id), near: 'submit' },
          );
          if (pick === 'open') await vscode.window.showTextDocument(newest.uri);
          if (pick !== 'go') return;
        }
      }

      // Suggestions always ask; automatic matches ask once (Submit saves the link as "Chosen by
      // you"); links the user chose never ask (submitQuestion).
      const question = submitQuestion({ source: problem.source, confirmBeforeSubmit: this.cfg.confirmBeforeSubmit, answered: warned || !!confirmed });
      if (question === 'suggested') {
        if (!(await this.confirmSuggestedFor(this.fileUri ?? fileUri, problem, S.submit.suggestedQ(problem.name, this.subtitleOf(problem)), S.submit.submit, 'submit'))) return;
      } else if (question === 'confirmOnce') {
        const how = HOW_LINKED[problem.source as keyof typeof HOW_LINKED] ?? HOW_LINKED.filename;
        const pick = await this.askInline(
          S.submit.confirmQ(fileName, problem.name, problem.id, language?.name ?? null),
          [
            { id: 'submit', label: S.submit.submit, primary: true },
            { id: 'cancel', label: S.common.cancel },
          ],
          { detail: this.folderLink ? `${S.folder.onlyThisSent(fileName)} ${S.submit.confirmOnce(how)}` : S.submit.confirmOnce(how), near: 'submit' },
        );
        if (pick !== 'submit') return;
        await this.keepAutoMatch(problem);
      }

      // Save first (after the questions, so Cancel never saves): the grader gets what is on disk.
      if (needsSave({ saveBeforeSubmit: this.cfg.saveBeforeSubmit, isDirty: doc.isDirty, isUntitled: doc.isUntitled }) && !(await doc.save())) {
        this.setResult(key, newResult(problem, 'error', S.submit.saveFailed(fileName)));
        return;
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
    if (shouldRevealResult({ revealResultAfterSubmit: this.cfg.revealResultAfterSubmit, gradedFile: key, activeFile: this.targetUri()?.fsPath ?? null })) {
      this.focusTarget?.('result');
    }
  }

  /** README troubleshooting section on GitHub, in the display language. */
  async openTroubleshooting(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(troubleshootingUrl(currentLang()), true));
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
      { location: vscode.ProgressLocation.Notification, title: S.submit.gradingTitle(problem.name, submissionId), cancellable: true },
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
      message: graded ? (s.compileError ? S.submit.compilationError : null) : S.submit.waitingStatus(s.status.replace(/_/g, ' ')),
    });
  }

  /** Latest submission of the current file's problem, from history (refreshes history if stale). */
  async showLastResult(): Promise<void> {
    await vscode.commands.executeCommand('cedtGrader.panel.focus');
    const problem = this.currentProblem();
    const key = this.targetUri()?.fsPath;
    if (!problem || !key || this.busy) return;
    if (!(await this.ensureLoggedIn())) return;
    const items = (await this.data.loadHistory(problem.id)) ?? [];
    if (!items.length) {
      this.setResult(key, newResult(problem, 'done', S.submit.noSubmissionsYet));
      return;
    }
    const d = await this.data.loadDetail(items[0].id);
    if (!d) return;
    this.setResult(key, newResult(problem, 'grading', null));
    this.applySubmission(key, d);
    if (d.state !== 'graded') this.updateResult(key, { phase: 'timeout', message: S.submit.stillGrading });
  }

  async showCompilerMessage(): Promise<void> {
    const key = this.targetUri()?.fsPath;
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
      outdated: this.unavailableIds.has(id) ? S.statementOutdated : null,
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
  /** 'submit': a question about submitting, shown right above the Submit button. */
  near: 'submit' | null;
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

