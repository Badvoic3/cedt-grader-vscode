import * as vscode from 'vscode';
import type { MappingStore } from '../mapping/store';
import { pathKey } from '../mapping/paths';
import { KEYS } from '../shared/stateKeys';
import { collectOldLinks, MAPPING_FILE_NAME } from './oldLinks';

/**
 * Copy links older versions kept into the link table. Asks nothing, because it
 * changes nothing in the user's folders, and an existing link is never
 * replaced, so what the user has done since stays.
 *
 * The state keys go once they are copied. `.cedt-grader.json` stays until the
 * user cleans up, so each folder is remembered here. A moved folder is a new
 * workspace: its file brings the links back at the new path.
 */
export async function importOldLinks(ctx: vscode.ExtensionContext, store: MappingStore): Promise<number> {
  const done = ctx.workspaceState.get<string[]>(KEYS.linksImported, []);
  const fresh = (vscode.workspace.workspaceFolders ?? []).filter((f) => !done.includes(pathKey(f.uri.fsPath)));
  const files: { folder: string; text: string }[] = [];
  for (const folder of fresh) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, MAPPING_FILE_NAME));
      files.push({ folder: folder.uri.fsPath, text: new TextDecoder().decode(bytes) });
    } catch {
      /* no file in this folder */
    }
  }
  const added = await store.addMissing(
    collectOldLinks({
      workspaceState: ctx.workspaceState.get(KEYS.mappings),
      globalState: ctx.globalState.get(KEYS.mappings),
      workspaceLegacy: ctx.workspaceState.get(KEYS.legacyMapping),
      globalLegacy: ctx.globalState.get(KEYS.legacyMapping),
      files,
    }),
  );
  for (const memento of [ctx.workspaceState, ctx.globalState]) {
    for (const k of [KEYS.mappings, KEYS.legacyMapping]) if (memento.get(k) !== undefined) await memento.update(k, undefined);
  }
  if (fresh.length) await ctx.workspaceState.update(KEYS.linksImported, [...done, ...fresh.map((f) => pathKey(f.uri.fsPath))]);
  return added;
}
