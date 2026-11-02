import * as vscode from 'vscode';
import {
  emptyMapping,
  lookup,
  MAPPING_FILE_NAME,
  type MappingEntry,
  type MappingFileData,
  parseMappingFile,
  serializeMappingFile,
} from './mappingFile';

const STATE_KEY = 'cedtGrader.mapping';

/**
 * File → problem mapping. Inside a workspace folder it is stored in
 * `<folder>/.cedt-grader.json` (portable, can be committed) and mirrored in
 * workspaceState; files outside any folder use globalState keyed by path.
 */
export class MappingStore {
  private cache = new Map<string, MappingFileData>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async get(uri: vscode.Uri, baseUrl: string): Promise<MappingEntry | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      const rel = vscode.workspace.asRelativePath(uri, false);
      const fromFile = lookup(await this.readFile(folder), rel, baseUrl);
      if (fromFile) return fromFile;
      const ws = this.ctx.workspaceState.get<Record<string, MappingEntry>>(STATE_KEY, {});
      const e = ws[uri.fsPath];
      return e && (!e.baseUrl || e.baseUrl === baseUrl) ? e : undefined;
    }
    const g = this.ctx.globalState.get<Record<string, MappingEntry>>(STATE_KEY, {});
    const e = g[uri.fsPath];
    return e && (!e.baseUrl || e.baseUrl === baseUrl) ? e : undefined;
  }

  async set(uri: vscode.Uri, entry: MappingEntry | undefined): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const memento = folder ? this.ctx.workspaceState : this.ctx.globalState;
    const all = { ...memento.get<Record<string, MappingEntry>>(STATE_KEY, {}) };
    if (entry) all[uri.fsPath] = entry;
    else delete all[uri.fsPath];
    await memento.update(STATE_KEY, all);

    if (folder) {
      const data = await this.readFile(folder);
      const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
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
