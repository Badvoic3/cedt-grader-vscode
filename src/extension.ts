import { TIMING } from './shared/constants';
import * as vscode from 'vscode';
import { GraderController, SUBMISSION_SCHEME } from './controller';
import { SidebarProvider } from './ui/sidebarProvider';
import { StatementPanels } from './ui/statementPanel';
import { GraderStatusBar } from './ui/statusBar';
import { WALKTHROUGH_CONTEXT, WALKTHROUGH_ID, walkthroughContext } from './shared/walkthrough';

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
  const walkthroughState: Record<string, boolean> = {};

  const reveal = async (target?: 'login' | 'problem-search' | 'submit') => {
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
    if (target) setTimeout(() => sidebar.focus(target), TIMING.focusDelayMs);
  };

  ctx.subscriptions.push(
    controller,
    sidebar,
    statusBar,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar),
    controller.onState((s) => statusBar.update(s)),
    // Getting Started walkthrough: steps complete through these context keys (set only when they change).
    // VS Code opens the walkthrough once after the extension is installed (workbench.welcomePage.walkthroughs.openOnInstall).
    controller.onState((s) => {
      const next = walkthroughContext(s, walkthroughState[WALKTHROUGH_CONTEXT.submitted] === true);
      for (const [key, value] of Object.entries(next)) {
        if (walkthroughState[key] === value) continue;
        walkthroughState[key] = value;
        void vscode.commands.executeCommand('setContext', key, value);
      }
    }),
    vscode.commands.registerCommand('cedtGrader.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${ctx.extension.id}#${WALKTHROUGH_ID}`, false),
    ),

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
    vscode.commands.registerCommand('cedtGrader.clearMapping', () => controller.unmapCurrentFile()),
    vscode.commands.registerCommand('cedtGrader.renameFileToProblem', () => controller.renameFileToProblem()),
    vscode.commands.registerCommand('cedtGrader.loadTestcases', () => controller.loadTestcases(false)),
    vscode.commands.registerCommand('cedtGrader.showRequestLog', () => controller.showRequestLog()),
    vscode.commands.registerCommand('cedtGrader.clearCache', () => controller.clearCachedData()),
    // Read-only documents with the source of past submissions (for "Compare with current file").
    // Statement tabs reopen after a restart, from the disk cache (no request).
    vscode.window.registerWebviewPanelSerializer(StatementPanels.viewType, {
      deserializeWebviewPanel: async (panel, state) => controller.statements.revive(panel, state as { problemId?: number; name?: string }),
    }),
    vscode.workspace.registerTextDocumentContentProvider(SUBMISSION_SCHEME, {
      provideTextDocumentContent: (uri) => controller.submissionSource(uri),
    }),
    vscode.commands.registerCommand('cedtGrader.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'cedtGrader'),
    ),
  );

  try {
    await controller.init();
  } catch (err) {
    // Activation must not fail because of bad saved data; the panel still works.
    controller.logError('Init failed', err);
  }
}

export function deactivate(): void {
  /* disposables handle cleanup */
}
