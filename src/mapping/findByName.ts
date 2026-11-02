import { basename, dirname, extname, sep } from 'node:path';
import { cleanName } from './match';

/** Folders never searched ("Find file by name"). */
export const EXCLUDED_DIRS = ['node_modules', '.git', '.cph', 'bin', 'build', 'out', 'dist', 'target', '.vscode-test'];
/** Never source files. */
export const BINARY_EXTS = new Set(['bin', 'o', 'obj', 'out', 'exe', 'zip', 'jar', 'class', 'a', 'so', 'dylib', 'dll', 'pdf']);

/** Case-insensitive glob for a literal name (`[aA][bB]…`); glob special characters become `?`. */
export function caseInsensitiveGlob(name: string): string {
  return [...name]
    .map((c) => (/[{}[\]*?,!\\]/.test(c) ? '?' : c.toLowerCase() !== c.toUpperCase() ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c))
    .join('');
}

/** `**\/<name>.{exts}` include glob for findFiles. */
export function includeGlob(problemName: string, exts: string[]): string {
  const e = exts.flatMap((x) => [x.toLowerCase(), x.toUpperCase()]);
  return `**/${caseInsensitiveGlob(cleanName(problemName))}.{${[...new Set(e)].join(',')}}`;
}

/**
 * One exclude glob: our folders + `*.dSYM` + the user's `files.exclude` /
 * `search.exclude` (keys set to true) + simple patterns from the root `.gitignore`.
 */
export function excludeGlob(settingsExcludes: Record<string, unknown>[], gitignore: string | null): string {
  const parts = new Set<string>([...EXCLUDED_DIRS.map((d) => `**/${d}/**`), '**/*.dSYM/**']);
  for (const obj of settingsExcludes) for (const [k, v] of Object.entries(obj ?? {})) if (v === true) parts.add(k);
  for (const raw of (gitignore ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || /[{}]/.test(line)) continue;
    const p = line.replace(/^\//, '').replace(/\/$/, '');
    if (!p) continue;
    parts.add(p.includes('/') ? p : `**/${p}`);
    parts.add(p.includes('/') ? `${p}/**` : `**/${p}/**`);
  }
  return `{${[...parts].join(',')}}`;
}

/** Keep only source files named exactly like the problem (case-insensitive), with a permitted extension, outside excluded folders. */
export function filterCandidates(paths: string[], problemName: string, permittedExts: string[]): string[] {
  const name = cleanName(problemName).toLowerCase();
  const exts = new Set(permittedExts.map((e) => e.toLowerCase().replace(/^\./, '')).filter((e) => e && !BINARY_EXTS.has(e)));
  return paths.filter((p) => {
    const ext = extname(p).slice(1).toLowerCase();
    if (!exts.has(ext) || BINARY_EXTS.has(ext)) return false;
    if (basename(p, extname(p)).toLowerCase() !== name) return false;
    const segs = dirname(p).split(/[\\/]/);
    return !segs.some((s) => EXCLUDED_DIRS.includes(s) || s.toLowerCase().endsWith('.dsym'));
  });
}

/** Most likely first: same folder as the active file, then most recently modified. */
export function rankCandidates(paths: string[], activeDir: string | null, mtime: (p: string) => number): string[] {
  const same = (p: string) => (activeDir !== null && dirname(p) === activeDir.replace(new RegExp(`\\${sep}$`), '') ? 0 : 1);
  return [...paths].sort((a, b) => same(a) - same(b) || mtime(b) - mtime(a) || a.localeCompare(b));
}
