import * as vscode from 'vscode';
import { addMissing, inScope, LinkTable, type Links, type MappingEntry, type StoredLink } from './linkTable';
import { affectedByDelete, expired, fileLinksInside, type LocatedEntry, nearestFolderLink, planRename, submitFileAfterMove, submitFileDeleted, unlinkedAround } from './mappingOps';
import { isAtOrInside, normalizeAbsPath, normalizeRelPath, pathKey, remapPath, ROOT_KEY } from './paths';
import { type AutoMatch, autoAfterDelete, autoAfterRename } from './problemFiles';
import { LIMITS } from '../shared/constants';
import { KEYS } from '../shared/stateKeys';

/** Files the user explicitly unlinked: auto-detection must not re-link them. */
const UNLINKED_KEY = KEYS.unlinked;
/** Remembered auto-matches (file name, folder name, suggestion) of files that were open. */
const AUTO_KEY = KEYS.autoMatches;
/** The key of the workspace folder itself in "not linked". */

/** A saved link without what only the table needs. */
function entryOf(link: StoredLink): MappingEntry {
  const { fsPath: _path, outside: _outside, ...entry } = link;
  return entry;
}

const located = (link: StoredLink): LocatedEntry => ({ fsPath: link.fsPath, entry: entryOf(link) });

/**
 * File → problem links, in the link table (linkTable.ts): nothing is ever
 * written to the user's folders. "Not linked" and remembered auto-matches stay
 * in workspaceState, or globalState for files outside any folder.
 *
 * A path always finds its link, whichever folder is open. What lists links
 * (`allEntries`, `linksFor`, …) shows only those of this window, see `inScope`.
 */
export class MappingStore {
  private readonly table: LinkTable;
  /** A link or "not linked" changed in this window. */
  onChanged: () => void = () => {};

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.table = new LinkTable(ctx.globalStorageUri.fsPath);
    this.table.onWrite = () => this.onChanged();
  }

  /** Where "not linked" keeps a path: `<folder name>/<pathKey(relative path)>`, or pathKey of the absolute path outside folders. */
  private keyFor(uri: vscode.Uri): { memento: vscode.Memento; key: string } {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return { memento: this.ctx.globalState, key: pathKey(uri.fsPath) };
    // asRelativePath gives the full path for the workspace folder itself.
    const rel = pathKey(folder.uri.fsPath) === pathKey(uri.fsPath) ? ROOT_KEY : normalizeRelPath(vscode.workspace.asRelativePath(uri, false));
    return { memento: this.ctx.workspaceState, key: `${folder.name}/${pathKey(rel)}` };
  }

  // ------------------------------------------------- remembered auto-matches

  /** Per-workspace memory; a window with no folder open has no lasting workspace, so it uses the global one. */
  get local(): vscode.Memento {
    return vscode.workspace.workspaceFolders?.length ? this.ctx.workspaceState : this.ctx.globalState;
  }

  autoMatches(): AutoMatch[] {
    // v1.0.0 also kept matches from CPH data: a `.prob` URL comes back as a link (src/migration/).
    return this.local.get<(Omit<AutoMatch, 'how'> & { how: string })[]>(AUTO_KEY, []).filter((a): a is AutoMatch => a.how !== 'cph');
  }

  /** Remember that an open file matched a problem automatically (never over a manual link or "not linked"). */
  async recordAuto(uri: vscode.Uri, problemId: number, how: 'filename' | 'folder' | 'suggested'): Promise<void> {
    const k = pathKey(uri.fsPath);
    const list = this.autoMatches().filter((a) => pathKey(a.fsPath) !== k);
    list.push({ fsPath: normalizeAbsPath(uri.fsPath), problemId, how, at: Date.now() });
    await this.local.update(AUTO_KEY, list.slice(-LIMITS.autoMatchesMax));
  }

  async dropAuto(uri: vscode.Uri): Promise<void> {
    const k = pathKey(uri.fsPath);
    const list = this.autoMatches();
    const next = list.filter((a) => pathKey(a.fsPath) !== k);
    if (next.length !== list.length) await this.local.update(AUTO_KEY, next);
  }

  /** Rename: an auto-match follows the file only if it still matches by name. */
  async renameAuto(oldUri: vscode.Uri, newUri: vscode.Uri, stillMatches: (fsPath: string, problemId: number) => boolean): Promise<void> {
    await this.local.update(AUTO_KEY, autoAfterRename(this.autoMatches(), oldUri.fsPath, newUri.fsPath, stillMatches));
  }

  async deleteAuto(uri: vscode.Uri): Promise<void> {
    await this.local.update(AUTO_KEY, autoAfterDelete(this.autoMatches(), uri.fsPath));
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
    return !!memento.get<Record<string, string>>(UNLINKED_KEY, {})[key] || !!this.ctx.globalState.get<Record<string, string>>(UNLINKED_KEY, {})[pathKey(uri.fsPath)];
  }

  /** "Not linked" for this file or for a folder it is in ("Don't match this folder"). */
  isUnlinkedHere(uri: vscode.Uri): boolean {
    return this.isUnlinked(uri) || this.unlinkedPaths().some((u) => isAtOrInside(uri.fsPath, u));
  }

  /**
   * The link that applies to a file: its own entry first, else the nearest
   * folder link above it (folder mode). Same server only.
   */
  async resolve(uri: vscode.Uri, baseUrl: string): Promise<{ entry: MappingEntry; folder?: string } | undefined> {
    const own = await this.get(uri, baseUrl);
    if (own && !own.folder) return { entry: own };
    const hit = nearestFolderLink(
      (await this.everyEntry()).filter((e) => !e.entry.baseUrl || e.entry.baseUrl === baseUrl),
      uri.fsPath,
    );
    return hit ? { entry: hit.entry, folder: hit.fsPath } : undefined;
  }

  /** The link used for the active file: as `resolve`, but a folder link doesn't reach a file marked "not linked". */
  async activeLink(uri: vscode.Uri, baseUrl: string): Promise<{ entry: MappingEntry; folder?: string } | undefined> {
    const link = await this.resolve(uri, baseUrl);
    return link?.folder && this.isUnlinkedHere(uri) ? undefined : link;
  }

  /** Links of single files inside a folder (they would win over a folder link there). */
  async fileLinksIn(folder: vscode.Uri, baseUrl: string): Promise<LocatedEntry[]> {
    return fileLinksInside(await this.everyEntry(), folder.fsPath, baseUrl);
  }

  /**
   * Save a folder link so that it reaches every file below it: "not linked"
   * around the folder is cleared, and so are links of single files inside to
   * the same problem. Links inside to other problems go only with `replaceOthers`.
   */
  async linkFolder(folder: vscode.Uri, entry: MappingEntry, baseUrl: string, replaceOthers: boolean): Promise<void> {
    for (const e of await this.fileLinksIn(folder, baseUrl)) {
      if (replaceOthers || e.entry.problemId === entry.problemId) await this.set(vscode.Uri.file(e.fsPath), undefined);
    }
    for (const p of unlinkedAround(this.unlinkedPaths(), folder.fsPath)) await this.setUnlinked(vscode.Uri.file(p), false);
    await this.set(folder, { ...entry, folder: true });
  }

  /** Folder mode: remember (or forget → detect again) the file Submit sends / the file the runner runs, relative to the folder. */
  async setFolderRole(folder: vscode.Uri, baseUrl: string, role: 'submitFile' | 'runFile', rel: string | undefined): Promise<void> {
    const k = pathKey(folder.fsPath);
    await this.table.change((links) => {
      const link = links[k];
      if (!link?.folder || link.staleSince || (link.baseUrl && link.baseUrl !== baseUrl)) return false;
      const next = { ...link };
      delete next[role];
      links[k] = rel ? { ...next, [role]: rel } : next;
    });
  }

  async setUnlinked(uri: vscode.Uri, on: boolean): Promise<void> {
    const { memento, key } = this.keyFor(uri);
    const all = { ...memento.get<Record<string, string>>(UNLINKED_KEY, {}) };
    if (on) all[key] = normalizeAbsPath(uri.fsPath);
    else delete all[key];
    await memento.update(UNLINKED_KEY, all);
    if (!on) await this.dropGlobal(UNLINKED_KEY, uri);
    this.onChanged();
  }

  async get(uri: vscode.Uri, baseUrl: string): Promise<MappingEntry | undefined> {
    const link = (await this.table.read())[pathKey(uri.fsPath)];
    return link && !link.staleSince && (!link.baseUrl || link.baseUrl === baseUrl) ? entryOf(link) : undefined;
  }

  /** Forget a global record of a path (kept there while it was outside every workspace folder). */
  private async dropGlobal(stateKey: string, uri: vscode.Uri): Promise<void> {
    const all = { ...this.ctx.globalState.get<Record<string, unknown>>(stateKey, {}) };
    const k = pathKey(uri.fsPath);
    if (!(k in all)) return;
    delete all[k];
    await this.ctx.globalState.update(stateKey, all);
  }

  /** The table entry for a path. */
  private linkFor(fsPath: string, entry: MappingEntry): StoredLink {
    const outside = !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
    return { ...entry, fsPath: normalizeAbsPath(fsPath), ...(outside ? { outside: true as const } : {}) };
  }

  async set(uri: vscode.Uri, entry: MappingEntry | undefined): Promise<void> {
    const k = pathKey(uri.fsPath);
    await this.table.change((links) => {
      if (!entry && !links[k]) return false;
      if (entry) links[k] = this.linkFor(uri.fsPath, entry);
      else delete links[k];
    });
    if (entry && this.isUnlinked(uri)) await this.setUnlinked(uri, false); // choosing a problem clears "not linked"
  }

  /** Files (and linked folders) mapped to a problem (saved mappings only, no workspace scan). */
  async filesFor(problemId: number, baseUrl: string): Promise<vscode.Uri[]> {
    return ((await this.reverse(baseUrl)).get(problemId) ?? []).map((l) => l.uri);
  }

  /** Saved links of a problem, each marked file or folder (folder mode). */
  async linksFor(problemId: number, baseUrl: string): Promise<{ uri: vscode.Uri; folder: boolean }[]> {
    return (await this.reverse(baseUrl)).get(problemId) ?? [];
  }

  /** Every problem id that has at least one mapped file. */
  async mappedProblemIds(baseUrl: string): Promise<Set<number>> {
    return new Set((await this.reverse(baseUrl)).keys());
  }

  private async reverse(baseUrl: string): Promise<Map<number, { uri: vscode.Uri; folder: boolean }[]>> {
    const out = new Map<number, { uri: vscode.Uri; folder: boolean }[]>();
    for (const { fsPath, entry: e } of await this.allEntries()) {
      if ((e.baseUrl && e.baseUrl !== baseUrl) || e.staleSince) continue;
      out.set(e.problemId, [...(out.get(e.problemId) ?? []), { uri: vscode.Uri.file(fsPath), folder: !!e.folder }]);
    }
    return out;
  }

  /** This window's links with their absolute paths: see `inScope`. */
  async allEntries(): Promise<LocatedEntry[]> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    return Object.values(await this.table.read()).filter((l) => inScope(l, folders)).map(located);
  }

  /** Every link in the table, also those of folders not open here (a moved folder reconnects from these). */
  async everyEntry(): Promise<LocatedEntry[]> {
    return Object.values(await this.table.read()).map(located);
  }

  /** Copy links in without touching any that exist; returns how many were added. */
  async addMissing(incoming: readonly StoredLink[]): Promise<number> {
    let added = 0;
    await this.table.change((links) => {
      added = addMissing(links, incoming);
      return added > 0;
    });
    return added;
  }

  /** Move mappings for a renamed file or folder. Returns what moved (how it was chosen is kept). */
  async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<{ from: string; to: string; entry: MappingEntry }[]> {
    let plan: { from: string; to: string; entry: MappingEntry }[] = [];
    await this.table.change((links) => {
      plan = planRename(Object.values(links).map(located), oldUri.fsPath, newUri.fsPath);
      let changed = plan.length > 0;
      for (const m of plan) delete links[pathKey(m.from)];
      for (const m of plan) links[pathKey(m.to)] = this.linkFor(m.to, m.entry);
      // Folder mode: the chosen submit / run file follows a rename inside its folder (moved out → detected again).
      for (const [k, link] of Object.entries(links)) {
        if (!link.folder) continue;
        let next = link;
        for (const role of ['submitFile', 'runFile'] as const) {
          const moved = submitFileAfterMove(link.fsPath, next[role], oldUri.fsPath, newUri.fsPath);
          if (moved === null) continue;
          next = { ...next };
          delete next[role];
          if (moved) next[role] = moved;
          changed = true;
        }
        links[k] = next;
      }
      return changed;
    });
    for (const m of plan) if (this.isUnlinked(vscode.Uri.file(m.to))) await this.setUnlinked(vscode.Uri.file(m.to), false);
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
    let count = 0;
    await this.table.change((links) => {
      const all = Object.values(links).map(located);
      const hit = affectedByDelete(all, uri.fsPath);
      count = hit.length;
      let changed = count > 0;
      for (const e of hit) {
        const k = pathKey(e.fsPath);
        links[k] = { ...links[k], staleSince: now.toISOString() };
      }
      // Folder mode: a deleted submit / run file is detected (or asked) again.
      for (const e of all) {
        if (!e.entry.folder || e.entry.staleSince) continue;
        const gone = (['submitFile', 'runFile'] as const).filter((r) => submitFileDeleted(e.fsPath, e.entry[r], uri.fsPath));
        if (!gone.length) continue;
        const k = pathKey(e.fsPath);
        const rest = { ...links[k] };
        for (const r of gone) delete rest[r];
        links[k] = rest;
        changed = true;
      }
      return changed;
    });
    return count;
  }

  private async remove(pick: (links: Links) => readonly { fsPath: string }[]): Promise<number> {
    let count = 0;
    await this.table.change((links) => {
      const gone = pick(links);
      count = gone.length;
      for (const e of gone) delete links[pathKey(e.fsPath)];
      return count > 0;
    });
    return count;
  }

  /** Remove stale mappings older than 30 days, of every folder. */
  expireStale(now = new Date()): Promise<number> {
    return this.remove((links) => expired(Object.values(links).map(located), now));
  }

  /** "Clear Cached Data": remove every stale link (file missing) of this window, whatever its age. */
  async removeStale(): Promise<number> {
    const stale = (await this.allEntries()).filter((e) => e.entry.staleSince);
    return this.remove(() => stale);
  }

  /** "Clear Cached Data" → links: remove this window's links. */
  async clearLinks(): Promise<number> {
    const mine = await this.allEntries();
    return this.remove(() => mine);
  }

  /** Re-link a mapping that belonged to a file moved outside VS Code. */
  async reconnect(from: LocatedEntry, to: vscode.Uri): Promise<void> {
    const { staleSince: _drop, ...entry } = from.entry;
    await this.table.change((links) => {
      delete links[pathKey(from.fsPath)];
      links[pathKey(to.fsPath)] = this.linkFor(to.fsPath, entry);
    });
    if (this.isUnlinked(to)) await this.setUnlinked(to, false);
  }
}
