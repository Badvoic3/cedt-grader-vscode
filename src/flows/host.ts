import type * as vscode from 'vscode';
import type { CphPresence } from '../cphIntegration';
import type { GraderConfig } from '../config';
import type { DataService } from '../data/dataService';
import type { StatementStore } from '../data/statementStore';
import type { GraderProvider, Language, Problem } from '../grader';
import type { MatchSource } from '../mapping/match';
import type { MappingStore } from '../mapping/store';
import type { CaseStore } from '../runner/store';
import type { Attachments } from './attachments';
import type { FolderMode } from './folderMode';
import type { Links } from './links';
import type { AskOptions, InlinePrompt, InlinePrompts } from './prompts';
import type { SubmitFlow } from './submit';
import type { TestCases } from './testcases';

/** The problem shown for the active file, with how it was matched. */
export type CurrentProblem = Problem & { source: MatchSource };

/**
 * What the flow modules (src/flows/*) need from `GraderController`: the
 * session, shared state and the other flows. The controller owns all of it;
 * a flow keeps only its own state (folder roles, results, busy flags, …).
 */
export interface Host {
  readonly ctx: vscode.ExtensionContext;
  readonly cfg: GraderConfig;
  readonly client: GraderProvider;
  readonly data: DataService;
  readonly mapping: MappingStore;
  readonly cph: CphPresence;
  readonly statementStore: StatementStore;
  /** The runner's case lists. */
  readonly cases: CaseStore;

  readonly prompts: InlinePrompts;
  readonly folder: FolderMode;
  readonly links: Links;
  readonly tests: TestCases;
  readonly submitFlow: SubmitFlow;
  readonly attachments: Attachments;

  /** The active editor's file (scheme `file`). */
  readonly fileUri: vscode.Uri | null;
  /** The problem as matched in the last `setActiveFile` (not refreshed from the list). */
  readonly problem: CurrentProblem | null;
  /** The current problem with the freshest cached data. */
  currentProblem(): CurrentProblem | null;
  problemById(id: number): Problem | undefined;
  readonly problems: Problem[];
  readonly languages: Language[];
  allowedLanguages(p: Pick<Problem, 'permittedLanguageIds'>): Language[];
  /** Every known source extension (server languages + fallback table), without the dot. */
  allSourceExts(): string[];
  /** The selected language of the submit target (null = guessed on submit). */
  readonly selectedLanguageId: number | null;
  selectLanguage(id: number): Promise<void>;

  /** The user confirmed the current problem (a suggestion / automatic match is now "Chosen by you"). */
  markChosen(problemId: number): void;
  /** The current file was unlinked: show no problem until `setActiveFile` has run again. */
  forgetProblem(): void;
  setActiveFile(uri: vscode.Uri): Promise<void>;

  emit(): void;
  log(msg: string): void;
  requestLog(line: string): void;
  describe(err: unknown): string;
  askInline(text: string, buttons: InlinePrompt['buttons'], opts?: AskOptions): Promise<string | undefined>;
  /** An error the user should read once: inline in the panel, a toast only when the panel is hidden. */
  tellInline(err: unknown, msg: string): Promise<void>;
  /** Toast only when the sidebar is hidden (otherwise the panel already shows the message). */
  showError(err: unknown, msg: string): Promise<void>;

  ensureLoggedIn(): Promise<boolean>;
  reportError(err: unknown, retry: (() => Promise<unknown>) | null): void;
  connectionOk(): void;
  markUnavailable(problemId: number): void;
  isUnavailable(problemId: number): boolean;

  url(path: string): string;
  cphSaveLocation(): string;
  /** Remember a `.prob.bak` this extension wrote ("Clear Cached Data" offers to remove it). */
  recordBackup(path: string | null | undefined): Promise<void>;
  /** Files were created / deleted / renamed (debounced refresh of the match index and folder roles). */
  onFileEvent(): void;
  focusProblemPicker(): Promise<void>;
  openStatement(problemId?: number): Promise<void>;
  /** Problem list: cached for the session; `force` = the Refresh button. */
  refreshProblems(force?: boolean): Promise<void>;
  openProblemInBrowser(problemId?: number): Promise<void>;
  /** Pick a problem for the active file; `apply` replaces the default (link what the picker chose to that file). */
  chooseProblemQuickPick(apply?: (problemId: number) => Promise<void>): Promise<void>;
  /** Set by the sidebar provider: focus something inside the panel. */
  focus(target: 'login' | 'problem-search' | 'submit' | 'result'): void;
}
