import { join } from 'node:path';
import type { MappingEntry, StoredLink } from '../mapping/linkTable';
import { normalizeRelPath, pathKey } from '../mapping/paths';

/**
 * Links as v1.0.0 and older kept them, read only to copy them into the link
 * table (src/mapping/linkTable.ts): `<folder>/.cedt-grader.json` (paths relative
 * to the folder), and the link keys in workspaceState and globalState. No
 * `vscode` import. The release after v1.1.0 deletes `src/migration/`.
 */
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
      const rel = mappingKey(k);
      if (!insideWorkspace(rel)) continue;
      const prev = byKey.get(pathKey(rel));
      if (prev !== undefined) delete out.files[prev];
      byKey.set(pathKey(rel), rel);
      out.files[rel] = {
        problemId: e.problemId,
        name: typeof e.name === 'string' ? e.name : '',
        ...(typeof e.baseUrl === 'string' ? { baseUrl: e.baseUrl } : {}),
        ...(typeof e.staleSince === 'string' ? { staleSince: e.staleSince } : {}),
        ...(e.folder === true ? { folder: true as const } : {}),
        ...(e.folder === true ? insideFolder('submitFile', e.submitFile) : {}),
        ...(e.folder === true ? insideFolder('runFile', e.runFile) : {}),
      };
    }
  }
  return out;
}

/**
 * A key stays inside the workspace folder that holds the file: no absolute
 * path, drive letter or leading `..` (after `normalizeRelPath`). Others are
 * ignored, so a hostile file can't link a folder above the workspace (every
 * file would submit from there) or make each file switch read `/`.
 */
export function insideWorkspace(rel: string): boolean {
  return !(rel === '..' || rel.startsWith('../') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel));
}

/** The key of a link on the workspace folder itself. */
export const ROOT_KEY = '.';

/** A path's key in `.cedt-grader.json`: the canonical relative path, or `.` for the workspace folder. */
export function mappingKey(rel: string): string {
  return normalizeRelPath(rel) || ROOT_KEY;
}

/** A folder-relative path field, kept only when it stays inside the folder. */
function insideFolder(key: 'submitFile' | 'runFile', v: unknown): Partial<MappingEntry> {
  if (typeof v !== 'string') return {};
  const rel = normalizeRelPath(v);
  return rel && !rel.startsWith('..') && insideWorkspace(rel) ? { [key]: rel } : {};
}

/** A link as workspaceState and globalState held it. */
type OldStateEntry = MappingEntry & { fsPath?: unknown };

function usable(e: Partial<MappingEntry> | null | undefined): e is MappingEntry {
  return typeof e?.problemId === 'number' && Number.isInteger(e.problemId) && e.problemId > 0;
}

export interface OldLinkSources {
  /** `cedtGrader.mappings` of this workspace, and of the profile (paths outside every folder). */
  workspaceState?: Record<string, OldStateEntry>;
  globalState?: Record<string, OldStateEntry>;
  /** `cedtGrader.mapping`, the first versions' keys: absolute path → link. */
  workspaceLegacy?: Record<string, MappingEntry>;
  globalLegacy?: Record<string, MappingEntry>;
  /** `.cedt-grader.json` of each open folder. */
  files?: readonly { folder: string; text: string }[];
}

/** Every old link with its full path, in the order the old store trusted them: state first, then the files. */
export function collectOldLinks(s: OldLinkSources): StoredLink[] {
  const out = new Map<string, StoredLink>();
  const add = (fsPath: string, entry: MappingEntry, outside: boolean) => {
    if (!out.has(pathKey(fsPath))) out.set(pathKey(fsPath), { ...entry, name: entry.name ?? '', fsPath, ...(outside ? { outside: true as const } : {}) });
  };
  const state = (all: Record<string, OldStateEntry> | undefined, legacy: Record<string, MappingEntry> | undefined, outside: boolean) => {
    for (const e of Object.values(all ?? {})) {
      const { fsPath, ...entry } = e ?? {};
      if (typeof fsPath === 'string' && fsPath && usable(entry)) add(fsPath, entry, outside);
    }
    for (const [fsPath, entry] of Object.entries(legacy ?? {})) if (usable(entry)) add(fsPath, entry, outside);
  };
  state(s.workspaceState, s.workspaceLegacy, false);
  state(s.globalState, s.globalLegacy, true);
  for (const { folder, text } of s.files ?? []) {
    for (const [rel, entry] of Object.entries(parseMappingFile(text).files)) add(join(folder, rel), entry, false);
  }
  return [...out.values()];
}
