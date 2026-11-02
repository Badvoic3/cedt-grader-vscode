import { posix } from 'node:path';

/**
 * The one path normalization used for file links everywhere (mappings,
 * `.cedt-grader.json`, rename handling, reverse lookup, reconnect).
 */

/** File systems that ignore case by default (macOS APFS/HFS+, Windows NTFS). */
export const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Workspace-relative path in one canonical spelling: Unicode NFC (macOS can
 * hand out NFD names, e.g. Thai), "/" separators, "." and ".." resolved,
 * no leading "./" or trailing "/".
 */
export function normalizeRelPath(p: string): string {
  let s = (p ?? '').normalize('NFC').replace(/\\/g, '/');
  if (!s) return '';
  s = posix.normalize(s);
  if (s === '.' || s === './') return '';
  return s.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

/** Absolute path in canonical spelling (NFC, "." / ".." resolved, no trailing separator). */
export function normalizeAbsPath(p: string): string {
  const s = (p ?? '').normalize('NFC');
  const win = /^[a-zA-Z]:[\\/]/.test(s) || s.includes('\\');
  const norm = win ? s.replace(/\//g, '\\').replace(/\\+$/, '') : posix.normalize(s).replace(/\/+$/, '');
  return norm || s;
}

/** Key for comparing paths: canonical spelling, lower-cased on case-insensitive file systems. */
export function pathKey(p: string, caseInsensitive = CASE_INSENSITIVE_FS): string {
  const n = /^([a-zA-Z]:)?[\\/]/.test(p) ? normalizeAbsPath(p) : normalizeRelPath(p);
  return caseInsensitive ? n.toLowerCase() : n;
}

/**
 * New path for `p` when `oldPath` (a file, or a folder containing it) moved
 * to `newPath`; null if unaffected. Compared with `pathKey`, so NFD/NFC and
 * case differences on case-insensitive systems still match.
 */
export function remapPath(p: string, oldPath: string, newPath: string, caseInsensitive = CASE_INSENSITIVE_FS): string | null {
  const sepRe = /[\\/]/;
  const pk = pathKey(p, caseInsensitive);
  const ok = pathKey(oldPath, caseInsensitive);
  if (pk === ok) return newPath;
  const prefix = ok.endsWith('/') || ok.endsWith('\\') ? ok : ok + (ok.includes('\\') && !ok.includes('/') ? '\\' : '/');
  if (!pk.startsWith(prefix)) return null;
  // Keep the original spelling of the part below the moved folder.
  const np = normalizeAbsPath(p);
  const depth = normalizeAbsPath(oldPath).split(sepRe).length;
  const rest = np.split(sepRe).slice(depth).join(newPath.includes('\\') && !newPath.includes('/') ? '\\' : '/');
  const joiner = newPath.includes('\\') && !newPath.includes('/') ? '\\' : '/';
  return rest ? `${newPath.replace(/[\\/]+$/, '')}${joiner}${rest}` : newPath;
}
