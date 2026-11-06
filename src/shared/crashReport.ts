import { GraderError } from '../grader/errors';
import { redactPatterns } from '../grader/redact';
import { CRASH, REPO_URL } from './constants';

/**
 * The crash report: what goes into the prefilled GitHub issue. Pure, no
 * `vscode`, so the redaction is tested directly. The text the user sees is
 * the text in the URL; nothing is sent from here.
 */

/** Values that must not leave the machine. */
export interface SanitizeContext {
  extensionPath?: string;
  workspaceFolders?: readonly string[];
  home?: string;
  /** Grader username, full name, server host, OS user, machine name. */
  terms?: readonly (string | null | undefined)[];
}

export interface CrashEnv {
  extensionVersion: string;
  appName: string;
  appVersion: string;
  platform: string;
  arch: string;
}

export interface CrashInput {
  name: string;
  message: string;
  stack?: string;
  /** "command submit", "activation", … (our own words, no user data). */
  where: string;
  /** The stack comes from the panel's script, not the extension host. */
  webview?: boolean;
}

export interface CrashReport {
  title: string;
  report: string;
  url: string;
  signature: string;
}

/** What VS Code and Node reject with when nothing is wrong with the code. */
const CANCELLED = /^(AbortError|Canceled|CancellationError|TimeoutError)$/;
/** The disk or the OS said no: not a bug here. */
const SYSTEM_CODES = new Set([
  'EACCES', 'EBUSY', 'EEXIST', 'EISDIR', 'EMFILE', 'ENAMETOOLONG', 'ENFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY', 'EPERM', 'EROFS', 'EXDEV',
  'FileExists', 'FileIsADirectory', 'FileNotADirectory', 'FileNotFound', 'NoPermissions', 'Unavailable',
]);
const BUG_NAMES = new Set(['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError']);

/** Worth offering a report for: an error of ours, not the grader, the network, the disk or a cancel. */
export function isReportable(err: unknown): err is Error {
  if (!(err instanceof Error) || err instanceof GraderError) return false;
  if (CANCELLED.test(err.name) || err.message === 'Canceled') return false;
  if (err.name.includes('FileSystemError')) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && SYSTEM_CODES.has(code)) return false;
  // Node's fetch reports a lost connection as a TypeError.
  return !/^(fetch failed|terminated)$/.test(err.message);
}

/** An error the code already handled still counts when it can only be a bug. Bad JSON is bad data, not a bug. */
export function looksLikeBug(err: unknown): err is Error {
  return isReportable(err) && BUG_NAMES.has(err.name) && !(err.name === 'SyntaxError' && err.message.includes('JSON'));
}

const normalized = (text: string) => text.replace(/\\/g, '/').replace(/%20/g, ' ').toLowerCase();

/** Every extension shares the host, so the process-wide events also carry other extensions' errors. */
export function belongsToUs(stack: string | undefined, extensionPath: string): boolean {
  if (!stack || !extensionPath) return false;
  const ours = normalized(extensionPath);
  return stack.split('\n').some((l) => /^\s*at\s/.test(l) && normalized(l).includes(ours));
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A folder as written in text: either separator, any case, and the rest of the path after it. */
function underFolder(folder: string, rest: string): RegExp {
  const path = folder.replace(/[\\/]+$/, '').split(/[\\/]/).map(escapeRe).join('[\\\\/]');
  return new RegExp(`${path}${rest}`, 'gi');
}
const longestFirst = (paths: readonly string[]) => [...paths].filter((p) => p.length > 1).sort((a, b) => b.length - a.length);

/** The rest of a path. Spaces and commas count: losing a few words of a message is better than leaving a file name behind. */
const PATH_REST = `[^'"\`()<>\\n]*`;
/** Anything quoted with a separator in it is treated as a path, relative ones too. */
const QUOTED_PATH = /(['"`])[^'"`\n]*[\\/][^'"`\n]*\1/g;
const FILE_URL = /\bfile:\/\/[^\s'"`()<>]*/gi;
const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`()<>]+/gi;
const WINDOWS_PATH = new RegExp(`(?<![\\w<>~])(?:[A-Za-z]:[\\\\/]|\\\\\\\\[^\\s\\\\/]+[\\\\/])${PATH_REST}`, 'g');
const POSIX_PATH = new RegExp(`(?<![\\w.<>~/:\\\\-])\\/[^\\s'"\`()<>,;:/]+(?:\\/${PATH_REST})?`, 'g');

/** `quiz1/somsak/main.cpp`. A date or `1/2` has no letter, so it stays. */
const RELATIVE_PATH = /(?<![\p{L}\p{N}_.<>~/\\:-])[\p{L}\p{N}_.-]+(?:[\\/][\p{L}\p{N}_.-]+)+/gu;
/** A file name on its own can hold a student's name. */
const SOURCE_FILE = /(?<![\p{L}\p{N}_.-])[\p{L}\p{N}_.-]+\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|py|java|rs|go|pas|hs|rb|php|pdf|zip)(?![\p{L}\p{N}_])/giu;

function fileUrlPath(url: string): string {
  const path = url.replace(/^file:\/\/(localhost)?/i, '').replace(/^\/([A-Za-z](?::|%3A))/i, '$1');
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** A path known to be whole, so spaces can't split it. */
function reducePath(path: string, ctx: SanitizeContext): string {
  const inside = (folder: string) => new RegExp(`^${underFolder(folder, '').source}(?=$|[\\\\/])`, 'i').test(path);
  if (ctx.extensionPath && inside(ctx.extensionPath)) return path.replace(underFolder(ctx.extensionPath, ''), '<extension>').replace(/\\/g, '/');
  if (longestFirst(ctx.workspaceFolders ?? []).some(inside)) return '<workspace>/…';
  return ctx.home && inside(ctx.home) ? '~/…' : '<path>';
}

/** Strip everything personal from a message or a stack line. */
export function sanitize(text: string, ctx: SanitizeContext = {}): string {
  let out = redactPatterns(text)
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '***')
    .replace(/\b(Bearer\s+)\S+/gi, '$1***')
    .replace(/\b(token|secret|api[_-]?key|password|passwd|pwd)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, '$1$2***')
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, '<private>')
    .replace(FILE_URL, (url) => reducePath(fileUrlPath(url), ctx));
  if (ctx.extensionPath) out = out.replace(underFolder(ctx.extensionPath, ''), '<extension>');
  for (const folder of longestFirst(ctx.workspaceFolders ?? [])) out = out.replace(underFolder(folder, PATH_REST), '<workspace>/…');
  if (ctx.home) out = out.replace(underFolder(ctx.home, PATH_REST), '~/…');
  out = out
    .replace(ANY_URL, '<url>')
    .replace(QUOTED_PATH, '$1<path>$1')
    .replace(WINDOWS_PATH, '<path>')
    .replace(POSIX_PATH, '<path>')
    .replace(RELATIVE_PATH, (m) => (/\p{L}/u.test(m) ? '<path>' : m))
    .replace(SOURCE_FILE, '<file>');
  for (const term of ctx.terms ?? []) {
    const t = term?.trim();
    if (t && t.length >= 3) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`, 'giu'), '<private>');
  }
  return out;
}

/** Only our own frames: the rest says nothing about this extension and may name other extensions. */
export function ownFrames(input: CrashInput, ctx: SanitizeContext): string[] {
  const lines = (input.stack ?? '').split('\n').filter((l) => /^\s*at\s/.test(l));
  const ours = lines.flatMap((line) => {
    if (input.webview) {
      const m = /^(\s*at\s(?:.*\()?).*\/media\/dist\/([\w.-]+?)(?:\?[^\s:)]*)?(:\d+:\d+\)?)\s*$/.exec(line);
      return m ? [`${m[1]}<extension>/media/dist/${m[2]}${m[3]}`] : [];
    }
    return ctx.extensionPath && belongsToUs(line, ctx.extensionPath) ? [line] : [];
  });
  return ours.slice(0, CRASH.maxFrames).map((l) => `  ${sanitize(l.trim(), ctx)}`);
}

/** The issue form's address. The field ids are in `.github/ISSUE_TEMPLATE/crash_report.yml`. */
export function issueUrl(title: string, report: string): string {
  return `${REPO_URL}/issues/new?template=${CRASH.issueTemplate}&title=${encodeURIComponent(title)}&report=${encodeURIComponent(report)}`;
}

/** `encodeURIComponent` throws on half of a surrogate pair. */
const wellFormed = (text: string) => text.replace(/\p{Cs}/gu, '�');
const firstChars = (text: string, n: number) => Array.from(text).slice(0, n).join('');

export function buildReport(input: CrashInput, env: CrashEnv, ctx: SanitizeContext): CrashReport {
  const name = firstChars(wellFormed(sanitize(input.name, ctx)), 60);
  const where = firstChars(wellFormed(sanitize(input.where, ctx)), 60);
  let message = firstChars(wellFormed(sanitize(input.message, ctx)).replace(/\s+/g, ' ').trim(), CRASH.maxMessageChars);
  const frames = ownFrames(input, ctx).map(wellFormed);
  const signature = [name, message.replace(/\d+/g, '#'), frames[0] ?? ''].join('|');

  const title = `Crash report: ${name} in ${where}`;
  const text = () =>
    [
      `Extension: ${env.extensionVersion}`,
      `App: ${env.appName} ${env.appVersion}`,
      `OS: ${env.platform} ${env.arch}`,
      `Where: ${where}`,
      message ? `${name}: ${message}` : name,
      ...frames,
    ].join('\n');
  // Frames go first, then the message: what is cut is cut from the shown text too.
  const fits = () => issueUrl(title, text()).length <= CRASH.maxUrlLength;
  while (!fits() && frames.length > 0) frames.pop();
  while (!fits() && message.length > 0) {
    const chars = Array.from(message.replace(/…$/, ''));
    message = chars.length > 1 ? `${chars.slice(0, Math.floor(chars.length * 0.9)).join('')}…` : '';
  }
  const report = text();
  return { title, report, url: issueUrl(title, report), signature };
}

/** One prompt per distinct error per session, a few at most, one open at a time. */
export class CrashGate {
  private readonly seen = new Set<string>();
  private open = false;

  constructor(private readonly max: number) {}

  admit(signature: string): boolean {
    if (this.open || this.seen.has(signature) || this.seen.size >= this.max) return false;
    this.seen.add(signature);
    this.open = true;
    return true;
  }

  close(): void {
    this.open = false;
  }
}
