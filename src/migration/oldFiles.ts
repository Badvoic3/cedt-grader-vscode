import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
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
 * Importing asks nothing: it changes nothing in the folder. Each `.prob` is
 * imported once while it stays the same, so a case the user deleted doesn't
 * return, and nothing is offered before its cases are copied. The question in
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
  /** False once the account changed: what is left of this run must not reach the next server. */
  live(): boolean;
  /** The problem a source's file or folder name matches for sure. */
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

interface FoundProb {
  path: string;
  prob: CphProblem;
  /** A file that exists inside the folder the `.prob` is for; '' when there is none. */
  src: string;
  mtime: number;
}

/** Every `.prob` for these folders: in their `.cph/` folders, and in CPH's save location for sources inside them. */
async function findProbs(folders: readonly string[], saveLocation: string): Promise<FoundProb[]> {
  const paths: { path: string; folder?: string }[] = [];
  for (const folder of folders) {
    const rels = await listFolderFiles(folder, LIMITS.oldFilesScanMax, (name) => name === '.cph' || !EXCLUDED_DIRS.includes(name));
    for (const rel of rels.filter(isProbPath)) paths.push({ path: join(folder, rel), folder });
  }
  if (saveLocation) {
    for (const name of await readdir(saveLocation).catch(() => [] as string[])) if (name.endsWith('.prob')) paths.push({ path: join(saveLocation, name) });
  }
  const out: FoundProb[] = [];
  for (const { path, folder } of paths) {
    const prob = await readProb(path);
    if (!prob) continue;
    const src = sourceOf(path, prob.srcPath, existsSync);
    const home = folder ?? folders.find((f) => src && isAtOrInside(src, f));
    if (!home) continue;
    const mtime = (await stat(path)).mtimeMs;
    out.push({ path, prob, src: src && isAtOrInside(src, home) && existsSync(src) ? src : '', mtime });
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
 * Null when there is nothing to offer here. `again`: the user asked, so folders
 * already answered are looked at too.
 */
export async function migrateOldFiles(d: OldFilesDeps, again = false): Promise<(() => Promise<void>) | null> {
  const state = d.ctx.globalState;
  const settledNow = () => state.get<string[]>(KEYS.cleanupSettled, []);
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath).filter((f) => again || !settledNow().includes(pathKey(f)));
  if (!folders.length) return null;
  const imported = state.get<Record<string, number>>(KEYS.probsImported, {});
  const saveLocation = vscode.workspace.getConfiguration('cph').get<string>('general.saveLocation') ?? '';

  const probs = await findProbs(folders, saveLocation);
  const targets: string[] = [];
  const done: Record<string, number> = {};
  let added = 0;
  for (const { path, prob, src, mtime } of probs) {
    if (!d.live()) return null;
    const uri = src ? vscode.Uri.file(src) : null;
    const link = uri ? await d.mapping.activeLink(uri, d.baseUrl) : undefined;
    const plan = planProb(prob, d.baseUrl, link?.entry.problemId ?? null, src ? d.nameMatch(src) : null, (id) => d.problemName(id) !== undefined);
    if (!plan.ours) continue;
    if (plan.problemId === null && !src) continue; // its cases have nowhere to go, so the file stays
    targets.push(path, ...[`${path}.bak`, ...(src ? [binaryOf(src)] : [])].filter(existsSync));
    if (imported[pathKey(path)] === mtime) continue;
    if (plan.linkTo !== null && uri && !d.mapping.isUnlinkedHere(uri)) {
      // Not `set`: a link for another server looks like none here, and must stay.
      added += await d.mapping.addMissing([{ fsPath: src, problemId: plan.linkTo, name: d.problemName(plan.linkTo) ?? prob.name, baseUrl: d.baseUrl }]);
    }
    added += await importCases(d, plan.problemId !== null ? { problemId: plan.problemId } : { file: src }, prob, src);
    done[pathKey(path)] = mtime;
  }
  await state.update(KEYS.probsImported, { ...state.get<Record<string, number>>(KEYS.probsImported, {}), ...done });
  if (added) await d.changed();
  if (!d.live()) return null;

  targets.push(...folders.map((f) => join(f, MAPPING_FILE_NAME)).filter(existsSync));
  const backups = d.ctx.globalState.get<BackupRecord[]>(KEYS.backups, []);
  const inScope = (p: string) => /\.prob\.bak$/.test(p) && existsSync(p) && [...folders, ...(saveLocation ? [saveLocation] : [])].some((f) => isAtOrInside(p, f));
  for (const b of backups) if (inScope(b.path) && !targets.includes(b.path)) targets.push(b.path);

  const paths = [...new Set(targets)]; // two `.prob` files can share a source, and so its binary
  const settle = () => state.update(KEYS.cleanupSettled, [...new Set([...settledNow(), ...folders.map((f) => pathKey(f))])]);
  if (!paths.length) {
    if (!probs.length) await settle(); // another judge's `.prob` can still become ours
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
        S.migration.noticeDetail(paths.length),
      );
      // The question comes back, so reading what's new doesn't cost the answer.
      if (pick === 'new') void vscode.env.openExternal(vscode.Uri.parse(`${REPO_URL}/blob/main/CHANGELOG.md`));
    } while (pick === 'new');
    if (pick === 'never') await settle();
    if (pick !== 'trash') return;
    const left = await moveToTrash(paths);
    await removeEmptyCphFolders(paths);
    await d.ctx.globalState.update(KEYS.backups, backups.filter((b) => existsSync(b.path)));
    if (!left.length) await settle();
    if (left.length < paths.length) void d.ask(S.migration.moved(paths.length - left.length), [{ id: 'ok', label: S.common.ok }]);
  };
}
