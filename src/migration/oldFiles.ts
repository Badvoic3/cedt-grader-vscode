import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { stripGraderKey } from '../data/testcaseStore';
import { EXCLUDED_DIRS } from '../mapping/findByName';
import { listFolderFiles } from '../mapping/folderFiles';
import { isAtOrInside, pathKey } from '../mapping/paths';
import type { MappingStore } from '../mapping/store';
import type { CaseStore } from '../runner/store';
import type { CaseOwner } from '../runner/types';
import { LIMITS, REPO_URL } from '../shared/constants';
import { KEYS } from '../shared/stateKeys';
import { S } from '../shared/strings';
import { binaryOf, casesBySource, type CphProblem, isProbPath, planProb, readProb, sourceOf } from './cph';
import { MAPPING_FILE_NAME } from './oldLinks';

/**
 * `.prob` files, and the offer to clear old files out of the workspace.
 *
 * Importing asks nothing: it changes nothing in the folder. Each folder is
 * imported once, so a case the user deleted doesn't return. The question in
 * the panel only offers the cleanup, and it covers only what is ours
 * (`planProb`): CPH keeps its tests for other judges. An answer is remembered;
 * dismissing the question isn't an answer. Runs with a problem list at hand,
 * and makes no request.
 */
export interface OldFilesDeps {
  ctx: vscode.ExtensionContext;
  mapping: MappingStore;
  cases: CaseStore;
  baseUrl: string;
  /** The problem a source's file or folder name matches. */
  nameMatch(src: string): number | null;
  problemName(id: number): string | undefined;
  /** Links or cases were added: refresh what is shown. */
  changed(): Promise<void>;
  /** An inline question in the panel: the button's id, or undefined when dismissed or replaced. */
  ask(text: string, buttons: { id: string; label: string; primary?: boolean }[], detail?: string): Promise<string | undefined>;
}

interface BackupRecord {
  path: string;
}

/** Every `.prob` for these folders: in their `.cph/` folders, and in CPH's save location for sources inside them. */
async function findProbs(folders: readonly string[], saveLocation: string): Promise<{ path: string; prob: CphProblem; src: string; folder: string }[]> {
  const paths: { path: string; folder?: string }[] = [];
  for (const folder of folders) {
    const rels = await listFolderFiles(folder, LIMITS.indexMaxFiles, (name) => name === '.cph' || !EXCLUDED_DIRS.includes(name));
    for (const rel of rels.filter(isProbPath)) paths.push({ path: join(folder, rel), folder });
  }
  if (saveLocation) {
    for (const name of await readdir(saveLocation).catch(() => [] as string[])) if (name.endsWith('.prob')) paths.push({ path: join(saveLocation, name) });
  }
  const out: { path: string; prob: CphProblem; src: string; folder: string }[] = [];
  for (const { path, folder } of paths) {
    const prob = await readProb(path);
    if (!prob) continue;
    const src = sourceOf(path, prob.srcPath, existsSync);
    const home = folder ?? folders.find((f) => src && isAtOrInside(src, f));
    if (home) out.push({ path, prob, src, folder: home });
  }
  return out;
}

async function importCases(d: OldFilesDeps, owner: CaseOwner, prob: CphProblem, src: string): Promise<number> {
  const groups = casesBySource(prob.tests);
  // Older versions saved the grader's KEY line with its cases; Load takes it off, so this does too.
  const program = await readFile(src, 'utf8').catch(() => '');
  const asCases = groups.grader.map((c, i) => ({ testcaseId: c.testcaseId ?? 0, num: i, input: c.input, output: c.expected }));
  groups.grader = stripGraderKey(asCases, program).cases.map((c) => ({ input: c.input, expected: c.output, testcaseId: c.testcaseId }));
  return d.cases.importCases(owner, groups);
}

/** Delete, to the Trash where there is one. Returns what is still there, once the user has answered for no Trash. */
async function moveToTrash(paths: readonly string[]): Promise<string[]> {
  const stuck: string[] = [];
  for (const p of paths) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(p), { useTrash: true });
    } catch {
      if (existsSync(p)) stuck.push(p);
    }
  }
  if (!stuck.length) return [];
  const forever = S.migration.deleteForever;
  if ((await vscode.window.showWarningMessage(S.migration.noTrash(stuck.length), { modal: true }, forever)) !== forever) return stuck;
  const left: string[] = [];
  for (const p of stuck) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(p));
    } catch {
      left.push(p);
    }
  }
  return left;
}

/** A `.cph/` folder goes once nothing of CPH's is left in it. */
async function removeEmptyCphFolders(paths: readonly string[]): Promise<void> {
  for (const dir of new Set(paths.map(dirname).filter((d) => basename(d) === '.cph'))) {
    if ((await readdir(dir).catch(() => ['?'])).length) continue;
    await vscode.workspace.fs.delete(vscode.Uri.file(dir), { useTrash: true }).then(undefined, () => {});
  }
}

/**
 * Import, then what is left to ask: call the result when the panel is free.
 * Null when there is nothing to offer here.
 */
export async function migrateOldFiles(d: OldFilesDeps): Promise<(() => Promise<void>) | null> {
  const ws = d.ctx.workspaceState;
  const settled = ws.get<string[]>(KEYS.cleanupSettled, []);
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).filter((f) => !settled.includes(pathKey(f)));
  if (!folders.length) return null;
  const imported = ws.get<string[]>(KEYS.probsImported, []);
  const saveLocation = vscode.workspace.getConfiguration('cph').get<string>('general.saveLocation') ?? '';

  const targets: string[] = [];
  let added = 0;
  for (const { path, prob, src, folder } of await findProbs(folders, saveLocation)) {
    const uri = vscode.Uri.file(src || path);
    const link = src ? await d.mapping.activeLink(uri, d.baseUrl) : undefined;
    const plan = planProb(prob, d.baseUrl, link?.entry.problemId ?? null, src ? d.nameMatch(src) : null);
    if (!plan.ours) continue;
    targets.push(path, ...[`${path}.bak`, ...(src ? [binaryOf(src)] : [])].filter(existsSync));
    if (imported.includes(pathKey(folder))) continue;
    if (plan.linkTo !== null && src && existsSync(src) && !d.mapping.isUnlinkedHere(uri)) {
      await d.mapping.set(uri, { problemId: plan.linkTo, name: d.problemName(plan.linkTo) ?? prob.name, baseUrl: d.baseUrl });
      added++;
    }
    if (plan.problemId !== null) added += await importCases(d, { problemId: plan.problemId }, prob, src);
    else if (src) added += await importCases(d, { file: src }, prob, src);
  }
  await ws.update(KEYS.probsImported, [...new Set([...imported, ...folders.map((f) => pathKey(f))])]);
  if (added) await d.changed();

  targets.push(...folders.map((f) => join(f, MAPPING_FILE_NAME)).filter(existsSync));
  const backups = d.ctx.globalState.get<BackupRecord[]>(KEYS.backups, []);
  const inScope = (p: string) => /\.prob\.bak$/.test(p) && existsSync(p) && [...folders, ...(saveLocation ? [saveLocation] : [])].some((f) => isAtOrInside(p, f));
  for (const b of backups) if (inScope(b.path) && !targets.includes(b.path)) targets.push(b.path);

  const settle = () => ws.update(KEYS.cleanupSettled, [...settled, ...folders.map((f) => pathKey(f))]);
  if (!targets.length) {
    await settle();
    return null;
  }
  return async () => {
    let pick: string | undefined;
    do {
      pick = await d.ask(
        S.migration.notice,
        [
          { id: 'trash', label: S.migration.moveToTrash, primary: true },
          { id: 'new', label: S.migration.whatsNew },
          { id: 'never', label: S.migration.dontAskAgain },
        ],
        S.migration.noticeDetail(targets.length),
      );
      // The question comes back, so reading what's new doesn't cost the answer.
      if (pick === 'new') void vscode.env.openExternal(vscode.Uri.parse(`${REPO_URL}/blob/main/CHANGELOG.md`));
    } while (pick === 'new');
    if (pick === 'never') await settle();
    if (pick !== 'trash') return;
    const left = await moveToTrash(targets);
    await removeEmptyCphFolders(targets);
    await d.ctx.globalState.update(KEYS.backups, backups.filter((b) => existsSync(b.path)));
    if (!left.length) await settle();
    void d.ask(S.migration.moved(targets.length - left.length), [{ id: 'ok', label: S.common.ok }]);
  };
}
