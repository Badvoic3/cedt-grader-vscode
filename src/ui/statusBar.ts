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
      this.item.text = `$(sync~spin) Grading ${r.problemName}…`;
      this.item.tooltip = G.cedtGraderWaitingForThe;
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    if (s.connection) {
      this.item.text = `$(warning) Grader: ${s.connection.title}`;
      this.item.tooltip = G.clickToOpenThePanel(s.connection.message);
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.show();
      return;
    }
    if (!s.file?.supported) {
      this.item.hide();
      return;
    }
    if (!s.problem) {
      this.item.text = '$(cloud-upload) Grader: choose problem';
      this.item.tooltip = G.mapThisFileToA;
    } else if (forThisProblem && r!.phase === 'done' && (r!.points !== null || r!.compileError)) {
      const score = r!.compileError ? 'CE' : `${r!.points}`;
      const counted = s.problem.score.counted;
      this.item.text = `$(cloud-upload) ${score}  Submit to Grader`;
      this.item.tooltip = G.lastClickToOpenThe(s.problem.name, s.problem.id, score, counted !== null ? `, counted ${counted}` : '');
    } else {
      this.item.text = '$(cloud-upload) Submit to Grader';
      this.item.tooltip = G.openTheCedtGraderPanel(s.problem.name, s.problem.id);
    }
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
