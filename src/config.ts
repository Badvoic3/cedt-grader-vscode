import * as vscode from 'vscode';
import { DEFAULT_BASE_URL } from './grader/client';
import { CACHE } from './shared/constants';
import type { LangSetting } from './shared/i18n';
import { checkPattern, type PatternCheck } from './mapping/namePattern';

export interface GraderConfig {
  baseUrl: string;
  username: string;
  pollIntervalSeconds: number;
  confirmBeforeSubmit: boolean;
  /** Log method, path, status and cache hit/miss to the "CEDT Grader: Requests" channel. */
  debugRequests: boolean;
  /** Open problem statements beside the code (ViewColumn.Beside). */
  statementBeside: boolean;
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
  /** `en` (default), `th`, or `auto` (follow VS Code's display language). */
  displayLanguage: LangSetting;
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
  const rawBase = String(userValue('baseUrl', DEFAULT_BASE_URL) || DEFAULT_BASE_URL).trim();
  let baseUrl = DEFAULT_BASE_URL;
  try {
    const u = new URL(rawBase);
    if (u.protocol === 'https:' || u.protocol === 'http:') baseUrl = u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    /* keep default */
  }
  return {
    baseUrl,
    username: String(userValue('username', '')).trim(),
    pollIntervalSeconds: Math.max(3, Number(c.get('pollIntervalSeconds', 5)) || 5),
    confirmBeforeSubmit: c.get<boolean>('confirmBeforeSubmit', true),
    debugRequests: c.get<boolean>('debugRequests', false) === true,
    statementBeside: c.get<boolean>('statementBeside', true) !== false,
    defaultLanguage: String(c.get<string>('defaultLanguage', 'C++') || 'C++'),
    displayLanguage: ((v) => (v === 'th' || v === 'auto' ? v : 'en'))(c.get<string>('displayLanguage', 'en')),
    saveBeforeSubmit: c.get<boolean>('saveBeforeSubmit', true) !== false,
    revealResultAfterSubmit: c.get<boolean>('revealResultAfterSubmit', true) !== false,
    fileNamePattern: checkPattern(c.get<string>('fileNamePattern', '{name}.{ext}')),
    cacheMaxMB: Math.max(CACHE.maxMbMinimum, Number(c.get('cacheMaxMB', CACHE.maxMbDefault)) || CACHE.maxMbDefault),
  };
}
