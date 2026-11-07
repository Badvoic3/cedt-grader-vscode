import * as vscode from 'vscode';
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises';
import type { Problem } from '../grader';
import { EXTENSION_LANGUAGE } from '../grader/languages';
import { BINARY_EXTS, excludeGlob, filterSourceFiles, rankCandidates, sourceGlob } from '../mapping/findByName';
import { autoDetectOutcome, pickScope, unlinkScope } from '../mapping/linkActions';
import { cleanName, fileNameFor, resolveProblem } from '../mapping/match';
import { buildMatchIndex, folderNames, type IndexedFile, matchFile, OnceCache, type SourceFile } from '../mapping/matchIndex';
import { dismissKey, type LocatedEntry, pathState, reconnectCandidates } from '../mapping/mappingOps';
import { createFileNoOverwrite } from '../mapping/newFile';
import { chooseNewFileLanguage } from '../mapping/newFileLanguage';
import { isAtOrInside, pathKey } from '../mapping/paths';
import { comparePaths, linkedNotice, mergeProblemFiles, noticeDismissed, noticeSignature, type ProblemFile } from '../mapping/problemFiles';
import { freeName, invalidFileName, renameProposal } from '../mapping/renameToProblem';
import { confirmSuggestion } from '../mapping/suggestionGate';
import { LIMITS, TIMING } from '../shared/constants';
import { dateLocale } from '../shared/i18n';
import type { ViewState } from '../shared/messages';
import { KEYS } from '../shared/stateKeys';
import { PICK_HOW, S } from '../shared/strings';
import type { CurrentProblem, Host } from './host';

type FoundFile = { uri: vscode.Uri; t: number; how: ProblemFile['how'] };

const stillThere = async (fsPath: string) => (await pathState(fsPath)).kind !== 'missing';

/**
 * Links and the matching UI: files for a problem (one matcher, both
 * directions: src/mapping/matchIndex.ts), the temporary link of a row click,
 * link / unlink / auto-detect / rename, new file, find a matching file, and
 * the "keep the link?" question after a move outside VS Code.
 */
export class Links {
  /** Files for the current problem (duplicate notice): saved links, remembered auto-matches, name matches. */
  linkedFiles: ProblemFile[] = [];
  /** Problems with at least one mapped file (for "go to file"). */
  mappedIds = new Set<number>();
  /**
   * Problem → files with the ONE matcher (matchIndex.ts): one workspace.findFiles of source
   * files, cached until a file is created / deleted / renamed (debounced) or the list reloads.
   */
  private readonly index = new OnceCache<Map<number, IndexedFile[]>>(() => this.buildIndex(), () => new Map());
  /**
   * Temporary link (row click opened a name-matched / suggested file): the panel shows that
   * problem for the file, marked "Suggested · Use this", until another file becomes active.
   */
  private tempLink: { key: string; problemId: number } | null = null;
  /** Files already asked about "keep the link?" this session. */
  private readonly reconnectAsked = new Set<string>();

  constructor(private readonly host: Host) {}

  // ------------------------------------------------------------ active file

  /** Another file became active: a temporary link is "for that action only". */
  onFileChanged(uri: vscode.Uri): void {
    if (this.tempLink && this.tempLink.key !== pathKey(uri.fsPath)) this.tempLink = null;
  }

  /** The problem of a temporary link for this file (undefined: none). */
  tempProblemFor(uri: vscode.Uri): Problem | undefined {
    return this.tempLink && this.tempLink.key === pathKey(uri.fsPath) ? this.host.problemById(this.tempLink.problemId) : undefined;
  }

  clearTempLink(): void {
    this.tempLink = null;
  }

  /** A file with no saved link was opened: ask (once per file and session) whether a moved link is this file. */
  maybeOfferReconnect(uri: vscode.Uri): void {
    if (!this.reconnectAsked.has(uri.fsPath)) void this.offerReconnect(uri);
  }

  invalidateIndex(): void {
    this.index.invalidate();
  }

  hasIndex(): boolean {
    return !!this.index.peek();
  }

  /** The "files for this problem" notice as the panel shows it. */
  noticeView(problem: Problem | null, file: vscode.Uri | null): Pick<ViewState, 'linkedFiles' | 'linkedNotice'> {
    const hidden = !!problem && noticeDismissed(this.host.ctx.workspaceState.get<Record<string, string>>(KEYS.dismissedNotices, {}), problem.id, this.linkedFiles);
    const n = problem && file && !hidden ? linkedNotice(this.linkedFiles, file.fsPath, (f) => vscode.workspace.asRelativePath(f)) : null;
    return { linkedFiles: n ? n.files.map(({ path, current, how }) => ({ path, current, how })) : [], linkedNotice: n?.text ?? null };
  }

  // ------------------------------------------------ files for a problem

  /**
   * The one "files for this problem" answer (duplicate notice, row click /
   * go to file, before-submit check): saved links, remembered auto-matches and
   * what the one matcher assigns to this problem (match index). Explicit "not
   * linked" files and files linked to another problem are left out.
   * `search`: 'run' builds the index if needed; 'cached' uses only a finished one.
   */
  async filesForProblem(problemId: number, search: 'run' | 'cached' | 'none' = 'run', includeSuggested = true): Promise<ProblemFile[]> {
    const h = this.host;
    const chosen = (await h.mapping.filesFor(problemId, h.cfg.baseUrl)).map((u) => u.fsPath);
    let index: Map<number, IndexedFile[]> | undefined;
    if (search === 'run') index = await this.index.get();
    else if (search === 'cached') index = await this.index.peek();
    return mergeProblemFiles({
      problemId,
      chosen,
      auto: h.mapping.autoMatches(),
      matched: index?.get(problemId) ?? [],
      unlinked: h.mapping.unlinkedPaths(),
      linkedElsewhere: await h.mapping.linkedElsewhere(problemId, h.cfg.baseUrl),
      includeSuggested,
    });
  }

  /** Recompute the current problem's files (runs the name search if needed) and re-render. */
  async refreshLinkedFiles(): Promise<void> {
    const h = this.host;
    const p = h.problem;
    const file = h.fileUri;
    if (!p || !file || !h.data.isVisible()) return;
    const files = await this.filesForProblem(p.id, 'run');
    if (h.problem?.id !== p.id || h.fileUri?.fsPath !== file.fsPath) return;
    this.linkedFiles = files;
    h.emit();
  }

  /** Source extensions of the problem's permitted languages (binary/archive ones skipped). */
  private sourceExtsFor(p: Problem): string[] {
    const exts = new Set<string>();
    for (const l of this.host.allowedLanguages(p)) {
      if (l.ext && !BINARY_EXTS.has(l.ext.toLowerCase())) exts.add(l.ext.toLowerCase());
      // Other extensions of the same language (e.g. .cc / .cxx for C++).
      for (const [ext, lang] of Object.entries(EXTENSION_LANGUAGE)) if (lang === l.name) exts.add(ext.slice(1));
    }
    return [...exts];
  }

  /** A workspace file as the matcher sees it (path + workspace-relative parent folders for the folder/tag bonus). */
  sourceFile(fsPath: string): SourceFile {
    const file = vscode.Uri.file(fsPath);
    const dir = vscode.Uri.joinPath(file, '..');
    const ws = vscode.workspace.getWorkspaceFolder(file);
    return { fsPath, folders: folderNames(dir.fsPath, vscode.workspace.asRelativePath(dir, false), ws ? { path: ws.uri.fsPath, name: ws.name } : null) };
  }

  /** Where a new file or attachment goes: the active file's folder, the first workspace folder, else the user picks one. */
  async targetFolder(): Promise<vscode.Uri | undefined> {
    const h = this.host;
    const known = (h.fileUri ? vscode.Uri.joinPath(h.fileUri, '..') : undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (known) return known;
    return (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: S.files.saveHere }))?.[0];
  }

  /**
   * Build the match index: one workspace.findFiles of source files (same
   * exclusions as everywhere: settings, .gitignore, build folders, binaries),
   * then the one matcher per file. Logged as a file search.
   */
  private async buildIndex(): Promise<Map<number, IndexedFile[]>> {
    const h = this.host;
    const problems = h.data.problemList()?.problems;
    if (!problems?.length) {
      queueMicrotask(() => this.index.invalidate()); // not ready yet: don't keep an empty index
      return new Map();
    }
    const cfg = (section: string) => vscode.workspace.getConfiguration(section).get<Record<string, unknown>>('exclude') ?? {};
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    let gitignore: string | null = null;
    if (root) gitignore = await fsReadFile(vscode.Uri.joinPath(root, '.gitignore').fsPath, 'utf8').catch(() => null);
    const t0 = Date.now();
    const exts = h.allSourceExts();
    const found = await vscode.workspace.findFiles(sourceGlob(exts), excludeGlob([cfg('files'), cfg('search')], gitignore), LIMITS.indexMaxFiles);
    const files = filterSourceFiles(found.map((u) => u.fsPath), exts).map((f) => this.sourceFile(f));
    const index = buildMatchIndex(files, problems, h.cfg.baseUrl, h.cfg.fileNamePattern.pattern);
    const matched = [...index.values()].reduce((n, l) => n + l.length, 0);
    h.requestLog(`FILE SEARCH source files: ${files.length} → ${matched} matched to ${index.size} problems (${Date.now() - t0} ms)`);
    return index;
  }

  /** Does the one matcher (without saved links) give `problemId` for this path? */
  matcherSays(fsPath: string, problemId: number): boolean {
    const h = this.host;
    return matchFile(this.sourceFile(fsPath), h.problems, h.cfg.baseUrl, h.cfg.fileNamePattern.pattern)?.problemId === problemId;
  }

  /** Existing files for a problem, in the stable path order; missing saved links reported, missing auto-matches dropped. */
  private async existingFilesFor(problemId: number): Promise<{ found: FoundFile[]; gone: vscode.Uri[] }> {
    const h = this.host;
    const found: FoundFile[] = [];
    const gone: vscode.Uri[] = [];
    // Opening a file never links it, so suggestions are fine here.
    for (const f of await this.filesForProblem(problemId, 'run', true)) {
      const at = await pathState(f.fsPath);
      if (at.kind === 'missing') {
        if (f.how === 'chosen') gone.push(vscode.Uri.file(f.fsPath));
        else await h.mapping.deleteAuto(vscode.Uri.file(f.fsPath));
        continue;
      }
      // A folder (folder mode / matched by its name) opens its submit file or main file; with no source file it has nothing to open.
      const open = at.kind === 'folder' ? await h.folder.itemFile(f.fsPath) : f.fsPath;
      if (open) found.push({ uri: vscode.Uri.file(open), t: (await fsStat(open).catch(() => null))?.mtimeMs ?? at.mtimeMs, how: f.how });
    }
    found.sort((a, b) => comparePaths(vscode.workspace.asRelativePath(a.uri), vscode.workspace.asRelativePath(b.uri)));
    return { found, gone };
  }

  /** Ask once whether to remove saved links whose files are gone. */
  private async offerRemoveStale(gone: vscode.Uri[]): Promise<void> {
    const h = this.host;
    if (!gone.length) return;
    const pick = await h.askInline(
      S.files.noLongerExists(gone.length === 1 ? vscode.workspace.asRelativePath(gone[0]) : S.files.nLinkedFiles(gone.length), gone.length > 1),
      [
        { id: 'remove', label: S.files.removeStale, primary: true },
        { id: 'keep', label: S.common.keep },
      ],
    );
    if (pick !== 'remove') return;
    for (const g of gone) await h.mapping.set(g, undefined);
    await this.refreshMappedIds();
    h.emit();
  }

  private async pickAndOpen(found: FoundFile[], name: string, problemId?: number): Promise<void> {
    const target =
      found.length === 1
        ? found[0].uri
        : (
            await vscode.window.showQuickPick(
              found.map((f) => ({ label: vscode.workspace.asRelativePath(f.uri), description: PICK_HOW[f.how], detail: S.common.edited(new Date(f.t).toLocaleString(dateLocale())), uri: f.uri })),
              { placeHolder: S.files.filesFor(name) },
            )
          )?.uri;
    if (target && problemId !== undefined) {
      // Opening never links: a name-matched / suggested file shows this problem as a temporary link.
      const how = found.find((f) => f.uri.fsPath === target.fsPath)?.how;
      this.tempLink = how && how !== 'chosen' ? { key: pathKey(target.fsPath), problemId } : null;
    }
    if (target) await vscode.commands.executeCommand('vscode.open', target);
  }

  /** Problems with a file (saved links + remembered auto-matches), for the row menus. */
  async refreshMappedIds(): Promise<void> {
    const h = this.host;
    const ids = await h.mapping.mappedProblemIds(h.cfg.baseUrl);
    const blocked = h.mapping.unlinkedPaths();
    for (const a of h.mapping.autoMatches()) if (!blocked.some((u) => isAtOrInside(a.fsPath, u))) ids.add(a.problemId);
    this.mappedIds = ids;
  }

  // ------------------------------------------------------------ linking

  async mapCurrentFile(problemId: number): Promise<void> {
    const h = this.host;
    if (!h.fileUri) {
      void vscode.window.showInformationMessage(S.files.openSourceFirst);
      return;
    }
    const p = h.problems.find((x) => x.id === problemId);
    const name = p?.name ?? '';
    if (pickScope({ folderLink: !!h.folder.link, folderMatched: h.folder.matched }) === 'folder') await h.folder.setProblem(problemId, name);
    else await h.mapping.set(h.fileUri, { problemId, name, baseUrl: h.cfg.baseUrl });
    await h.setActiveFile(h.fileUri);
  }

  /**
   * "Unlink this file": remove the link AND remember "not linked", so
   * auto-detection doesn't re-link it. Choosing a problem or Auto-detect clears it.
   * Folder mode / matched by the folder's name: the folder is unlinked instead.
   */
  async unmapCurrentFile(): Promise<void> {
    const h = this.host;
    const file = h.fileUri;
    if (!file) return;
    const scope = unlinkScope({ folderLink: !!h.folder.link, folderMatched: h.folder.matched, source: h.problem?.source ?? null });
    if (scope === 'folder-link') {
      const folder = vscode.Uri.file(h.folder.link!.fsPath);
      await h.mapping.set(folder, undefined);
      await h.mapping.setUnlinked(folder, true);
      this.tempLink = null;
    } else await this.forgetLink(file, scope);
    h.forgetProblem();
    await this.refreshMappedIds();
    await h.setActiveFile(file);
  }

  /**
   * Take back a file's link or match, or the match of its folder. Works for every
   * state: a chosen link is removed; a name match, a suggestion or a temporary
   * link just becomes "not linked" (sticky; auto-detect leaves it alone).
   */
  async forgetLink(file: vscode.Uri, scope: 'file' | 'folder-name'): Promise<void> {
    const h = this.host;
    if (scope === 'folder-name') await h.mapping.setUnlinked(vscode.Uri.joinPath(file, '..'), true);
    else {
      await h.mapping.set(file, undefined);
      await h.mapping.dropAuto(file);
      await h.mapping.setUnlinked(file, true);
    }
    this.tempLink = null;
  }

  /**
   * The user confirmed an automatic match by submitting: save it as their choice ("Chosen by
   * you"), so Submit doesn't ask again. A folder matched by its name is saved as a folder link.
   */
  async keepAutoMatch(problem: Problem): Promise<void> {
    const h = this.host;
    if (!(await h.folder.keepMatch())) {
      if (!h.fileUri) return;
      await h.mapping.set(h.fileUri, { problemId: problem.id, name: problem.name, baseUrl: h.cfg.baseUrl });
    }
    h.markChosen(problem.id);
    await this.refreshMappedIds();
    h.emit();
  }

  /**
   * Write action on a suggested match: one inline question; "yes" saves the
   * link (it's not asked again), "Choose another problem" opens the picker.
   */
  confirmSuggestedFor(file: vscode.Uri, problem: CurrentProblem, question: string, yesLabel: string, near?: 'submit'): Promise<boolean> {
    const h = this.host;
    return confirmSuggestion({
      source: problem.source,
      ask: async () => {
        const pick = await h.askInline(
          question,
          [
            { id: 'yes', label: yesLabel, primary: true },
            { id: 'choose', label: S.submit.chooseAnother },
          ],
          { near },
        );
        return pick === 'yes' ? 'yes' : pick === 'choose' ? 'choose' : undefined;
      },
      confirm: async () => {
        await h.mapping.set(file, { problemId: problem.id, name: problem.name, baseUrl: h.cfg.baseUrl });
        h.markChosen(problem.id);
        h.emit();
      },
      chooseAnother: () => h.focusProblemPicker(),
    });
  }

  /**
   * Click on a row of the problem list: open its file(s) (several → pick in
   * path order; missing → offer to remove the stale link). With no file,
   * offer choices; never link automatically.
   */
  async problemRowClick(problemId: number): Promise<void> {
    const h = this.host;
    const p = h.problemById(problemId);
    if (!p) return;
    const { found, gone } = await this.existingFilesFor(problemId);
    await this.offerRemoveStale(gone);
    if (found.length) {
      await this.pickAndOpen(found, p.name, problemId);
      return;
    }
    if (gone.length) return;
    const fileName = h.fileUri?.path.split('/').pop();
    const choices = [
      ...(h.fileUri ? [{ label: S.files.linkTo(fileName ?? ''), id: 'link' }] : []),
      { label: S.files.createNew, id: 'new' },
      { label: S.files.findByName, id: 'find' },
      { label: S.files.openStatement, id: 'statement' },
    ];
    const pick = await vscode.window.showQuickPick(choices, { placeHolder: S.files.noLinkedFile(p.name) });
    if (pick?.id === 'link') await this.mapCurrentFile(problemId);
    else if (pick?.id === 'new') await this.newFileForProblem(problemId);
    else if (pick?.id === 'find') await this.findFileByName(problemId);
    else if (pick?.id === 'statement') await h.openStatement(problemId);
  }

  /** The problem a file's name or folder matches, ignoring links. */
  nameMatch(fsPath: string): number | null {
    const h = this.host;
    const match = matchFile(this.sourceFile(fsPath), h.problems, h.cfg.baseUrl, h.cfg.fileNamePattern.pattern);
    return match && match.how !== 'suggested' ? match.problemId : null;
  }

  /** Re-run matching for the active file, ignoring the saved link; ask before replacing a manual link. */
  async autoDetect(): Promise<void> {
    const h = this.host;
    const uri = h.fileUri;
    if (!uri) return;
    const entry = await h.mapping.get(uri, h.cfg.baseUrl);
    await h.mapping.setUnlinked(uri, false); // Auto-detect clears "not linked" (also of folders above it)
    for (const u of h.mapping.unlinkedPaths()) if (isAtOrInside(uri.fsPath, u)) await h.mapping.setUnlinked(vscode.Uri.file(u), false);
    if (!h.data.problemList()) {
      await h.refreshProblems(false);
      if (!h.data.problemList()) return;
    }
    const m = resolveProblem({ savedProblemId: null, filePath: uri.fsPath, problems: h.data.problemList()!.problems, baseUrl: h.cfg.baseUrl, folders: this.sourceFile(uri.fsPath).folders, namePattern: h.cfg.fileNamePattern.pattern });
    const how = S.autoDetect.how;
    const ok = [{ id: 'ok', label: S.common.ok }];
    const o = autoDetectOutcome(entry?.problemId ?? null, m);
    if (o.kind === 'switch') {
      const pick = await h.askInline(S.autoDetect.found(o.problem.name, how[o.source] ?? how.suggested), [
        { id: 'switch', label: S.autoDetect.switch, primary: true },
        { id: 'keep', label: S.autoDetect.keepCurrent },
      ]);
      if (pick !== 'switch') return;
      await h.mapping.set(uri, undefined);
      await h.setActiveFile(uri);
      await h.folder.saveMatch(entry);
    } else if (o.kind === 'agrees') {
      void h.askInline(S.autoDetect.agrees(o.problem.name, how[o.source] ?? ''), ok);
    } else if (o.kind === 'kept') {
      void h.askInline(o.ambiguous !== null ? S.autoDetect.ambiguousKept(o.ambiguous) : S.autoDetect.noneKept, ok);
    } else {
      await h.setActiveFile(uri);
      if (o.none) void h.askInline(S.autoDetect.none, ok);
      else await h.folder.saveMatch();
    }
  }

  /** The notice's list as shown (current file first). */
  private noticeFiles(): ProblemFile[] {
    const file = this.host.fileUri;
    if (!file) return [];
    return linkedNotice(this.linkedFiles, file.fsPath, (f) => f)?.files.map(({ fsPath, how, folder }) => ({ fsPath, how, ...(folder ? { folder } : {}) })) ?? [];
  }

  /** Jump to one of the files for the current problem (index into the list the panel shows). */
  async openLinkedFile(index: number): Promise<void> {
    const f = this.noticeFiles()[index];
    if (!f) return;
    if (!(await stillThere(f.fsPath))) {
      void this.goToFile(this.host.problem?.id ?? -1); // offers removing the stale link
      return;
    }
    await this.host.folder.openItem(f.fsPath);
  }

  /**
   * Unlink one other file from the notice: a chosen link is removed; a
   * name match gets the explicit "not linked" state ("Don't match this file").
   * Either way auto-detection leaves that file alone afterwards.
   */
  async unlinkLinkedFile(index: number): Promise<void> {
    const h = this.host;
    const f = this.noticeFiles()[index];
    if (!f || pathKey(f.fsPath) === pathKey(h.fileUri?.fsPath ?? '') || (f.folder && isAtOrInside(h.fileUri?.fsPath ?? '', f.fsPath))) return;
    await this.detachFile(f);
    if (h.fileUri) await h.setActiveFile(h.fileUri);
  }

  private async detachFile(f: ProblemFile): Promise<void> {
    const h = this.host;
    const uri = vscode.Uri.file(f.fsPath);
    if (f.how === 'chosen') await h.mapping.set(uri, undefined); // a file or a folder link
    await h.mapping.dropAuto(uri);
    await h.mapping.setUnlinked(uri, true);
  }

  /**
   * Rename the active file to "<clean problem name>.<ext>" (editable first).
   * Goes through WorkspaceEdit.renameFile, so open editors, links, our rename
   * handling follow, and Undo works. Never overwrites.
   */
  async renameFileToProblem(): Promise<void> {
    const h = this.host;
    const file = h.fileUri;
    const problem = h.currentProblem();
    if (!file || !problem) return;
    const dir = vscode.Uri.joinPath(file, '..');
    const taken = async (name: string) => {
      const target = vscode.Uri.joinPath(dir, name);
      return pathKey(target.fsPath) !== pathKey(file.fsPath) && (await stillThere(target.fsPath));
    };
    const proposal = renameProposal(file.fsPath, problem.name, h.cfg.fileNamePattern.pattern, problem.id);
    const first = await freeName(proposal, taken); // never overwrite: "<name>_2.<ext>" if taken
    const stemLen = first.lastIndexOf('.') > 0 ? first.lastIndexOf('.') : first.length;
    const name = await vscode.window.showInputBox({
      title: S.rename.title,
      prompt: first === proposal ? S.rename.prompt(file.path.split('/').pop() ?? '') : S.rename.existsSuggest(proposal, first),
      value: first,
      valueSelection: [0, stemLen],
      validateInput: async (v) => {
        const bad = invalidFileName(v);
        if (bad) return S.rename.invalid[bad];
        if (await taken(v.trim())) return S.rename.existsSuggest(v.trim(), await freeName(v.trim(), taken));
        return null;
      },
    });
    if (!name) return;
    const target = vscode.Uri.joinPath(dir, name.trim().normalize('NFC'));
    if (pathKey(target.fsPath) === pathKey(file.fsPath)) return;
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(file, target, { overwrite: false });
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) void vscode.window.showWarningMessage(S.rename.failed(name.trim()));
  }

  /** Dismiss the "files for this problem" notice until its set of files changes (per workspace). */
  async dismissLinkedNotice(): Promise<void> {
    const h = this.host;
    const p = h.problem;
    if (!p || this.linkedFiles.length < 2) return;
    const all = { ...h.ctx.workspaceState.get<Record<string, string>>(KEYS.dismissedNotices, {}) };
    all[String(p.id)] = noticeSignature(this.linkedFiles);
    await h.ctx.workspaceState.update(KEYS.dismissedNotices, all);
    h.emit();
  }

  /** Keep the active file as the only one for its problem ("Unlink the other files"). */
  async keepOnlyThisFile(): Promise<void> {
    const h = this.host;
    const file = h.fileUri;
    const problem = h.problem;
    if (!file || !problem) return;
    const others = this.linkedFiles.filter((f) => pathKey(f.fsPath) !== pathKey(file.fsPath));
    if (!others.length) return;
    const pick = await h.askInline(
      S.files.unlinkOthers(others.length === 1 ? vscode.workspace.asRelativePath(others[0].fsPath) : S.files.nOtherFiles(others.length), problem.name),
      [
        { id: 'unlink', label: S.files.unlink, primary: true },
        { id: 'cancel', label: S.common.cancel },
      ],
      { detail: S.files.linksOnly },
    );
    if (pick !== 'unlink') return;
    for (const f of others) await this.detachFile(f);
    if (h.problem?.source !== 'saved') await h.mapping.set(file, { problemId: problem.id, name: problem.name, baseUrl: h.cfg.baseUrl });
    await h.setActiveFile(file);
  }

  /** Copy the clean problem name (zero-width characters removed): a file named like it is matched exactly. */
  async copyProblemName(problemId: number): Promise<void> {
    const p = this.host.problemById(problemId);
    if (!p) return;
    const name = cleanName(p.name);
    await vscode.env.clipboard.writeText(name);
    void vscode.window.setStatusBarMessage(S.files.copied(name), TIMING.statusMessageMs);
  }

  /** Create `<clean name>.<ext>` next to the active file (or in the workspace root), open it and map it. */
  async newFileForProblem(problemId: number): Promise<void> {
    const h = this.host;
    const p = h.problemById(problemId);
    if (!p) return;
    const folder = await this.targetFolder();
    if (!folder) return;
    await h.data.languages().catch(() => undefined);
    const permitted = h.allowedLanguages(p);
    if (!permitted.length) {
      void vscode.window.showInformationMessage(S.files.languagesNotLoaded);
      return;
    }
    // Active file's language → last used for new files → cedtGrader.defaultLanguage → ask. Never archive/binary automatically.
    const choice = chooseNewFileLanguage({
      permitted,
      activeFilePath: h.fileUri?.fsPath ?? null,
      lastUsedLanguageId: h.ctx.globalState.get<number>(KEYS.lastNewFileLanguage) ?? null,
      defaultLanguageName: h.cfg.defaultLanguage,
    });
    const language =
      choice.kind === 'auto'
        ? choice.language
        : (await vscode.window.showQuickPick(choice.options.map((l) => ({ label: l.name, description: l.ext ? `.${l.ext}` : undefined, l })), { placeHolder: S.files.newFileLanguage(p.name) }))?.l;
    if (!language) return;
    await h.ctx.globalState.update(KEYS.lastNewFileLanguage, language.id);
    const target = vscode.Uri.joinPath(folder, fileNameFor(p.name, language.ext && language.ext !== 'null' ? language.ext : 'txt', h.cfg.fileNamePattern.pattern, p.id));
    const created = await createFileNoOverwrite(target.fsPath, async () => {
      const open = S.files.openExisting;
      const overwrite = S.files.overwrite;
      const pick = await vscode.window.showWarningMessage(S.files.alreadyExists(vscode.workspace.asRelativePath(target)), { modal: true }, open, overwrite);
      return pick === overwrite ? 'overwrite' : pick === open ? 'open' : 'cancel';
    });
    if (created === 'cancel') return;
    await h.mapping.set(target, { problemId: p.id, name: p.name, baseUrl: h.cfg.baseUrl });
    await vscode.window.showTextDocument(target);
  }

  /** Open the file(s) for a problem (same list as the duplicate notice). */
  async goToFile(problemId: number): Promise<void> {
    const p = this.host.problemById(problemId);
    const { found, gone } = await this.existingFilesFor(problemId);
    await this.offerRemoveStale(gone);
    if (found.length) await this.pickAndOpen(found, p?.name ?? `#${problemId}`, problemId);
  }

  /**
   * "Find a matching file" (only when clicked): the one matcher's files for the
   * problem (name matches and confident suggestions), ranked: same folder as
   * the active file first, then the most recently modified.
   */
  async findFileByName(problemId: number): Promise<void> {
    const h = this.host;
    const p = h.problemById(problemId);
    if (!p) return;
    await h.data.languages().catch(() => undefined);
    const kept = ((await this.index.get()).get(problemId) ?? [])
      .map((f) => f.fsPath)
      .filter((f) => !h.mapping.unlinkedPaths().some((u) => pathKey(u) === pathKey(f)));
    if (!kept.length) {
      void vscode.window.showInformationMessage(S.files.noFileNamed(cleanName(p.name), this.sourceExtsFor(p).map((e) => `.${e}`).join(', ')));
      return;
    }
    const mtimes = new Map<string, number>();
    for (const f of kept) mtimes.set(f, (await fsStat(f).catch(() => null))?.mtimeMs ?? 0);
    const activeDir = h.fileUri ? vscode.Uri.joinPath(h.fileUri, '..').fsPath : null;
    const ranked = rankCandidates(kept, activeDir, (f) => mtimes.get(f) ?? 0);
    let target: string | undefined = ranked[0];
    if (ranked.length > 1) {
      target = (
        await vscode.window.showQuickPick(
          ranked.map((f) => ({
            label: vscode.workspace.asRelativePath(f),
            description: activeDir && vscode.Uri.joinPath(vscode.Uri.file(f), '..').fsPath === activeDir ? S.files.sameFolder : undefined,
            detail: S.common.modified(new Date(mtimes.get(f) ?? 0).toLocaleString(dateLocale())),
            f,
          })),
          { placeHolder: S.files.filesNamed(cleanName(p.name)) },
        )
      )?.f;
    }
    if (!target) return;
    const uri = vscode.Uri.file(target);
    await vscode.window.showTextDocument(uri);
    const link = S.files.link;
    const pick = await vscode.window.showInformationMessage(S.files.linkFileTo(vscode.workspace.asRelativePath(uri), p.name, p.id), link, S.common.notNow);
    if (pick === link) {
      await h.mapping.set(uri, { problemId: p.id, name: p.name, baseUrl: h.cfg.baseUrl });
      await h.setActiveFile(uri);
    }
  }

  // ------------------------------------------------------ moved files

  /**
   * A file with no mapping was opened: if saved mappings point at a missing
   * file with the same name (moved outside VS Code), ask whether to keep the link.
   * Only the saved mappings are checked; never applied silently.
   */
  private async offerReconnect(uri: vscode.Uri): Promise<void> {
    const h = this.host;
    this.reconnectAsked.add(uri.fsPath);
    const dismissed = new Set(h.ctx.workspaceState.get<string[]>(KEYS.dismissedReconnects, []));
    const candidates = await reconnectCandidates(await h.mapping.everyEntry(), uri.fsPath, stillThere, dismissed);
    if (!candidates.length) return;
    const nameOf = (c: LocatedEntry) => h.problemById(c.entry.problemId)?.name ?? c.entry.name;
    let chosen: LocatedEntry | undefined;
    if (candidates.length === 1) {
      const pick = await h.askInline(S.moved.looksLike(S.moved.entry(vscode.workspace.asRelativePath(candidates[0].fsPath), nameOf(candidates[0]) ?? `#${candidates[0].entry.problemId}`)), [
        { id: 'keep', label: S.common.keep, primary: true },
        { id: 'no', label: S.moved.notThisOne },
      ]);
      if (pick === 'keep') chosen = candidates[0];
      else if (pick === 'no') await this.dismissReconnect(candidates, uri);
    } else if (candidates.length <= 3) {
      const pick = await h.askInline(S.moved.whichLink(uri.path.split('/').pop() ?? ''), [
        ...candidates.map((c, i) => ({ id: String(i), label: `${vscode.workspace.asRelativePath(c.fsPath)} → ${nameOf(c)}` })),
        { id: 'skip', label: S.moved.noneOfThese },
      ]);
      if (pick === 'skip') await this.dismissReconnect(candidates, uri);
      else if (pick !== undefined) chosen = candidates[Number(pick)];
    } else {
      const pick = await vscode.window.showQuickPick(
        [
          ...candidates.map((c) => ({ label: vscode.workspace.asRelativePath(c.fsPath), description: nameOf(c), c })),
          { label: S.moved.skip, description: S.moved.noneOfThese.toLowerCase(), c: undefined },
        ],
        { placeHolder: S.moved.whichLink(uri.path.split('/').pop() ?? '') },
      );
      if (pick?.c) chosen = pick.c;
      else if (pick) await this.dismissReconnect(candidates, uri);
    }
    if (!chosen) return;
    await h.mapping.reconnect(chosen, uri);
    if (h.fileUri?.toString() === uri.toString()) await h.setActiveFile(uri);
  }

  private async dismissReconnect(candidates: LocatedEntry[], uri: vscode.Uri): Promise<void> {
    const ws = this.host.ctx.workspaceState;
    const list = new Set(ws.get<string[]>(KEYS.dismissedReconnects, []));
    for (const c of candidates) list.add(dismissKey(c.fsPath, uri.fsPath));
    await ws.update(KEYS.dismissedReconnects, [...list]);
  }
}

