import { dirname, extname, sep } from 'node:path';

/** Folders never searched ("Find file by name"). */
export const EXCLUDED_DIRS = ['node_modules', '.git', '.cph', 'bin', 'build', 'out', 'dist', 'target', '.vscode-test'];
/** Never source files. */
export const BINARY_EXTS = new Set(['bin', 'o', 'obj', 'out', 'exe', 'zip', 'jar', 'class', 'a', 'so', 'dylib', 'dll', 'pdf']);

/** `**\/*.{exts}` include glob for findFiles: every source file of the given extensions (both cases). */
export function sourceGlob(exts: string[]): string {
  const e = exts.map((x) => x.toLowerCase().replace(/^\./, '')).filter((x) => x && !BINARY_EXTS.has(x));
  return `**/*.{${[...new Set(e.flatMap((x) => [x, x.toUpperCase()]))].join(',')}}`;
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

/**
 * Keep only source files: an extension of a known language (never a binary
 * one), outside excluded folders (build output, .cph, node_modules, *.dSYM…).
 * Which problem a file belongs to is decided by the one matcher (matchIndex.ts).
 */
export function filterSourceFiles(paths: string[], sourceExts: string[]): string[] {
  const exts = new Set(sourceExts.map((e) => e.toLowerCase().replace(/^\./, '')).filter((e) => e && !BINARY_EXTS.has(e)));
  return paths.filter((p) => {
    const ext = extname(p).slice(1).toLowerCase();
    if (!exts.has(ext) || BINARY_EXTS.has(ext)) return false;
    const segs = dirname(p).split(/[\\/]/);
    return !segs.some((s) => EXCLUDED_DIRS.includes(s) || s.toLowerCase().endsWith('.dsym'));
  });
}

/** Most likely first: same folder as the active file, then most recently modified. */
export function rankCandidates(paths: string[], activeDir: string | null, mtime: (p: string) => number): string[] {
  const same = (p: string) => (activeDir !== null && dirname(p) === activeDir.replace(new RegExp(`\\${sep}$`), '') ? 0 : 1);
  return [...paths].sort((a, b) => same(a) - same(b) || mtime(b) - mtime(a) || a.localeCompare(b));
}
