import * as vscode from 'vscode';
import { stat as fsStat } from 'node:fs/promises';
import {
  chooseLanguage,
  classifyConnectionError,
  countedScore,
  describeImprovement,
  describeSubmitFailure,
  LanguageNotAllowedError,
  PollTimeoutError,
  type Problem,
  ProblemUnavailableError,
  type SubmissionDetail,
} from '../grader';
import { problemSubtitle } from '../mapping/match';
import { isAtOrInside, pathKey } from '../mapping/paths';
import { submitQuestion } from '../mapping/suggestionGate';
import { SERVER_SCORE_CAP, WEB_PATHS } from '../shared/constants';
import type { ResultView } from '../shared/messages';
import { HOW_LINKED, S } from '../shared/strings';
import { needsSave, shouldRevealResult } from '../shared/submitOptions';
import type { Host } from './host';
import { newestAfter, newResult, ResultStore, submissionPatch } from './results';

/**
 * Submit + poll: one submission at a time, then only that submission is
 * polled until final (`max(3 s, pollIntervalSeconds)`, 3 min cap). Results
 * are kept per submitted file; a submission whose result could not be
 * fetched (connection lost) is resumed by Retry or the next good request.
 */
export class SubmitFlow {
  readonly results = new ResultStore();
  busy = false;
  /** The file being graded (the panel says "grading another file" elsewhere). */
  gradingFile: string | null = null;
  private pollAbort: AbortController | null = null;
  /** A submission that was sent but whose result could not be fetched (connection lost). */
  pendingPoll: { key: string; problem: Problem; submissionId: number; countedBefore: number | null } | null = null;

  constructor(private readonly host: Host) {}

  /** Stop polling (log out, dispose). */
  stop(): void {
    this.pollAbort?.abort();
  }

  async submit(): Promise<void> {
    const h = this.host;
    if (this.busy) {
      void vscode.window.showInformationMessage(S.submit.alreadyGrading);
      return;
    }
    if (!h.fileUri) {
      void vscode.window.showInformationMessage(S.submit.openToSubmit);
      return;
    }
    if (!(await h.ensureLoggedIn())) return;
    if (!h.problem) {
      await h.chooseProblemQuickPick();
      if (!h.problem) return;
    }
    const problem = h.currentProblem()!;
    // Folder mode: the folder's submit file (asked once), whichever file of the folder is open.
    if (h.folder.link && !(await h.folder.askRole('submit', problem, 'submit'))) return;
    // Folder mode with another file of the folder open: submit file or the open file? Asked until
    // the folder has a chosen submit file (the answer is saved, and saving links the folder).
    const confirmed = await h.folder.askSubmitOrOpen(problem);
    if (confirmed === null) return;
    const fileUri = h.folder.targetUri();
    const doc = fileUri
      ? (vscode.workspace.textDocuments.find((d) => d.uri.toString() === fileUri.toString()) ?? (await vscode.workspace.openTextDocument(fileUri).then((d) => d, () => undefined)))
      : undefined;
    if (!doc || !fileUri) {
      void vscode.window.showInformationMessage(S.submit.openToSubmit);
      return;
    }
    const key = fileUri.fsPath;
    const fileName = fileUri.path.split('/').pop() ?? '';

    let sentId: number | null = null;
    let countedBefore: number | null = null;
    try {
      // Everything needed comes from the cache: no extra request before submitting.
      countedBefore = countedScore(problem.bestScore, problem.list?.cost ?? 0, problem.list?.rawSum ?? false);
      await h.data.languages();
      const allowed = h.allowedLanguages(problem);

      // Exam hint (section 2b), from the problem list page we already fetched. Never remembered.
      let warned = false;
      if (h.client.contestPage) {
        const open = S.exam.openInBrowser;
        const anyway = S.exam.submitAnyway;
        const pick = await vscode.window.showWarningMessage(S.exam.warning, { modal: true }, open, anyway);
        if (pick === open) await h.openProblemInBrowser(problem.id);
        if (pick !== anyway) return;
        warned = true;
      }

      let languageId = h.selectedLanguageId;
      if (languageId === null || !allowed.some((l) => l.id === languageId)) {
        const c = chooseLanguage(fileUri.fsPath, allowed, h.languages);
        if (c.kind === 'match') languageId = c.language.id;
        else if (c.kind === 'not-allowed') throw new LanguageNotAllowedError(S.submit.notAllowed(c.wanted));
        else {
          const options = c.kind === 'ambiguous' ? c.candidates : c.allowed;
          const pick = await vscode.window.showQuickPick(options.map((l) => ({ label: l.name, id: l.id })), {
            placeHolder: S.submit.languageFor,
          });
          if (!pick) return;
          languageId = pick.id;
        }
        await h.selectLanguage(languageId);
      }
      const language = allowed.find((l) => l.id === languageId);

      if (h.isUnavailable(problem.id)) {
        throw new ProblemUnavailableError(S.submit.unavailable, 404);
      }

      // Another file linked to the same problem changed more recently? Ask (drafts are normal).
      // Folder mode: the linked folder (or the folder of the matched files) is "this one".
      const others = (await h.links.filesForProblem(problem.id, 'run'))
        .filter((f) => (f.folder ? !isAtOrInside(fileUri.fsPath, f.fsPath) : pathKey(f.fsPath) !== pathKey(fileUri.fsPath)))
        .map((f) => f.fsPath);
      const otherFiles = await Promise.all(others.map(async (f) => vscode.Uri.file((await h.folder.itemFile(f)) ?? f)));
      if (otherFiles.length) {
        const mine = doc.isDirty ? Date.now() : ((await fsStat(fileUri.fsPath).catch(() => null))?.mtimeMs ?? 0);
        const times = await Promise.all(otherFiles.map(async (uri) => ({ uri, t: (await fsStat(uri.fsPath).catch(() => null))?.mtimeMs ?? 0 })));
        const newest = newestAfter(mine, times);
        if (newest) {
          const pick = await h.askInline(
            S.submit.newerOther(vscode.workspace.asRelativePath(newest.uri)),
            [
              { id: 'go', label: S.submit.submitThis, primary: true },
              { id: 'open', label: S.submit.openOther },
            ],
            { tone: 'warn', detail: S.submit.bothLinked(problem.name, problem.id), near: 'submit' },
          );
          if (pick === 'open') await vscode.window.showTextDocument(newest.uri);
          if (pick !== 'go') return;
        }
      }

      // Suggestions always ask; automatic matches ask once (Submit saves the link as "Chosen by
      // you"); links the user chose never ask (submitQuestion).
      const question = submitQuestion({ source: problem.source, confirmBeforeSubmit: h.cfg.confirmBeforeSubmit, answered: warned || !!confirmed });
      if (question === 'suggested') {
        const sub = problemSubtitle(problem.name, problem.fullName) ?? '';
        if (!(await h.links.confirmSuggestedFor(h.fileUri ?? fileUri, problem, S.submit.suggestedQ(problem.name, sub), S.submit.submit, 'submit'))) return;
      } else if (question === 'confirmOnce') {
        const how = HOW_LINKED[problem.source as keyof typeof HOW_LINKED] ?? HOW_LINKED.filename;
        const pick = await h.askInline(
          S.submit.confirmQ(fileName, problem.name, problem.id, language?.name ?? null),
          [
            { id: 'submit', label: S.submit.submit, primary: true },
            { id: 'cancel', label: S.common.cancel },
          ],
          { detail: h.folder.link ? `${S.folder.onlyThisSent(fileName)} ${S.submit.confirmOnce(how)}` : S.submit.confirmOnce(how), near: 'submit' },
        );
        if (pick !== 'submit') return;
        await h.links.keepAutoMatch(problem);
      }

      // Save first (after the questions, so Cancel never saves): the grader gets what is on disk.
      if (needsSave({ saveBeforeSubmit: h.cfg.saveBeforeSubmit, isDirty: doc.isDirty, isUntitled: doc.isUntitled }) && !(await doc.save())) {
        this.setResult(key, newResult(problem, 'error', S.submit.saveFailed(fileName)));
        return;
      }

      // Busy from here on (questions above don't lock the panel).
      this.busy = true;
      this.gradingFile = key;
      h.fun.activity();
      this.setResult(key, newResult(problem, 'submitting', S.submit.submitting));
      const sub = await h.client.submit(problem.id, languageId!, doc.getText(), fileName);
      sentId = sub.id;
      h.connectionOk();
      this.updateResult(key, {
        phase: 'grading',
        submissionId: sub.id,
        number: sub.number,
        submissionUrl: h.url(WEB_PATHS.submission(sub.id)),
        message: S.submit.waiting,
      });
      // Poll only this submission until final.
      await this.pollAndFinish(key, problem, sub.id, countedBefore);
    } catch (err) {
      // Connection problems: say whether anything was submitted; the banner shows the cause.
      const connectionMsg = describeSubmitFailure(err, sentId);
      const msg = connectionMsg ?? h.describe(err);
      if (connectionMsg) {
        if (sentId !== null) this.pendingPoll = { key, problem, submissionId: sentId, countedBefore };
        h.reportError(err, null);
      }
      const r = this.results.get(key);
      if (r && r.problemId === problem.id && (r.phase === 'submitting' || r.phase === 'grading')) {
        this.updateResult(key, { phase: sentId !== null && connectionMsg ? 'timeout' : 'error', message: msg });
      } else {
        this.setResult(key, newResult(problem, 'error', msg));
      }
      if (err instanceof ProblemUnavailableError) h.markUnavailable(problem.id);
      if (!connectionMsg) void h.showError(err, msg);
    } finally {
      if (this.gradingFile === key) {
        this.busy = false;
        this.gradingFile = null;
        this.pollAbort = null;
      }
      h.emit();
    }
  }

  /** Poll one submission, then refresh history + list once and report the counted-score change. */
  private async pollAndFinish(key: string, problem: Problem, submissionId: number, countedBefore: number | null): Promise<void> {
    const h = this.host;
    const final = await this.poll(key, problem, submissionId);
    if (!final) return;
    this.pendingPoll = null;
    h.connectionOk();
    h.data.recordDetail(final);
    await h.data.afterSubmit(problem.id);
    // The submitted problem's own score: the active file may be on another problem by now.
    const updated = h.problemById(problem.id);
    const after = updated ? countedScore(updated.bestScore, updated.list?.cost ?? 0, updated.list?.rawSum ?? false) : null;
    this.updateResult(key, { improvement: describeImprovement(countedBefore, after, final.points) });
    try {
      h.fun.finished(problem, final, after);
    } catch (err) {
      h.log(`Trophies: ${err instanceof Error ? err.message : String(err)}`); // the verdict itself is fine
    }
    // A task boundary for the break reminder: progress, never a failure.
    if ((final.points ?? 0) >= SERVER_SCORE_CAP || (after !== null && (countedBefore === null || after > countedBefore))) h.fun.boundary('verdict-pass');
    if (shouldRevealResult({ revealResultAfterSubmit: h.cfg.revealResultAfterSubmit, gradedFile: key, activeFile: h.folder.targetUri()?.fsPath ?? null })) {
      h.focus('result');
    }
  }

  /** Continue a submission whose result could not be fetched (Retry, or connection back). */
  async resumePoll(): Promise<void> {
    const h = this.host;
    const p = this.pendingPoll;
    if (!p || this.busy) return;
    this.pendingPoll = null;
    this.busy = true;
    this.gradingFile = p.key;
    this.updateResult(p.key, { phase: 'grading', message: S.submit.connectionBack });
    try {
      await this.pollAndFinish(p.key, p.problem, p.submissionId, p.countedBefore);
    } catch (err) {
      if (classifyConnectionError(err)) {
        this.pendingPoll = p;
        h.reportError(err, null);
        this.updateResult(p.key, { phase: 'timeout', message: describeSubmitFailure(err, p.submissionId) });
      } else {
        this.updateResult(p.key, { phase: 'error', message: h.describe(err) });
      }
    } finally {
      this.busy = false;
      this.gradingFile = null;
      h.emit();
    }
  }

  private setResult(key: string, r: ResultView): void {
    this.results.set(key, r);
    this.host.emit();
  }

  private updateResult(key: string, patch: Partial<ResultView>): void {
    if (this.results.update(key, patch)) this.host.emit();
  }

  /** Poll the API until graded. Returns null when stopped or timed out (result updated accordingly). */
  private async poll(key: string, problem: Problem, submissionId: number): Promise<SubmissionDetail | null> {
    const h = this.host;
    const abort = new AbortController();
    this.pollAbort = abort;
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: S.submit.gradingTitle(problem.name, submissionId), cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => abort.abort());
        try {
          return await h.client.pollSubmission(submissionId, {
            intervalMs: h.cfg.pollIntervalSeconds * 1000,
            signal: abort.signal,
            onUpdate: (s) => {
              progress.report({ message: s.state !== 'graded' ? S.submit.waitingStatus(s.status.replace(/_/g, ' ')) : s.compileError ? S.submit.compilationError : S.submit.graded });
              this.updateResult(key, submissionPatch(s, h.url(WEB_PATHS.submission(s.id))));
            },
          });
        } catch (err) {
          if (abort.signal.aborted) {
            this.updateResult(key, { phase: 'timeout', message: S.submit.stoppedWaiting });
            return null;
          }
          if (err instanceof PollTimeoutError) {
            this.updateResult(key, { phase: 'timeout', message: err.message });
            return null;
          }
          throw err;
        }
      },
    );
  }

  /** Latest submission of the current file's problem, from history (refreshes history if stale). */
  async showLastResult(): Promise<void> {
    const h = this.host;
    await vscode.commands.executeCommand('cedtGrader.panel.focus');
    const problem = h.currentProblem();
    const key = h.folder.targetUri()?.fsPath;
    if (!problem || !key || this.busy) return;
    if (!(await h.ensureLoggedIn())) return;
    const items = (await h.data.loadHistory(problem.id)) ?? [];
    if (!items.length) {
      this.setResult(key, newResult(problem, 'done', S.submit.noSubmissionsYet));
      return;
    }
    const d = await h.data.loadDetail(items[0].id);
    if (!d) return;
    this.results.set(key, newResult(problem, 'grading', null));
    this.updateResult(key, submissionPatch(d, h.url(WEB_PATHS.submission(d.id))));
    if (d.state !== 'graded') this.updateResult(key, { phase: 'timeout', message: S.submit.stillGrading });
  }

  async showCompilerMessage(): Promise<void> {
    const r = this.results.get(this.host.folder.targetUri()?.fsPath);
    if (!r?.compileError) return;
    const doc = await vscode.workspace.openTextDocument({ content: r.compilerMessage ?? '', language: 'log' });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  }
}
