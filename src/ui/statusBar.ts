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
      this.item.tooltip = 'CEDT Grader: waiting for the verdict. Click to open the panel.';
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }
    if (!s.file?.supported) {
      this.item.hide();
      return;
    }
    if (!s.problem) {
      this.item.text = '$(cloud-upload) Grader: choose problem';
      this.item.tooltip = 'Map this file to a CEDT Grader problem';
    } else if (forThisProblem && r!.phase === 'done' && (r!.score !== null || r!.compileError)) {
      const score = r!.compileError ? 'CE' : `${r!.score}/100`;
      this.item.text = `$(cloud-upload) ${score}  Submit to Grader`;
      this.item.tooltip = `${s.problem.name}: last result ${score}. Click to open the panel.`;
    } else {
      this.item.text = '$(cloud-upload) Submit to Grader';
      this.item.tooltip = `${s.problem.name}: open the CEDT Grader panel`;
    }
    this.item.backgroundColor = s.contest?.blocked ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    if (s.contest?.blocked) this.item.tooltip += ' (contest mode: submit through the website)';
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
