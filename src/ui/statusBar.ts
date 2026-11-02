import { G } from '../shared/strings';
import * as vscode from 'vscode';
import type { ViewState } from '../shared/messages';

/** Status bar shortcut: reveals the sidebar; shows grading progress and the last score. */
export class GraderStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('cedtGrader.status', vscode.StatusBarAlignment.Left, 50);

  constructor() {
    this.item.name = 'CEDT Grader';
    this.item.command = 'cedtGrader.focus';
  }

  update(s: ViewState): void {
    const r = s.result;
    const forThisProblem = r && s.problem && r.problemId === s.problem.id;
    if (r && (r.phase === 'submitting' || r.phase === 'grading')) {
      this.item.text = `$(sync~spin) ${G.statusBar.grading(r.problemName)}`;
      this.item.tooltip = G.statusGradingTip;
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    if (s.connection) {
      this.item.text = `$(warning) ${G.statusBar.connection(s.connection.title)}`;
      this.item.tooltip = G.statusConnectionTip(s.connection.message);
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.show();
      return;
    }
    if (!s.file?.supported) {
      this.item.hide();
      return;
    }
    if (!s.problem) {
      this.item.text = `$(cloud-upload) ${G.statusBar.chooseProblem}`;
      this.item.tooltip = G.statusChooseTip;
    } else if (forThisProblem && r!.phase === 'done' && (r!.points !== null || r!.compileError)) {
      const score = r!.compileError ? 'CE' : `${r!.points}`;
      const counted = s.problem.score.counted;
      this.item.text = `$(cloud-upload) ${G.statusBar.submitWithScore(score)}`;
      this.item.tooltip = G.statusLastTip(s.problem.name, s.problem.id, score, counted !== null ? G.statusBar.counted(String(counted)) : '');
    } else {
      this.item.text = `$(cloud-upload) ${G.statusBar.submit}`;
      this.item.tooltip = G.statusOpenTip(s.problem.name, s.problem.id);
    }
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
