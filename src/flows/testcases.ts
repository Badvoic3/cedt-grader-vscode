import * as vscode from 'vscode';
import { readFile as fsReadFile } from 'node:fs/promises';
import { chooseTestcaseTarget, CPH_EXTENSION_ID, CPH_RUN_COMMAND } from '../cphIntegration';
import { type Pdfjs, readSampleTables } from '../data/pdfSamples';
import type { SampleTable } from '../data/sampleTables';
import { stripGraderKey, TestcaseStore } from '../data/testcaseStore';
import { classifyConnectionError, type Problem } from '../grader';
import { readCphProblem } from '../mapping/cph';
import { cleanName, problemSubtitle } from '../mapping/match';
import { pathExists as exists } from '../mapping/newFile';
import { isAtOrInside } from '../mapping/paths';
import { sampleCasesToImport } from '../mapping/sampleImport';
import { type CaseKind, type GraderCase, testsFolderOf } from '../mapping/testCases';
import { caseCounts, type CaseWriteResult, writeCases } from '../mapping/writeCases';
import { SUBMISSION_SCHEME, WEB_PATHS } from '../shared/constants';
import { KEYS } from '../shared/stateKeys';
import { S } from '../shared/strings';
import type { Host } from './host';

/**
 * Test cases for the current problem: the grader's cases ("Load test
 * cases"), the statement's samples ("Load samples") and CPH's "Run tests".
 * Both kinds go through one path (`deliver` → writeCases.ts): CPH's `.prob`
 * when CPH is installed, else `.in` / `.out` files.
 */
export class TestCases {
  busy = false;
  samplesBusy = false;
  /** The cached statement of the current problem is not a PDF (no "Load samples" button). Unknown = false. */
  statementNoPdf = false;
  /** Tests in CPH for the run file (null: CPH not installed / no file). Read on file switch and after loading test cases. */
  runTestCount: number | null = null;

  constructor(
    private readonly host: Host,
    private readonly store: TestcaseStore,
    /** pdf.js (legacy build, dist/pdfjs) for "Load sample cases": imported on first use only. */
    private readonly pdfjs: () => Promise<Pdfjs>,
  ) {}

  /** The active file changed: what the card needs to know without a request. */
  async onActiveFile(problem: Problem | null): Promise<void> {
    const h = this.host;
    this.statementNoPdf = problem ? (await h.statementStore.cachedKind(problem.id)) === 'other' : false;
    this.runTestCount = h.cph.installed && problem ? ((await readCphProblem(h.folder.runUri()?.fsPath ?? '', h.cphSaveLocation()))?.tests.length ?? 0) : null;
  }

  async refreshRunTests(): Promise<void> {
    const h = this.host;
    const run = h.folder.runUri();
    const before = this.runTestCount;
    this.runTestCount = h.cph.installed && run ? ((await readCphProblem(run.fsPath, h.cphSaveLocation()))?.tests.length ?? 0) : null;
    if (before !== this.runTestCount) h.emit();
  }

  /** "Load samples" is hidden only when the cache says the statement is not a PDF (no request to find out). */
  async refreshStatementKind(): Promise<void> {
    const h = this.host;
    const id = h.problem?.id;
    const noPdf = id ? (await h.statementStore.cachedKind(id)) === 'other' : false;
    if (noPdf === this.statementNoPdf || id !== h.problem?.id) return;
    this.statementNoPdf = noPdf;
    h.emit();
  }

  /**
   * "Run tests" (only with CPH): save the files of the folder (or the file),
   * show the run file (CPH runs the active editor and reloads its tests only
   * when the active editor changes), then CPH's run command. Folder mode runs
   * the driver (main.cpp), which includes the submit file from the folder.
   */
  async runTests(): Promise<void> {
    const h = this.host;
    if (!h.cph.installed) return;
    const problem = h.currentProblem();
    if (h.folder.link && problem && !(await h.folder.askRole('run', problem))) return;
    const run = h.folder.runUri();
    if (!run) {
      void vscode.window.showInformationMessage(S.submit.openToSubmit);
      return;
    }
    const tests = (await readCphProblem(run.fsPath, h.cphSaveLocation()))?.tests.length ?? 0;
    if (!tests) {
      const pick = await h.askInline(S.runTests.noTests, [
        ...(problem?.hasTestcase ? [{ id: 'load', label: S.testcases.load, primary: true }] : []),
        { id: 'cancel', label: S.common.cancel },
      ]);
      if (pick === 'load') await this.loadTestcases(false);
      return;
    }
    const scope = h.folder.link?.fsPath;
    for (const d of vscode.workspace.textDocuments) {
      if (d.isDirty && !d.isUntitled && (scope ? isAtOrInside(d.uri.fsPath, scope) : d.uri.toString() === run.toString())) await d.save();
    }
    if (vscode.window.activeTextEditor?.document.uri.toString() === run.toString()) await this.reloadCph(run);
    else await vscode.window.showTextDocument(run, { preview: false });
    await vscode.commands.executeCommand(CPH_RUN_COMMAND);
  }

  /**
   * Download the grader's test cases (one at a time, cached in globalStorage)
   * and save them: into CPH's problem file when CPH is installed, otherwise as
   * `<problem>/tests/<n>.in|out` files (asked once per workspace) or not at all.
   * `asFiles` ("Save test cases as files"): always the files, CPH or not.
   */
  async loadTestcases(refresh = false, asFiles = false): Promise<void> {
    const h = this.host;
    const problem = h.currentProblem();
    if (!problem || !h.fileUri || this.busy) return;
    // Folder mode: test cases belong to the run file (the driver), whichever file of the folder is open.
    if (h.folder.link && !(await h.folder.askRole('run', problem))) return;
    const file = h.folder.runUri();
    if (!file) return;
    if (!problem.hasTestcase) {
      void vscode.window.showInformationMessage(S.testcases.none(problem.name));
      return;
    }
    // Writing test cases for a guess: ask once (yes confirms the link).
    if (!(await h.links.confirmSuggestedFor(h.fileUri, problem, S.testcases.suggestedQ(problem.name, problemSubtitle(problem.name, problem.fullName) ?? ''), S.testcases.load))) return;
    if (!(await h.ensureLoggedIn())) return;
    this.busy = true;
    h.emit();
    // The spinner is for the download only; the questions and the final notification
    // (which stays open until dismissed) come after it.
    const downloaded = () => {
      if (!this.busy) return;
      this.busy = false;
      h.emit();
    };
    try {
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: S.testcases.progressTitle(problem.name), cancellable: true },
        async (progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          let last = 0;
          return this.store.get(problem.id, {
            refresh,
            signal: abort.signal,
            onProgress: (done, total) => {
              progress.report({ message: `downloading ${done} / ${total}`, increment: total ? ((done - last) / total) * 100 : 0 });
              last = done;
            },
          });
        },
      );
      h.connectionOk();
      downloaded();
      if (res.status === 'not-available') {
        void vscode.window.showInformationMessage(S.testcases.notAllowed(problem.name));
        return;
      }
      const { set } = res;
      const total = set.cases.length + set.truncated.length;
      const tooLarge = set.truncated.length ? S.testcases.tooLarge(set.truncated.length) : '';
      const programText = await fsReadFile(file.fsPath, 'utf8').catch(() => '');
      const { cases, key } = stripGraderKey(set.cases, programText);
      const keyNote = key ? S.testcases.keyRemoved : '';
      const refetch = S.testcases.downloadAgain;
      const pick = await this.deliver({
        problem,
        file,
        cases,
        kind: 'grader',
        whereTo: S.testcases.whereTo(set.cases.length),
        asFiles,
        offerInstall: true,
        extra: res.fromCache ? [refetch] : [],
        message: (r, m) =>
          (r.target === 'files'
            ? S.testcases.savedFiles(r.written, total, m.folder, tooLarge, m.counts.join(', '))
            : S.testcases.cphDone([S.testcases.savedCph(set.cases.length, total, tooLarge), ...m.counts].join('; '), !!r.backupPath, m.reloaded)) + keyNote,
      });
      if (pick === refetch) await this.loadTestcases(true, asFiles);
    } catch (err) {
      if (classifyConnectionError(err)) h.reportError(err, () => this.loadTestcases(refresh, asFiles));
      else void vscode.window.showErrorMessage(S.testcases.failed(h.describe(err)));
    } finally {
      downloaded();
    }
  }

  /**
   * "Load sample cases": the example input/output table of the problem's
   * statement PDF, read in the host (src/data/pdfSamples.ts). The PDF comes
   * from the statement cache; when it isn't cached it is fetched once with the
   * same request as opening the statement (and cached). Same targets and rules
   * as "Load test cases" (one path: `deliver`).
   */
  async loadSampleCases(): Promise<void> {
    const h = this.host;
    const problem = h.currentProblem();
    if (!problem || !h.fileUri || this.samplesBusy) return;
    if (h.folder.link && !(await h.folder.askRole('run', problem))) return;
    const file = h.folder.runUri();
    if (!file) return;
    if (!(await h.links.confirmSuggestedFor(h.fileUri, problem, S.samples.suggestedQ(problem.name, problemSubtitle(problem.name, problem.fullName) ?? ''), S.samples.load))) return;
    this.samplesBusy = true;
    h.emit();
    let tables: SampleTable[];
    try {
      let st = await h.statementStore.cached(problem.id);
      if (!st) {
        if (!(await h.ensureLoggedIn())) return;
        st = await h.statementStore.get(problem.id);
        h.connectionOk();
      }
      if (st.kind !== 'pdf') {
        this.statementNoPdf = true; // the button goes away (and stays away for this problem while cached)
        void h.tellInline(null, S.samples.noPdf);
        return;
      }
      tables = await readSampleTables(st.bytes, await this.pdfjs());
    } catch (err) {
      if (classifyConnectionError(err)) h.reportError(err, () => this.loadSampleCases());
      else void h.tellInline(err, S.samples.failed(h.describe(err)));
      return;
    } finally {
      this.samplesBusy = false;
      h.emit();
    }
    const found = tables.flatMap((t) => t.cases);
    if (!found.length) {
      void h.tellInline(null, S.samples.none);
      return;
    }
    // A sample table with rows that couldn't be read is an incomplete read: load nothing (not into
    // CPH, not as files) rather than part of the cases. Misread text that still looks like a case
    // can't be detected; the tooltip asks to check the cases.
    const skipped = tables.reduce((n, t) => n + (t.skipped ?? 0), 0);
    if (skipped) {
      void h.tellInline(null, S.samples.incomplete(skipped));
      return;
    }
    const annotated = found.filter((c) => c.annotated).length;
    const cases = sampleCasesToImport(found);
    const loaded = S.samples.loaded(cases.length) + (annotated ? S.samples.annotated(annotated) : '');
    try {
      await this.deliver({
        problem,
        file,
        cases,
        kind: 'sample',
        whereTo: S.samples.whereTo(cases.length),
        message: (r, m) =>
          `${loaded} ${r.target === 'files' ? S.samples.savedFiles(r.written, m.folder, m.counts.join(', ')) : S.testcases.cphDone(S.samples.savedCph(m.counts.join('; ')), !!r.backupPath, m.reloaded)}`,
      });
    } catch (err) {
      void vscode.window.showErrorMessage(S.samples.failed(h.describe(err)));
    }
  }

  /**
   * The one way cases reach a target: CPH's `.prob` (installed) or `.in` /
   * `.out` files (asked once per workspace; `asFiles` = always files). The
   * tests folder is confirmed before it is created; a CPH write records its
   * backup, refreshes "Run tests" and reloads CPH when that is safe. Shows the
   * result with Show Folder / Install CPH / Reload in CPH and `extra`
   * buttons; returns the `extra` button picked.
   */
  private async deliver(o: {
    problem: Problem;
    file: vscode.Uri;
    cases: GraderCase[];
    kind: CaseKind;
    whereTo: string;
    asFiles?: boolean;
    /** Offer "Install CPH" after saving files (grader cases). */
    offerInstall?: boolean;
    extra?: string[];
    message: (r: CaseWriteResult, m: { folder: string; counts: string[]; reloaded: boolean }) => string;
  }): Promise<string | undefined> {
    const h = this.host;
    const where = o.asFiles ? 'files' : await this.target(o.whereTo);
    if (!where) return undefined;
    const extra = o.extra ?? [];
    if (where === 'files') {
      const folder = testsFolderOf(o.file.fsPath, h.folder.link?.fsPath ?? null, o.problem.name);
      if (!(await this.confirmTestsFolder(folder, o.cases.length))) return undefined;
      const r = await writeCases({ kind: 'files', folder }, o.cases, o.kind);
      const open = S.testcases.showFolder;
      const install = S.common.installCph;
      const pick = await vscode.window.showInformationMessage(
        o.message(r, { folder: vscode.workspace.asRelativePath(folder), counts: caseCounts(r), reloaded: false }),
        open,
        ...(o.offerInstall && !h.cph.installed ? [install] : []),
        ...extra,
      );
      if (pick === open) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(folder));
      if (pick === install) await vscode.commands.executeCommand('extension.open', CPH_EXTENSION_ID);
      return pick;
    }
    const r = await writeCases(
      { kind: 'cph', srcPath: o.file.fsPath, saveLocation: h.cphSaveLocation(), problemName: cleanName(o.problem.name), problemUrl: h.url(WEB_PATHS.problem(o.problem.id)) },
      o.cases,
      o.kind,
    );
    if (r.target === 'cph') await h.recordBackup(r.backupPath);
    await this.refreshRunTests(); // "Run tests" becomes available
    const reloaded = await this.reloadCphIfActive(o.file);
    const reload = S.testcases.reloadCph;
    const pick = await vscode.window.showInformationMessage(o.message(r, { folder: '', counts: caseCounts(r), reloaded }), ...(reloaded ? [] : [reload]), ...extra);
    if (pick === reload) await this.reloadCph(o.file);
    return pick;
  }

  /** Where test cases go: CPH's .prob when installed, else files (asked once per workspace, remembered); null = cancelled. */
  private async target(question: string): Promise<'cph' | 'files' | null> {
    const h = this.host;
    const target = chooseTestcaseTarget(h.cph.installed, h.ctx.workspaceState.get<'files'>(KEYS.testcaseTarget));
    if (target !== 'ask') return target;
    const files = S.testcases.saveAsFiles;
    const install = S.common.installCph;
    const pick = await vscode.window.showInformationMessage(question, { detail: S.testcases.whereToDetail }, files, install);
    if (pick === install) await vscode.commands.executeCommand('extension.open', CPH_EXTENSION_ID);
    if (pick !== files) return null;
    await h.ctx.workspaceState.update(KEYS.testcaseTarget, 'files'); // remembered per workspace
    return 'files';
  }

  /** Creating the tests folder is confirmed first. */
  private async confirmTestsFolder(folder: string, n: number): Promise<boolean> {
    if (await exists(folder)) return true;
    const create = S.testcases.createFolder;
    return (await vscode.window.showInformationMessage(S.testcases.createFolderQ(vscode.workspace.asRelativePath(folder), n), create)) === create;
  }

  /**
   * CPH only re-reads a .prob when the active editor changes (no reload
   * command exists). Briefly show a read-only placeholder and come back. Only
   * the placeholder is ever closed (if it didn't become the active editor,
   * nothing is closed).
   */
  async reloadCph(file: vscode.Uri): Promise<void> {
    const placeholder = vscode.Uri.from({ scheme: SUBMISSION_SCHEME, path: '/0/reloading-cph' });
    const doc = await vscode.workspace.openTextDocument(placeholder);
    const shown = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    if (vscode.window.activeTextEditor?.document.uri.toString() === placeholder.toString()) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.window.showTextDocument(file, { preview: false, viewColumn: shown.viewColumn });
  }

  /**
   * After writing a .prob: reload CPH right away when that is safe, i.e. the
   * file is the active editor (the user stays where they are; only a flicker).
   * Otherwise nothing moves: CPH reads the file when the user opens it, and the
   * message offers "Reload in CPH". Returns whether it reloaded.
   */
  private async reloadCphIfActive(file: vscode.Uri): Promise<boolean> {
    if (vscode.window.activeTextEditor?.document.uri.toString() !== file.toString()) return false;
    try {
      await this.reloadCph(file);
      return true;
    } catch (err) {
      this.host.log(`CPH reload failed: ${this.host.describe(err)}`);
      return false;
    }
  }
}
