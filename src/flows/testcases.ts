import * as vscode from 'vscode';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Pdfjs, readSampleTables, SampleReadLimitError } from '../data/pdfSamples';
import type { SampleTable } from '../data/sampleTables';
import { stripGraderKey, TestcaseStore } from '../data/testcaseStore';
import { classifyConnectionError, type Problem } from '../grader';
import { problemSubtitle } from '../mapping/match';
import { pathExists as exists } from '../mapping/newFile';
import { sampleCasesToImport } from '../mapping/sampleImport';
import { type GraderCase, testsFolderOf } from '../mapping/testCases';
import { caseCounts, writeCases } from '../mapping/writeCases';
import { S } from '../shared/strings';
import type { Host } from './host';

/**
 * Loading test cases for the current problem: the grader's ("Load test cases")
 * and the statement's samples ("Load samples"), both into the runner's list.
 * "Save test cases as files" writes the grader's as `.in` / `.out` files.
 */
export class TestCases {
  busy = false;
  samplesBusy = false;
  /** The cached statement of the current problem is not a PDF (no "Load samples" button). Unknown = false. */
  statementNoPdf = false;

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
   * Download the grader's test cases (one at a time, cached in globalStorage)
   * into the runner's list, which they merge with. `asFiles` ("Save test cases
   * as files"): `<problem>/tests/<n>.in|out` files instead.
   */
  async loadTestcases(refresh = false, asFiles = false): Promise<void> {
    const h = this.host;
    const problem = h.currentProblem();
    if (!problem || !h.fileUri || this.busy) return;
    // The files go next to the program, so folder mode needs its Runs file. The list belongs to the problem.
    if (asFiles && h.folder.link && !(await h.folder.askRole('run', problem))) return;
    const file = h.folder.runUri() ?? h.fileUri;
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
              progress.report({ message: S.testcases.downloadProgress(done, total), increment: total ? ((done - last) / total) * 100 : 0 });
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
      const programText = await this.programText(file);
      const { cases, key } = stripGraderKey(set.cases, programText);
      const keyNote = key ? S.testcases.keyRemoved : '';
      const refetch = S.testcases.downloadAgain;
      const extra = res.fromCache ? [refetch] : [];
      const pick = asFiles
        ? await this.saveAsFiles(problem, file, cases, total, tooLarge + keyNote, extra)
        : await this.intoList(problem, cases, 'grader', (added, kept) => S.testcases.loaded(added, kept, total - set.cases.length) + keyNote, extra);
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
   * same request as opening the statement (and cached).
   */
  async loadSampleCases(): Promise<void> {
    const h = this.host;
    const problem = h.currentProblem();
    if (!problem || !h.fileUri || this.samplesBusy) return;
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
      else if (err instanceof SampleReadLimitError) void h.tellInline(null, S.samples.tooLong); // nothing written
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
    // A sample table with rows that couldn't be read is an incomplete read: load nothing rather than
    // part of the cases. Misread text that still looks like a case
    // can't be detected; the tooltip asks to check the cases.
    const skipped = tables.reduce((n, t) => n + (t.skipped ?? 0), 0);
    if (skipped) {
      void h.tellInline(null, S.samples.incomplete(skipped));
      return;
    }
    const annotated = found.filter((c) => c.annotated).length;
    const cases = sampleCasesToImport(found);
    const note = annotated ? S.samples.annotated(annotated) : '';
    try {
      await this.intoList(problem, cases, 'sample', (added, kept) => S.samples.loaded(added, kept) + note, []);
    } catch (err) {
      void vscode.window.showErrorMessage(S.samples.failed(h.describe(err)));
    }
  }

  /** What the key line is checked against: the program, or with no Runs file yet, every file of the folder. */
  private async programText(file: vscode.Uri): Promise<string> {
    const h = this.host;
    const link = h.folder.link;
    const paths = link && !h.folder.runUri() ? (await h.folder.sources(link.fsPath)).map((f) => join(link.fsPath, ...f.split('/'))) : [file.fsPath];
    return (await Promise.all(paths.map((p) => fsReadFile(p, 'utf8').catch(() => '')))).join('\n');
  }

  /** Merge into the problem's list, carrying over cases written before the file was linked. */
  private async intoList(problem: Problem, cases: GraderCase[], source: 'grader' | 'sample', message: (added: number, kept: number) => string, extra: string[]): Promise<string | undefined> {
    const h = this.host;
    const { added, kept } = await h.cases.merge(
      problem.id,
      cases.map((c) => ({ input: c.input, expected: c.output, ...(source === 'grader' ? { testcaseId: c.testcaseId } : {}) })),
      source,
    );
    await h.runner.onActiveFile();
    return vscode.window.showInformationMessage(message(added, kept), ...extra);
  }

  /** "Save test cases as files": the tests folder is confirmed before it is created. */
  private async saveAsFiles(problem: Problem, file: vscode.Uri, cases: GraderCase[], total: number, note: string, extra: string[]): Promise<string | undefined> {
    const h = this.host;
    const folder = testsFolderOf(file.fsPath, h.folder.link?.fsPath ?? null, problem.name, problem.id);
    if (!(await this.confirmTestsFolder(folder, cases.length))) return undefined;
    const r = await writeCases({ kind: 'files', folder }, cases, 'grader');
    const open = S.testcases.showFolder;
    const written = r.target === 'files' ? r.written : 0;
    const pick = await vscode.window.showInformationMessage(S.testcases.savedFiles(written, total, vscode.workspace.asRelativePath(folder), note, caseCounts(r).join(', ')), open, ...extra);
    if (pick === open) await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(folder));
    return pick;
  }

  /** Creating the tests folder is confirmed first. */
  private async confirmTestsFolder(folder: string, n: number): Promise<boolean> {
    if (await exists(folder)) return true;
    const create = S.testcases.createFolder;
    return (await vscode.window.showInformationMessage(S.testcases.createFolderQ(vscode.workspace.asRelativePath(folder), n), create)) === create;
  }
}
