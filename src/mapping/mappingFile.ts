import { normalizeRelPath, pathKey } from './paths';

/**
 * `.cedt-grader.json` at the workspace root: maps workspace-relative source
 * paths (POSIX separators) to grader problems. Pure data handling; the
 * extension does the file I/O.
 */
export interface MappingEntry {
  problemId: number;
  /** Problem short name at the time of mapping (for humans reading the file). */
  name: string;
  baseUrl?: string;
  /** Set when the mapped file was deleted / went missing; removed after 30 days (see mappingOps). */
  staleSince?: string;
}

export interface MappingFileData {
  version: 1;
  files: Record<string, MappingEntry>;
}

export const MAPPING_FILE_NAME = '.cedt-grader.json';

export function emptyMapping(): MappingFileData {
  return { version: 1, files: {} };
}

/** Lenient parse: ignores malformed entries instead of throwing. */
export function parseMappingFile(text: string): MappingFileData {
  const out = emptyMapping();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  const files = (raw as { files?: unknown })?.files;
  if (!files || typeof files !== 'object') return out;
  const byKey = new Map<string, string>(); // pathKey → stored (canonical) key; later entries win, like JSON.parse
  for (const [k, v] of Object.entries(files as Record<string, unknown>)) {
    const e = v as Partial<MappingEntry>;
    if (typeof e?.problemId === 'number' && Number.isInteger(e.problemId) && e.problemId > 0) {
      const rel = normalizeRelPath(k);
      const prev = byKey.get(pathKey(rel));
      if (prev !== undefined) delete out.files[prev];
      byKey.set(pathKey(rel), rel);
      out.files[rel] = {
        problemId: e.problemId,
        name: typeof e.name === 'string' ? e.name : '',
        ...(typeof e.baseUrl === 'string' ? { baseUrl: e.baseUrl } : {}),
        ...(typeof e.staleSince === 'string' ? { staleSince: e.staleSince } : {}),
      };
    }
  }
  return out;
}

export function serializeMappingFile(d: MappingFileData): string {
  const sorted: Record<string, MappingEntry> = {};
  for (const k of Object.keys(d.files).sort()) sorted[normalizeRelPath(k)] = d.files[k];
  return JSON.stringify({ version: 1, files: sorted }, null, 2) + '\n';
}

/** @see normalizeRelPath (one normalization for all link paths). */
export function normalizeRel(p: string): string {
  return normalizeRelPath(p);
}

/** Entry for `rel`, ignoring entries made for a different grader server. */
export function lookup(d: MappingFileData, rel: string, baseUrl: string): MappingEntry | undefined {
  const want = pathKey(rel);
  const k = Object.keys(d.files).find((x) => pathKey(x) === want);
  const e = k === undefined ? undefined : d.files[k];
  if (!e || e.staleSince) return undefined;
  if (e.baseUrl && e.baseUrl !== baseUrl) return undefined;
  return e;
}

/** Reverse lookup problem id → relative paths (for "go to file"; no workspace scan). */
export function reverseIndex(d: MappingFileData, baseUrl: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [rel, e] of Object.entries(d.files)) {
    if ((e.baseUrl && e.baseUrl !== baseUrl) || e.staleSince) continue;
    out.set(e.problemId, [...(out.get(e.problemId) ?? []), rel]);
  }
  return out;
}

/**
 * How many entries of the raw `.cedt-grader.json` text are duplicates: the
 * same key twice (JSON.parse silently keeps the last one) or keys that are
 * the same path once normalized (`./a.cpp`, `a.cpp`, `a\b.cpp` vs `a/b.cpp`).
 */
export function countDuplicateEntries(text: string): number {
  const at = text.indexOf('"files"');
  if (at < 0) return 0;
  const keys: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*:\s*\{/g;
  re.lastIndex = text.indexOf('{', at) + 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try {
      keys.push(pathKey(JSON.parse(`"${m[1]}"`) as string));
    } catch {
      keys.push(pathKey(m[1]));
    }
  }
  return keys.length - new Set(keys).size;
}
