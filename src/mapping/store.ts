import * as vscode from 'vscode';
import {
  emptyMapping,
  lookup,
  MAPPING_FILE_NAME,
  type MappingEntry,
  type MappingFileData,
  countDuplicateEntries,
  parseMappingFile,
  reverseIndex,
  serializeMappingFile,
} from './mappingFile';
import { affectedByDelete, expired, type LocatedEntry, planRename } from './mappingOps';
import { normalizeAbsPath, normalizeRelPath, pathKey, remapPath } from './paths';
import { type AutoMatch, autoAfterDelete, autoAfterRename } from './problemFiles';
import { LIMITS } from '../shared/constants';
import { KEYS } from '../shared/stateKeys';

const STATE_KEY = KEYS.mappings;
const LEGACY_KEY = KEYS.legacyMapping;
/** Files the user explicitly unlinked: auto-detection must not re-link them. */
const UNLINKED_KEY = KEYS.unlinked;
/** Remembered auto-matches (file name / CPH data) of files that were open. */
const AUTO_KEY = KEYS.autoMatches;

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

  /** State key: `<folder name>/<pathKey(relative path)>` (or pathKey of the absolute path outside folders). */
  private keyFor(uri: vscode.Uri): { memento: vscode.Memento; key: string; oldKey: string; folder?: vscode.WorkspaceFolder; rel?: string } {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return { memento: this.ctx.globalState, key: pathKey(uri.fsPath), oldKey: uri.fsPath };
    const rel = normalizeRelPath(vscode.workspace.asRelativePath(uri, false));
    return { memento: this.ctx.workspaceState, key: `${folder.name}/${pathKey(rel)}`, oldKey: `${folder.name}/${rel}`, folder, rel };
  }

  // ------------------------------------------------- remembered auto-matches

  autoMatches(): AutoMatch[] {
    return this.ctx.workspaceState.get<AutoMatch[]>(AUTO_KEY, []);
  }

  /** Remember that an open file matched a problem automatically (never over a manual link or "not linked"). */
  async recordAuto(uri: vscode.Uri, problemId: number, how: 'cph' | 'filename' | 'suggested'): Promise<void> {
    const k = pathKey(uri.fsPath);
    const list = this.autoMatches().filter((a) => pathKey(a.fsPath) !== k);
    list.push({ fsPath: normalizeAbsPath(uri.fsPath), problemId, how, at: Date.now() });
    await this.ctx.workspaceState.update(AUTO_KEY, list.slice(-LIMITS.autoMatchesMax));
  }

  async dropAuto(uri: vscode.Uri): Promise<void> {
    const k = pathKey(uri.fsPath);
    const list = this.autoMatches();
    const next = list.filter((a) => pathKey(a.fsPath) !== k);
    if (next.length !== list.length) await this.ctx.workspaceState.update(AUTO_KEY, next);
  }

  /** Rename: an auto-match follows the file only if it still matches by name. */
  async renameAuto(oldUri: vscode.Uri, newUri: vscode.Uri, stillMatches: (fsPath: string, problemId: number) => boolean): Promise<void> {
    await this.ctx.workspaceState.update(AUTO_KEY, autoAfterRename(this.autoMatches(), oldUri.fsPath, newUri.fsPath, stillMatches));
  }

  async deleteAuto(uri: vscode.Uri): Promise<void> {
    await this.ctx.workspaceState.update(AUTO_KEY, autoAfterDelete(this.autoMatches(), uri.fsPath));
  }

  /** Absolute paths of files explicitly marked "not linked". */
  unlinkedPaths(): string[] {
    return [this.ctx.workspaceState, this.ctx.globalState].flatMap((m) => Object.values(m.get<Record<string, string>>(UNLINKED_KEY, {})));
  }

  /** Files with a saved (non-stale) link to a problem other than `problemId`. */
  async linkedElsewhere(problemId: number, baseUrl: string): Promise<string[]> {
    return (await this.allEntries()).filter((e) => !e.entry.staleSince && e.entry.problemId !== problemId && (!e.entry.baseUrl || e.entry.baseUrl === baseUrl)).map((e) => e.fsPath);
  }

  // ------------------------------------------------- explicit "not linked"

  isUnlinked(uri: vscode.Uri): boolean {
    const { memento, key } = this.keyFor(uri);
    return !!memento.get<Record<string, string>>(UNLINKED_KEY, {})[key];
  }

  async setUnlinked(uri: vscode.Uri, on: boolean): Promise<void> {
    const { memento, key } = this.keyFor(uri);
    const all = { ...memento.get<Record<string, string>>(UNLINKED_KEY, {}) };
    if (on) all[key] = normalizeAbsPath(uri.fsPath);
    else delete all[key];
    await memento.update(UNLINKED_KEY, all);
  }

  async get(uri: vscode.Uri, baseUrl: string): Promise<MappingEntry | undefined> {
    const { memento, key, oldKey, folder, rel } = this.keyFor(uri);
    const all = memento.get<Record<string, StateEntry>>(STATE_KEY, {});
    const fromState = all[key] ?? all[oldKey] ?? this.legacy(memento)[uri.fsPath];
    if (fromState?.staleSince) return undefined;
    if (fromState && (!fromState.baseUrl || fromState.baseUrl === baseUrl)) return fromState;
    if (folder && rel) return lookup(await this.readFile(folder), rel, baseUrl);
    return undefined;
  }

  async set(uri: vscode.Uri, entry: MappingEntry | undefined): Promise<void> {
    const { memento, key, oldKey, folder, rel } = this.keyFor(uri);
    const all = { ...memento.get<Record<string, StateEntry>>(STATE_KEY, {}) };
    delete all[oldKey];
    if (entry) all[key] = { ...entry, fsPath: normalizeAbsPath(uri.fsPath) };
    else delete all[key];
    await memento.update(STATE_KEY, all);
    if (entry && this.isUnlinked(uri)) await this.setUnlinked(uri, false); // choosing a problem clears "not linked"
    const legacy = this.legacy(memento);
    if (legacy[uri.fsPath]) {
      const rest = { ...legacy };
      delete rest[uri.fsPath];
      await memento.update(LEGACY_KEY, rest);
    }

    if (folder && rel) {
      const data = await this.readFile(folder);
      for (const k of Object.keys(data.files)) if (pathKey(k) === pathKey(rel)) delete data.files[k];
      if (entry) data.files[rel] = entry;
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
      const k = pathKey(uri.fsPath);
      if (seen.has(k)) return;
      seen.set(k, uri);
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
        if (!out.has(pathKey(fsPath))) out.set(pathKey(fsPath), { fsPath, entry });
      }
      for (const [fsPath, entry] of Object.entries(this.legacy(memento))) if (!out.has(pathKey(fsPath))) out.set(pathKey(fsPath), { fsPath, entry });
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const [rel, entry] of Object.entries((await this.readFile(folder)).files)) {
        const fsPath = vscode.Uri.joinPath(folder.uri, rel).fsPath;
        if (!out.has(pathKey(fsPath))) out.set(pathKey(fsPath), { fsPath, entry });
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
    // "Not linked" follows the file too.
    for (const memento of [this.ctx.workspaceState, this.ctx.globalState]) {
      for (const fsPath of Object.values(memento.get<Record<string, string>>(UNLINKED_KEY, {}))) {
        const to = remapPath(fsPath, oldUri.fsPath, newUri.fsPath);
        if (to) {
          await this.setUnlinked(vscode.Uri.file(fsPath), false);
          await this.setUnlinked(vscode.Uri.file(to), true);
        }
      }
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

  /** "Clear Cached Data": remove every stale link (file missing), whatever its age. */
  async removeStale(): Promise<number> {
    const stale = (await this.allEntries()).filter((e) => e.entry.staleSince);
    for (const e of stale) await this.set(vscode.Uri.file(e.fsPath), undefined);
    return stale.length;
  }

  /**
   * "Clear Cached Data" → links: empty the entries of every `.cedt-grader.json`
   * (the file is kept). A file with unsaved edits in an editor is left alone.
   * The workspaceState keys are removed by the caller.
   */
  async emptyMappingFiles(): Promise<{ emptied: number; skippedDirty: number }> {
    let emptied = 0;
    let skippedDirty = 0;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = vscode.Uri.joinPath(folder.uri, MAPPING_FILE_NAME);
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (open?.isDirty) {
        skippedDirty++;
        continue;
      }
      const data = await this.readFile(folder);
      if (!Object.keys(data.files).length) continue;
      try {
        await this.writeMappingText(uri, open, serializeMappingFile(emptyMapping()));
        emptied++;
      } catch {
        // Read-only folder: nothing to do.
      }
    }
    this.invalidate();
    return { emptied, skippedDirty };
  }

  /** Re-link a mapping that belonged to a file moved outside VS Code. */
  async reconnect(from: LocatedEntry, to: vscode.Uri): Promise<void> {
    const { staleSince: _drop, ...entry } = from.entry;
    await this.set(vscode.Uri.file(from.fsPath), undefined);
    await this.set(to, entry);
  }

  /**
   * Remove duplicate links: a file stored under both the old (absolute path)
   * and the new key, or duplicate entries in `.cedt-grader.json`. Returns how
   * many duplicates were removed (the caller tells the user).
   */
  async cleanupDuplicates(): Promise<number> {
    let removed = 0;
    // 1. Workspace state: one entry per file (canonical key; legacy absolute-path keys folded in).
    for (const memento of [this.ctx.workspaceState, this.ctx.globalState]) {
      const current = memento.get<Record<string, StateEntry>>(STATE_KEY, {});
      const legacy = this.legacy(memento);
      const rebuilt: Record<string, StateEntry> = {};
      const add = (fsPath: string, entry: MappingEntry) => {
        const { key } = this.keyFor(vscode.Uri.file(fsPath));
        if (rebuilt[key]) removed++;
        else rebuilt[key] = { ...entry, fsPath: normalizeAbsPath(fsPath) };
      };
      for (const e of Object.values(current)) {
        const { fsPath, ...entry } = e;
        add(fsPath, entry);
      }
      for (const [fsPath, entry] of Object.entries(legacy)) add(fsPath, entry);
      const changed =
        Object.keys(legacy).length > 0 || JSON.stringify(Object.keys(rebuilt).sort()) !== JSON.stringify(Object.keys(current).sort());
      if (changed) {
        await memento.update(STATE_KEY, rebuilt);
        if (Object.keys(legacy).length) await memento.update(LEGACY_KEY, undefined);
      }
    }
    // 2. .cedt-grader.json: duplicate / same-path keys (./x.cpp vs x.cpp, NFD vs NFC, case on macOS).
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const uri = vscode.Uri.joinPath(folder.uri, MAPPING_FILE_NAME);
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (open?.isDirty) continue; // never clobber unsaved edits; cleaned on the next save
      let text: string;
      try {
        text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        continue;
      }
      const before = countDuplicateEntries(text);
      const data = parseMappingFile(text); // later entries win, like JSON.parse
      const cleaned = serializeMappingFile(data);
      if (!before && cleaned.trim() === text.trim()) continue;
      if (!before) {
        // Only spelling changes (e.g. "./"): rewrite quietly.
        await this.writeMappingText(uri, open, cleaned);
        this.cache.set(folder.uri.toString(), data);
        continue;
      }
      await this.writeMappingText(uri, open, cleaned);
      this.cache.set(folder.uri.toString(), data);
      // Count only what really changed on disk.
      const after = countDuplicateEntries(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
      removed += Math.max(0, before - after);
    }
    return removed;
  }

  /** Write `.cedt-grader.json`; through the open editor if it is open (so the change is visible and saved). */
  private async writeMappingText(uri: vscode.Uri, open: vscode.TextDocument | undefined, text: string): Promise<void> {
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)), text);
      await vscode.workspace.applyEdit(edit);
      await open.save();
      return;
    }
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
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
