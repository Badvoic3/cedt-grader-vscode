import * as vscode from 'vscode';
import { BREAK, CACHE, DEFAULT_BASE_URL, RUNNER } from './shared/constants';
import { normalizeServerUrl } from './shared/serverUrl';
import type { LangSetting } from './shared/i18n';
import { checkPattern, type PatternCheck } from './mapping/namePattern';
import { normalizeSections, type SectionId } from './shared/layout';
import type { BadgeMode } from './mapping/explorerBadge';
import { BREAK_SCENES, type BreakSceneSetting } from './flows/breakRules';

export interface GraderConfig {
  baseUrl: string;
  username: string;
  pollIntervalSeconds: number;
  confirmBeforeSubmit: boolean;
  /** Log method, path, status and cache hit/miss to the "Grader Submit: Requests" channel. */
  debugRequests: boolean;
  /** Open problem statements beside the code (ViewColumn.Beside). */
  statementBeside: boolean;
  /** An open statement tab follows the active file's problem (closes for a source file with none). */
  statementFollowsFile: boolean;
  /** Language for new files when the active file's language isn't permitted (default C++). */
  defaultLanguage: string;
  /** Size limit of downloaded files (statements, test cases), in MB. */
  cacheMaxMB: number;
  /** Save the file before submitting, so the grader gets what is on disk (default on). */
  saveBeforeSubmit: boolean;
  /** Open and scroll to the Result section when grading finishes (default on). */
  revealResultAfterSubmit: boolean;
  /** File-name pattern for New file / Rename / exact matching (invalid → default, with the reason). */
  fileNamePattern: PatternCheck;
  /** Panel sections shown, in order (`cedtGrader.panel.sections`). */
  panelSections: SectionId[];
  /** Compact panel (`cedtGrader.panel.compact`). */
  panelCompact: boolean;
  /** Show the panel when a window starts (`cedtGrader.panel.openOnStartup`). */
  panelOpenOnStartup: boolean;
  /** Topic pill clicks: show only first (default) or hide first (`cedtGrader.panel.topicClickOrder`). */
  topicClickOrder: 'showFirst' | 'hideFirst';
  /** Run limits when the grader gives none (`cedtGrader.runner.*`). */
  runnerDefaultTimeSeconds: number;
  runnerDefaultMemoryMB: number;
  /** Tool name → path. These run programs, so they are read from the user's settings only. */
  runnerCompilerPaths: Record<string, string>;
  /** Language → extra compiler arguments (`cpp`, `c`, `java`, `rust`, `go`, `haskell`). */
  runnerExtraCompileArgs: Record<string, string[]>;
  /** What an Explorer badge shows (`cedtGrader.explorer.badge`). */
  explorerBadge: BadgeMode;
  /** Explorer badges in colour (`cedtGrader.explorer.colors`). */
  explorerColors: boolean;
  /** The first-full-score celebration (`cedtGrader.fun.celebrate`, off when `cedtGrader.fun.enabled` is off). */
  funCelebrate: boolean;
  /** The break reminder (`cedtGrader.fun.breakReminder`, off when `cedtGrader.fun.enabled` is off). */
  funBreakReminder: boolean;
  /** Minutes of activity before the break hint (`cedtGrader.fun.breakMinutes`, at least 30). */
  funBreakMinutes: number;
  /** Which scene a break opens (`cedtGrader.fun.breakScene`). */
  funBreakScene: BreakSceneSetting;
  /** `en` (default), `th`, or `auto` (follow VS Code's display language). */
  displayLanguage: LangSetting;
}

function stringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1]));
}

function argsRecord(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== 'object') return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every((a) => typeof a === 'string')));
}

/**
 * Security-relevant settings are read from the *user* (global) scope only, so
 * a cloned repository's `.vscode/settings.json` cannot redirect the login to
 * another server.
 */
export function readConfig(): GraderConfig {
  const c = vscode.workspace.getConfiguration('cedtGrader');
  const userValue = <T>(key: string, fallback: T): T => {
    const i = c.inspect<T>(key);
    return (i?.globalValue ?? i?.defaultValue ?? fallback) as T;
  };
  const baseUrl = normalizeServerUrl(String(userValue('baseUrl', DEFAULT_BASE_URL) || DEFAULT_BASE_URL)) ?? DEFAULT_BASE_URL;
  return {
    baseUrl,
    username: String(userValue('username', '')).trim(),
    pollIntervalSeconds: Math.max(3, Number(c.get('pollIntervalSeconds', 5)) || 5),
    confirmBeforeSubmit: c.get<boolean>('confirmBeforeSubmit', true),
    debugRequests: c.get<boolean>('debugRequests', false) === true,
    statementBeside: c.get<boolean>('statementBeside', true) !== false,
    statementFollowsFile: c.get<boolean>('statementFollowsFile', true) !== false,
    defaultLanguage: String(c.get<string>('defaultLanguage', 'C++') || 'C++'),
    displayLanguage: ((v) => (v === 'th' || v === 'auto' ? v : 'en'))(c.get<string>('displayLanguage', 'en')),
    saveBeforeSubmit: c.get<boolean>('saveBeforeSubmit', true) !== false,
    revealResultAfterSubmit: c.get<boolean>('revealResultAfterSubmit', true) !== false,
    panelSections: normalizeSections(c.get<unknown>('panel.sections')),
    panelCompact: c.get<boolean>('panel.compact', false) === true,
    panelOpenOnStartup: c.get<boolean>('panel.openOnStartup', true) !== false,
    topicClickOrder: c.get<string>('panel.topicClickOrder', 'showFirst') === 'hideFirst' ? 'hideFirst' : 'showFirst',
    fileNamePattern: checkPattern(c.get<string>('fileNamePattern', '{name}.{ext}')),
    explorerBadge: ((v) => (v === 'tag' || v === 'off' ? v : 'score'))(c.get<string>('explorer.badge', 'score')),
    explorerColors: c.get<boolean>('explorer.colors', true) !== false,
    funCelebrate: c.get<boolean>('fun.enabled', true) !== false && c.get<boolean>('fun.celebrate', true) !== false,
    funBreakReminder: c.get<boolean>('fun.enabled', true) !== false && c.get<boolean>('fun.breakReminder', true) !== false,
    funBreakMinutes: Math.max(BREAK.minMinutes, Math.round(Number(c.get('fun.breakMinutes', BREAK.defaultMinutes)) || BREAK.defaultMinutes)),
    funBreakScene: ((v) => ((BREAK_SCENES as readonly string[]).includes(v) ? (v as BreakSceneSetting) : 'random'))(c.get<string>('fun.breakScene', 'random')),
    cacheMaxMB: Math.max(CACHE.maxMbMinimum, Number(c.get('cacheMaxMB', CACHE.maxMbDefault)) || CACHE.maxMbDefault),
    runnerDefaultTimeSeconds: Math.max(0.1, Number(c.get('runner.defaultTimeLimitSeconds', RUNNER.defaultTimeSeconds)) || RUNNER.defaultTimeSeconds),
    runnerDefaultMemoryMB: Math.max(1, Number(c.get('runner.defaultMemoryLimitMB', RUNNER.defaultMemoryMB)) || RUNNER.defaultMemoryMB),
    runnerCompilerPaths: stringRecord(userValue<unknown>('runner.compilerPaths', {})),
    runnerExtraCompileArgs: argsRecord(userValue<unknown>('runner.extraCompileArgs', {})),
  };
}
