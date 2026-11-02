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
  for (const [k, v] of Object.entries(files as Record<string, unknown>)) {
    const e = v as Partial<MappingEntry>;
    if (typeof e?.problemId === 'number' && Number.isInteger(e.problemId) && e.problemId > 0) {
      out.files[normalizeRel(k)] = {
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
  for (const k of Object.keys(d.files).sort()) sorted[k] = d.files[k];
  return JSON.stringify({ version: 1, files: sorted }, null, 2) + '\n';
}

export function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Entry for `rel`, ignoring entries made for a different grader server. */
export function lookup(d: MappingFileData, rel: string, baseUrl: string): MappingEntry | undefined {
  const e = d.files[normalizeRel(rel)];
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
