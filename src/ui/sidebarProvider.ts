import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { GraderController } from '../controller';
import { type FromWebview, isFromWebview, type ToWebview } from '../shared/messages';

/**
 * The "CEDT Grader" sidebar. Renders `ViewState` snapshots from the
 * controller; every action is a typed message handled here in the extension
 * host (the webview never talks to the network).
 */
export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'cedtGrader.panel';
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: GraderController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);

    const subs: vscode.Disposable[] = [
      view.webview.onDidReceiveMessage((m: unknown) => {
        if (isFromWebview(m)) void this.handle(m);
      }),
      this.controller.onState((state) => this.post({ type: 'state', state })),
    ];
    this.controller.focusTarget = (t) => setTimeout(() => this.focus(t), 150);
    // Nothing is fetched while the panel is hidden; pending loads run when it is shown.
    this.controller.setPanelVisible(view.visible);
    subs.push(view.onDidChangeVisibility(() => this.controller.setPanelVisible(view.visible)));
    view.onDidDispose(() => {
      subs.forEach((d) => d.dispose());
      this.view = undefined;
      this.controller.setPanelVisible(false);
    });
  }

  focus(target: 'login' | 'problem-search' | 'submit'): void {
    this.post({ type: 'focus', target });
  }

  private post(m: ToWebview): void {
    void this.view?.webview.postMessage(m);
  }

  private async handle(m: FromWebview): Promise<void> {
    const c = this.controller;
    switch (m.type) {
      case 'ready':
        this.post({ type: 'state', state: c.state() });
        return;
      case 'login':
        // The password is passed straight to SecretStorage and not kept anywhere else.
        await c.loginWith(String(m.username ?? ''), String(m.password ?? ''), m.remember !== false);
        return;
      case 'loginSaved':
        await c.login();
        return;
      case 'logout':
        await c.logout();
        return;
      case 'submit':
      case 'resubmit':
        await c.submit();
        return;
      case 'selectLanguage':
        if (Number.isInteger(m.languageId)) await c.selectLanguage(m.languageId);
        return;
      case 'mapProblem':
        if (Number.isInteger(m.problemId)) await c.mapCurrentFile(m.problemId);
        return;
      case 'unmapProblem':
        await c.unmapCurrentFile();
        return;
      case 'refreshProblems':
        await c.refreshProblems(true);
        return;
      case 'openStatement':
        if (Number.isInteger(m.problemId)) await c.openStatement(m.problemId);
        return;
      case 'openProblemInBrowser':
        if (Number.isInteger(m.problemId)) await c.openProblemInBrowser(m.problemId);
        return;
      case 'toggleSubmission':
        if (Number.isInteger(m.submissionId)) await c.toggleSubmission(m.submissionId);
        return;
      case 'openSubmissionSource':
        if (Number.isInteger(m.submissionId)) await c.openSubmissionSource(m.submissionId);
        return;
      case 'compareSubmission':
        if (Number.isInteger(m.submissionId)) await c.compareSubmission(m.submissionId);
        return;
      case 'copyName':
        if (Number.isInteger(m.problemId)) await c.copyProblemName(m.problemId);
        return;
      case 'newFile':
        if (Number.isInteger(m.problemId)) await c.newFileForProblem(m.problemId);
        return;
      case 'goToFile':
        if (Number.isInteger(m.problemId)) await c.goToFile(m.problemId);
        return;
      case 'findFile':
        if (Number.isInteger(m.problemId)) await c.findFileByName(m.problemId);
        return;
      case 'loadTestcases':
        await c.loadTestcases(false);
        return;
      case 'setFilter':
        if (m.filter && typeof m.filter === 'object') await c.setProblemFilter(m.filter);
        return;
      case 'promptAnswer':
        if (Number.isInteger(m.id)) c.answerPrompt(m.id, typeof m.button === 'string' ? m.button : null);
        return;
      case 'problemRowClick':
        if (Number.isInteger(m.problemId)) await c.problemRowClick(m.problemId);
        return;
      case 'autoDetect':
        await c.autoDetect();
        return;
      case 'openLinkedFile':
        if (Number.isInteger(m.index)) await c.openLinkedFile(m.index);
        return;
      case 'keepOnlyThisFile':
        await c.keepOnlyThisFile();
        return;
      case 'cphTip':
        if (m.action === 'install' || m.action === 'later' || m.action === 'never') await c.cphTip(m.action);
        return;
      case 'confirmProblem':
        if (Number.isInteger(m.problemId)) await c.mapCurrentFile(m.problemId);
        return;
      case 'retry':
        await c.retry();
        return;
      case 'refreshHistory':
        await c.refreshHistory();
        return;
      case 'openSubmission':
        if (Number.isInteger(m.submissionId)) await c.openSubmission(m.submissionId);
        return;
      case 'showCompilerMessage':
        await c.showCompilerMessage();
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'cedtGrader');
        return;
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p)).toString();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('dist', 'codicon.css')}">
<link rel="stylesheet" href="${uri('dist', 'webview.css')}">
<title>CEDT Grader</title>
</head>
<body>
<div id="app" aria-live="polite"></div>
<script nonce="${nonce}" src="${uri('dist', 'webview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
