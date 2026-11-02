import * as vscode from 'vscode';
import { GraderController, SUBMISSION_SCHEME } from './controller';
import { SidebarProvider } from './ui/sidebarProvider';
import { GraderStatusBar } from './ui/statusBar';

/**
 * Entry point. The sidebar (SidebarProvider) is the primary UI; the commands
 * below drive the same controller so keyboard shortcuts keep working.
 *
 * Nothing logs in on activation: login only happens on an explicit user
 * action (see the device-lock note in CLAUDE.md).
 */
export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const controller = new GraderController(ctx);
  const sidebar = new SidebarProvider(ctx.extensionUri, controller);
  const statusBar = new GraderStatusBar();

  const reveal = async (target?: 'login' | 'problem-search' | 'submit') => {
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
    if (target) setTimeout(() => sidebar.focus(target), 150);
  };

  ctx.subscriptions.push(
    controller,
    sidebar,
    statusBar,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar),
    controller.onState((s) => statusBar.update(s)),

    vscode.commands.registerCommand('cedtGrader.focus', () => reveal()),
    vscode.commands.registerCommand('cedtGrader.login', async () => {
      const s = controller.state();
      if (s.account.username && s.account.hasSavedPassword) {
        await reveal();
        await controller.login();
      } else {
        await reveal('login');
      }
    }),
    vscode.commands.registerCommand('cedtGrader.logout', () => controller.logout()),
    vscode.commands.registerCommand('cedtGrader.submit', async (uri?: vscode.Uri) => {
      if (uri instanceof vscode.Uri && uri.scheme === 'file') await controller.setActiveFile(uri);
      await reveal();
      await controller.submit();
    }),
    vscode.commands.registerCommand('cedtGrader.chooseProblem', () => controller.chooseProblemQuickPick()),
    vscode.commands.registerCommand('cedtGrader.showLastResult', () => controller.showLastResult()),
    vscode.commands.registerCommand('cedtGrader.openStatement', () => controller.openStatement()),
    vscode.commands.registerCommand('cedtGrader.refreshProblems', () => controller.refreshProblems(true)),
    vscode.commands.registerCommand('cedtGrader.refreshHistory', () => controller.refreshHistory()),
    vscode.commands.registerCommand('cedtGrader.showRequestLog', () => controller.showRequestLog()),
    // Read-only documents with the source of past submissions (for "Compare with current file").
    vscode.workspace.registerTextDocumentContentProvider(SUBMISSION_SCHEME, {
      provideTextDocumentContent: (uri) => controller.submissionSource(uri),
    }),
    vscode.commands.registerCommand('cedtGrader.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'cedtGrader'),
    ),
  );

  await controller.init();
}

export function deactivate(): void {
  /* disposables handle cleanup */
}
