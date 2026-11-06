import * as vscode from 'vscode';
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { Problem } from '../grader';
import { submitCandidates } from '../mapping/attachment';
import { listFolderFiles } from '../mapping/folderFiles';
import { filterSourceFiles } from '../mapping/findByName';
import {
  asksSubmitOrOpen,
  CODE_FILE,
  detectFolderRoles,
  type FolderRoles,
  folderRole,
  needsRolesForStandIn,
  type RoleWhy,
  runChoices,
  runSources,
  standInFile,
} from '../mapping/folderRoles';
import type { MappingEntry } from '../mapping/mappingFile';
import { submitFilePath } from '../mapping/mappingOps';
import { pathKey } from '../mapping/paths';
import { ATTACHMENT, TIMING } from '../shared/constants';
import type { ViewState } from '../shared/messages';
import { S } from '../shared/strings';
import type { Host } from './host';

export type FolderLink = { fsPath: string; entry: MappingEntry };

/**
 * Folder mode: a package folder linked to a problem (or matched by its
 * name). Owns the folder's source files, their texts and the detected
 * submit / run files (rules in src/mapping/folderRoles.ts).
 */
export class FolderMode {
  /** The folder link the active file belongs to (null: the file is on its own). */
  link: FolderLink | null = null;
  /** The folder is only matched by its name (not saved): folder mode as if linked; a choice saves the link. */
  matched = false;
  /** The folder's source files (relative paths), the choices for the submit file. */
  files: string[] = [];
  /** The folder's C/C++ texts and the detected submit / run files. */
  private texts = new Map<string, string>();
  private roles: FolderRoles | null = null;

  constructor(private readonly host: Host) {}

  /** The submit / run file (relative to the folder) with why; null = asked when needed. */
  role(role: 'submit' | 'run'): { file: string; why: RoleWhy } | null {
    const link = this.link;
    if (!link) return null;
    return folderRole(role, { files: this.files, submitFile: link.entry.submitFile, runFile: link.entry.runFile, texts: this.texts, roles: this.roles });
  }

  /** Folder mode for `link` (null = off): its source files, their texts and the detected roles. */
  async load(link: FolderLink | null, matched = false): Promise<void> {
    this.link = link;
    this.matched = matched;
    this.files = link ? await this.sources(link.fsPath) : [];
    this.texts = link ? await this.textsOf(link.fsPath, this.files) : new Map();
    this.roles = link ? detectFolderRoles(this.texts) : null;
  }

  /**
   * Remember the user's submit / run file for the folder (undefined = detect
   * again). A folder only matched by its name gets its link saved with it.
   */
  private async saveRole(key: 'submitFile' | 'runFile', rel: string | undefined): Promise<void> {
    const h = this.host;
    const link = this.link;
    if (!link) return;
    const folder = vscode.Uri.file(link.fsPath);
    if (this.matched) {
      if (!rel) return; // automatic already
      await h.mapping.linkFolder(folder, { ...link.entry, [key]: rel }, h.cfg.baseUrl, false);
      this.matched = false;
      await h.links.refreshMappedIds();
    } else await h.mapping.setFolderRole(folder, h.cfg.baseUrl, key, rel);
    this.link = { ...link, entry: { ...link.entry, [key]: rel } };
  }

  /** Submit confirmed an automatic folder-name match: save the folder link. True when there was one. */
  async keepMatch(): Promise<boolean> {
    const link = this.link;
    if (!link || !this.matched) return false;
    await this.host.mapping.linkFolder(vscode.Uri.file(link.fsPath), { ...link.entry }, this.host.cfg.baseUrl, false);
    this.matched = false;
    return true;
  }

  /** A problem picked in folder mode: the folder link moves to it (its submit / run files stay). */
  async setProblem(problemId: number, name: string): Promise<void> {
    const h = this.host;
    const link = this.link;
    if (!link) return;
    await h.mapping.set(vscode.Uri.file(link.fsPath), { ...link.entry, problemId, name, baseUrl: h.cfg.baseUrl });
    await h.links.refreshMappedIds();
  }

  /** A folder's name in messages: relative, or its own name for a workspace folder and anything outside. */
  private label(fsPath: string, withRoot?: boolean): string {
    const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
    if (!ws || pathKey(ws.uri.fsPath) === pathKey(fsPath)) return basename(fsPath);
    return vscode.workspace.asRelativePath(fsPath, withRoot);
  }

  /** The card's folder-mode block (submit / run file with why). */
  view(): ViewState['folder'] {
    const link = this.link;
    if (!link) return null;
    const sub = this.role('submit');
    const run = this.role('run');
    const why = (w: RoleWhy | undefined, run?: string) => (w ? S.folder.why[w](run ?? '') : null);
    return {
      path: `${this.label(link.fsPath, false)}/`,
      matched: this.matched,
      submitFile: sub?.file ?? null,
      submitWhy: why(sub?.why, run?.file),
      submitChosen: sub?.why === 'chosen',
      runFile: run?.file ?? null,
      runWhy: why(run?.why),
      runChosen: run?.why === 'chosen',
      candidates: this.files,
      runCandidates: runSources(this.files),
    };
  }

  /** The file Submit sends: folder mode → the folder's submit file (null until known); otherwise the active file. */
  targetUri(): vscode.Uri | null {
    if (!this.link) return this.host.fileUri;
    const p = submitFilePath(this.link.fsPath, this.role('submit')?.file);
    return p ? vscode.Uri.file(p) : null;
  }

  /** The file test cases belong to and CPH runs: folder mode → the run file (null until known); otherwise the active file. */
  runUri(): vscode.Uri | null {
    if (!this.link) return this.host.fileUri;
    const p = submitFilePath(this.link.fsPath, this.role('run')?.file);
    return p ? vscode.Uri.file(p) : null;
  }

  /** Source files of a folder (relative, "/" separators, path order; build output and binaries skipped). */
  async sources(folder: string): Promise<string[]> {
    const exts = this.host.allSourceExts();
    return submitCandidates(filterSourceFiles(await listFolderFiles(folder, ATTACHMENT.maxEntries), exts), exts);
  }

  /** The C/C++ texts of a folder's source files (role detection), each read up to a size cap. */
  private async textsOf(folder: string, files: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const rel of files.filter((f) => CODE_FILE.test(f))) {
      const p = join(folder, ...rel.split('/'));
      const st = await fsStat(p).catch(() => null);
      if (st && st.size <= ATTACHMENT.maxRoleFileBytes) out.set(rel, await fsReadFile(p, 'utf8').catch(() => ''));
    }
    return out;
  }

  /** The folder "Link the whole folder" would link for the active file (a workspace folder or one outside the workspace too), or why it can't. */
  modeTarget(): { dir: vscode.Uri | null; reason: string | null } {
    const file = this.host.fileUri;
    return file ? { dir: vscode.Uri.joinPath(file, '..'), reason: null } : { dir: null, reason: S.folder.openFile };
  }

  /**
   * Switch the current problem between "this file" and "the whole folder"
   * (command, header icon, header menu). File → folder: the active file's
   * folder is linked; its submit / run files are detected (when no submit
   * file is found, the active file is it). Folder → file: the folder link goes
   * and the submit file (else the active file) is linked on its own. With no
   * problem yet, the picker opens and the folder is linked to the choice.
   */
  async toggle(): Promise<void> {
    const h = this.host;
    const file = h.fileUri;
    if (!file) {
      void vscode.window.showInformationMessage(S.submit.openToSubmit);
      return;
    }
    const problem = h.currentProblem();
    if (!problem) {
      await h.chooseProblemQuickPick(async (id) => {
        const picked = h.problems.find((p) => p.id === id);
        if (picked) await this.linkActiveFolder(picked);
      });
      return;
    }
    if (this.link && !this.matched) {
      const folder = vscode.Uri.file(this.link.fsPath);
      const keep = this.targetUri() ?? file;
      await h.mapping.set(folder, undefined);
      await h.mapping.set(keep, { problemId: problem.id, name: problem.name, baseUrl: h.cfg.baseUrl });
      await h.setActiveFile(file);
      void vscode.window.setStatusBarMessage(S.folder.nowFile(keep.path.split('/').pop() ?? ''), TIMING.statusMessageMs);
      return;
    }
    await this.linkActiveFolder(problem);
  }

  /** Link the active file's folder to a problem, so that every file in it follows. */
  private async linkActiveFolder(problem: Pick<Problem, 'id' | 'name'>): Promise<void> {
    const h = this.host;
    const file = h.fileUri;
    const { dir } = this.modeTarget();
    if (!file || !dir) return;
    const label = this.label(dir.fsPath);
    const replace = [
      { id: 'replace', label: S.folder.replace, primary: true },
      { id: 'cancel', label: S.common.cancel },
    ];
    const existing = await h.mapping.get(dir, h.cfg.baseUrl);
    if (existing?.folder && existing.problemId !== problem.id) {
      if ((await h.askInline(S.folder.replaceQ(label, existing.name || `#${existing.problemId}`, problem.name), replace)) !== 'replace') return;
    }
    const others = (await h.mapping.fileLinksIn(dir, h.cfg.baseUrl)).filter((e) => e.entry.problemId !== problem.id);
    if (others.length && (await h.askInline(S.folder.replaceFilesQ(label, others.length, problem.name), replace)) !== 'replace') return;
    const files = await this.sources(dir.fsPath);
    const detected = detectFolderRoles(await this.textsOf(dir.fsPath, files)).submit;
    const own = relative(dir.fsPath, file.fsPath).split(sep).join('/');
    const entry = { problemId: problem.id, name: problem.name, baseUrl: h.cfg.baseUrl, ...(detected || files.length === 1 ? {} : { submitFile: own }) };
    await h.mapping.linkFolder(dir, entry, h.cfg.baseUrl, true);
    h.links.clearTempLink();
    await h.links.refreshMappedIds();
    await h.setActiveFile(file);
    void vscode.window.setStatusBarMessage(S.folder.nowFolder(label), TIMING.statusMessageMs);
  }

  /** The file that stands for a folder item (row click, notice, newer-file check); null when it has none. */
  async itemFile(folder: string): Promise<string | null> {
    if (!(await fsStat(folder).catch(() => null))?.isDirectory()) return null;
    const e = await this.host.mapping.get(vscode.Uri.file(folder), this.host.cfg.baseUrl);
    const files = await this.sources(folder);
    const chosen = e?.folder ? e.submitFile : undefined;
    const roles = needsRolesForStandIn(files, chosen) ? detectFolderRoles(await this.textsOf(folder, files)) : null;
    const pick = standInFile(files, chosen, roles);
    return pick ? join(folder, ...pick.split('/')) : null;
  }

  /** Open a file, or the stand-in file of a folder. */
  async openItem(fsPath: string): Promise<void> {
    const file = (await this.itemFile(fsPath)) ?? fsPath;
    if ((await fsStat(file).catch(() => null))?.isDirectory()) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(file));
    else await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  /** The user picks the submit / run file in the card ('' = automatic again). */
  async setRole(role: 'submit' | 'run', rel: string): Promise<void> {
    if (!this.link || (rel && !this.files.includes(rel))) return;
    await this.saveRole(role === 'submit' ? 'submitFile' : 'runFile', rel || undefined);
    if (this.host.fileUri) await this.host.setActiveFile(this.host.fileUri);
  }

  /** Ask once (only when detection found nothing) which file Submit sends / CPH runs. Saved with the folder link. */
  async askRole(role: 'submit' | 'run', problem: Problem, near?: 'submit'): Promise<string | null> {
    const h = this.host;
    const link = this.link;
    if (!link) return null;
    const known = this.role(role)?.file;
    if (known) return known;
    const files = role === 'submit' ? this.files : runChoices(this.files, this.roles);
    if (!files.length) {
      void h.askInline(S.folder.noSources(this.label(link.fsPath)), [{ id: 'ok', label: S.common.ok }], { tone: 'warn', near });
      return null;
    }
    let pick: string | undefined;
    const text = role === 'submit' ? S.folder.whichFile(problem.name) : S.folder.whichRunFile(problem.name);
    const detail = role === 'submit' ? S.folder.oneFile : S.folder.runFileDetail;
    if (files.length <= ATTACHMENT.maxInlineChoices) {
      const id = await h.askInline(text, [...files.map((f, i) => ({ id: String(i), label: f })), { id: 'cancel', label: S.common.cancel }], { detail, near });
      pick = id !== undefined && id !== 'cancel' ? files[Number(id)] : undefined;
    } else {
      pick = (await vscode.window.showQuickPick(files, { placeHolder: `${text} ${detail}` })) ?? undefined;
    }
    if (!pick) return null;
    await this.saveRole(role === 'submit' ? 'submitFile' : 'runFile', pick);
    return pick;
  }

  /**
   * Another source file of the folder is open (e.g. main.cpp): "Submit
   * student.h" (the submit file) or "Submit main.cpp (open file)". Asked while
   * the folder has no chosen submit file (the answer is saved as its choice).
   * true = answered, false = not asked, null = cancelled.
   */
  async askSubmitOrOpen(problem: Problem): Promise<boolean | null> {
    const link = this.link;
    const open = this.host.fileUri;
    const target = this.targetUri();
    if (!link || !open || !target) return false;
    const rel = (u: vscode.Uri) => relative(link.fsPath, u.fsPath).split(sep).join('/');
    const openRel = rel(open);
    const targetRel = rel(target);
    if (!asksSubmitOrOpen({ openRel, targetRel, files: this.files, chosenSubmit: link.entry.submitFile })) return false;
    const pick = await this.host.askInline(
      S.submit.whichFileQ(problem.name, problem.id),
      [
        { id: 'target', label: S.submit.submitNamed(targetRel), primary: true },
        { id: 'open', label: S.submit.submitOpen(openRel) },
        { id: 'cancel', label: S.common.cancel },
      ],
      { detail: S.submit.whichFileDetail, near: 'submit' },
    );
    if (pick !== 'target' && pick !== 'open') return null;
    const chosen = pick === 'open' ? openRel : targetRel;
    if (link.entry.submitFile !== chosen) await this.setRole('submit', chosen); // remembered; the card's Submits shows it
    return true;
  }
}
