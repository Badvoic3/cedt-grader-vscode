import * as vscode from 'vscode';
import {
  emptyMapping,
  lookup,
  MAPPING_FILE_NAME,
  type MappingEntry,
  type MappingFileData,
  normalizeRel,
  parseMappingFile,
  reverseIndex,
  serializeMappingFile,
} from './mappingFile';
import { affectedByDelete, expired, type LocatedEntry, planRename } from './mappingOps';

const STATE_KEY = 'cedtGrader.mappings';
const LEGACY_KEY = 'cedtGrader.mapping';

/** workspaceState entry: also remembers the absolute path, for reverse lookup. */
interface StateEntry extends MappingEntry {
  fsPath: string;
}

/**
 * File → problem mapping.
 * - workspaceState, keyed by the file's path relative to its workspace folder
 *   (`<folder name>/<relative path>`); files outside any folder use globalState
 *   keyed by absolute path;
 * - plus `<folder>/.cedt-grader.json` (relative paths) so mappings survive
 *   moving machines.
 */
export class MappingStore {
  private cache = new Map<string, MappingFileData>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private keyFor(uri: vscode.Uri): { memento: vscode.Memento; key: string; folder?: vscode.WorkspaceFolder; rel?: string } {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return { memento: this.ctx.globalState, key: uri.fsPath };
    const rel = normalizeRel(vscode.workspace.asRelativePath(uri, false));
    return { memento: this.ctx.workspaceState, key: `${folder.name}/${rel}`, folder, rel };
  }

  async get(uri: vscode.Uri, baseUrl: string): Promise<MappingEntry | undefined> {
    const { memento, key, folder, rel } = this.keyFor(uri);
    const all = memento.get<Record<string, StateEntry>>(STATE_KEY, {});
    const fromState = all[key] ?? this.legacy(memento)[uri.fsPath];
    if (fromState?.staleSince) return undefined;
    if (fromState && (!fromState.baseUrl || fromState.baseUrl === baseUrl)) return fromState;
    if (folder && rel) return lookup(await this.readFile(folder), rel, baseUrl);
    return undefined;
  }

  async set(uri: vscode.Uri, entry: MappingEntry | undefined): Promise<void> {
    const { memento, key, folder, rel } = this.keyFor(uri);
    const all = { ...memento.get<Record<string, StateEntry>>(STATE_KEY, {}) };
    if (entry) all[key] = { ...entry, fsPath: uri.fsPath };
    else delete all[key];
    await memento.update(STATE_KEY, all);
    const legacy = this.legacy(memento);
    if (legacy[uri.fsPath]) {
      const rest = { ...legacy };
      delete rest[uri.fsPath];
      await memento.update(LEGACY_KEY, rest);
    }

    if (folder && rel) {
      const data = await this.readFile(folder);
      if (entry) data.files[rel] = entry;
      else delete data.files[rel];
      this.cache.set(folder.uri.toString(), data);
      try {
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(folder.uri, MAPPING_FILE_NAME),
          new TextEncoder().encode(serializeMappingFile(data)),
        );
      } catch {
        // Read-only folder: workspaceState still has it.
      }
    }
  }

  /** Files mapped to a problem (saved mappings only, no workspace scan). */
  async filesFor(problemId: number, baseUrl: string): Promise<vscode.Uri[]> {
    return (await this.reverse(baseUrl)).get(problemId) ?? [];
  }

  /** Every problem id that has at least one mapped file. */
  async mappedProblemIds(baseUrl: string): Promise<Set<number>> {
    return new Set((await this.reverse(baseUrl)).keys());
  }

  private async reverse(baseUrl: string): Promise<Map<number, vscode.Uri[]>> {
    const seen = new Map<string, vscode.Uri>();
    const out = new Map<number, vscode.Uri[]>();
    const add = (id: number, uri: vscode.Uri) => {
      if (seen.has(uri.fsPath)) return;
      seen.set(uri.fsPath, uri);
      out.set(id, [...(out.get(id) ?? []), uri]);
    };
    for (const memento of [this.ctx.workspaceState, this.ctx.globalState]) {
      for (const e of Object.values(memento.get<Record<string, StateEntry>>(STATE_KEY, {}))) {
        if ((!e.baseUrl || e.baseUrl === baseUrl) && !e.staleSince) add(e.problemId, vscode.Uri.file(e.fsPath));
      }
      for (const [fsPath, e] of Object.entries(this.legacy(memento))) {
        if (!e.baseUrl || e.baseUrl === baseUrl) add(e.problemId, vscode.Uri.file(fsPath));
      }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const [id, rels] of reverseIndex(await this.readFile(folder), baseUrl)) {
        for (const rel of rels) add(id, vscode.Uri.joinPath(folder.uri, rel));
      }
    }
    return out;
  }

  /** Every saved mapping with its absolute path (state first, then .cedt-grader.json files). */
  async allEntries(): Promise<LocatedEntry[]> {
    const out = new Map<string, LocatedEntry>();
    for (const memento of [this.ctx.workspaceState, this.ctx.globalState]) {
      for (const e of Object.values(memento.get<Record<string, StateEntry>>(STATE_KEY, {}))) {
        const { fsPath, ...entry } = e;
        if (!out.has(fsPath)) out.set(fsPath, { fsPath, entry });
      }
      for (const [fsPath, entry] of Object.entries(this.legacy(memento))) if (!out.has(fsPath)) out.set(fsPath, { fsPath, entry });
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const [rel, entry] of Object.entries((await this.readFile(folder)).files)) {
        const fsPath = vscode.Uri.joinPath(folder.uri, rel).fsPath;
        if (!out.has(fsPath)) out.set(fsPath, { fsPath, entry });
      }
    }
    return [...out.values()];
  }

  /** Move mappings for a renamed file or folder. Returns what moved (how it was chosen is kept). */
  async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<{ from: string; to: string; entry: MappingEntry }[]> {
    const plan = planRename(await this.allEntries(), oldUri.fsPath, newUri.fsPath);
    for (const m of plan) {
      await this.set(vscode.Uri.file(m.from), undefined);
      await this.set(vscode.Uri.file(m.to), m.entry);
    }
    return plan;
  }

  /** A mapped file (or folder) was deleted: keep the mapping but mark it stale, so a moved file can reconnect. */
  async markDeleted(uri: vscode.Uri, now = new Date()): Promise<number> {
    const hit = affectedByDelete(await this.allEntries(), uri.fsPath);
    for (const e of hit) await this.set(vscode.Uri.file(e.fsPath), { ...e.entry, staleSince: now.toISOString() });
    return hit.length;
  }

  /** Remove stale mappings older than 30 days. */
  async expireStale(now = new Date()): Promise<number> {
    const old = expired(await this.allEntries(), now);
    for (const e of old) await this.set(vscode.Uri.file(e.fsPath), undefined);
    return old.length;
  }

  /** Re-link a mapping that belonged to a file moved outside VS Code. */
  async reconnect(from: LocatedEntry, to: vscode.Uri): Promise<void> {
    const { staleSince: _drop, ...entry } = from.entry;
    await this.set(vscode.Uri.file(from.fsPath), undefined);
    await this.set(to, entry);
  }

  private legacy(memento: vscode.Memento): Record<string, MappingEntry> {
    return memento.get<Record<string, MappingEntry>>(LEGACY_KEY, {});
  }

  invalidate(): void {
    this.cache.clear();
  }

  private async readFile(folder: vscode.WorkspaceFolder): Promise<MappingFileData> {
    const key = folder.uri.toString();
    const cached = this.cache.get(key);
    if (cached) return cached;
    let data = emptyMapping();
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, MAPPING_FILE_NAME));
      data = parseMappingFile(new TextDecoder().decode(bytes));
    } catch {
      /* no file yet */
    }
    this.cache.set(key, data);
    return data;
  }
}
