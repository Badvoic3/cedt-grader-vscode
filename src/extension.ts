import { TIMING } from './shared/constants';
import * as vscode from 'vscode';
import { GraderController, SUBMISSION_SCHEME } from './controller';
import { SidebarProvider } from './ui/sidebarProvider';
import { StatementPanels } from './ui/statementPanel';
import { CompareDocs } from './ui/compareDocs';
import { TestPanel } from './ui/testPanel';
import { GraderStatusBar } from './ui/statusBar';
import { readConfig } from './config';
import { CrashReporter } from './crashReporter';
import { resolveLang, setLanguage } from './shared/i18n';

/**
 * Entry point. The sidebar (SidebarProvider) is the primary UI; the commands
 * below drive the same controller so keyboard shortcuts keep working.
 *
 * Nothing logs in on activation: login only happens on an explicit user
 * action (see the device-lock note in CLAUDE.md).
 */
export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const crash = new CrashReporter(ctx);
  ctx.subscriptions.push(crash);
  try {
    start(ctx, crash);
  } catch (err) {
    crash.report(err, 'activation', { notify: true });
    throw err;
  }
}

function start(ctx: vscode.ExtensionContext, crash: CrashReporter): void {
  // Display language first: every text read after this is in it (changes apply live, see GraderController).
  setLanguage(resolveLang(readConfig().displayLanguage, vscode.env.language));
  const controller = new GraderController(ctx, crash);
  const sidebar = new SidebarProvider(ctx.extensionUri, controller);
  const statusBar = new GraderStatusBar();

  // Activation doesn't wait for `controller.init()`, so the panel can load meanwhile; commands do.
  const command = <A extends unknown[]>(id: string, run: (...args: A) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: A) => {
      await controller.started;
      try {
        return await run(...args);
      } catch (err) {
        crash.report(err, `command ${id.replace('cedtGrader.', '')}`);
        throw err;
      }
    });

  const reveal = async (target?: 'login' | 'problem-search' | 'submit') => {
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
    if (target) setTimeout(() => sidebar.focus(target), TIMING.focusDelayMs);
  };

  ctx.subscriptions.push(
    controller,
    sidebar,
    statusBar,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar),
    vscode.window.registerFileDecorationProvider(controller.badges),
    controller.onState((s) => statusBar.update(s)),

    vscode.commands.registerCommand('cedtGrader.focus', () => reveal()),
    command('cedtGrader.login', async () => {
      const s = controller.state();
      if (s.account.username && s.account.hasSavedPassword) {
        await reveal();
        await controller.login();
      } else {
        await reveal('login');
      }
    }),
    command('cedtGrader.logout', () => controller.logout()),
    command('cedtGrader.submit', async (uri?: vscode.Uri) => {
      if (uri instanceof vscode.Uri && uri.scheme === 'file') await controller.setActiveFile(uri);
      await reveal();
      await controller.submit();
    }),
    command('cedtGrader.chooseProblem', () => controller.chooseProblemQuickPick()),
    command('cedtGrader.showLastResult', () => controller.showLastResult()),
    command('cedtGrader.openStatement', () => controller.openStatement()),
    command('cedtGrader.refreshProblems', () => controller.refreshProblems(true)),
    command('cedtGrader.refreshHistory', () => controller.refreshHistory()),
    command('cedtGrader.clearMapping', () => controller.unmapCurrentFile()),
    command('cedtGrader.renameFileToProblem', () => controller.renameFileToProblem()),
    command('cedtGrader.downloadAttachment', () => controller.downloadAttachment()),
    command('cedtGrader.toggleFolderMode', () => controller.toggleFolderMode()),
    command('cedtGrader.runTests', () => controller.runTests()),
    command('cedtGrader.openTests', () => controller.toggleTests()),
    command('cedtGrader.loadTestcases', () => controller.loadTestcases(false)),
    command('cedtGrader.loadSampleCases', () => controller.loadSampleCases()),
    command('cedtGrader.showRequestLog', () => controller.showRequestLog()),
    command('cedtGrader.clearCache', () => controller.clearCachedData()),
    command('cedtGrader.cleanUpOldFiles', () => controller.cleanUpOldFiles()),
    command('cedtGrader.takeBreak', () => controller.takeBreak()),
    command('cedtGrader.playCelebration', () => controller.playCelebration()),
    command('cedtGrader.showTrophies', () => controller.showTrophies()),
    command('cedtGrader.takeBreak.sand', () => controller.takeBreak('sand')),
    command('cedtGrader.takeBreak.donut3d', () => controller.takeBreak('donut3d')),
    command('cedtGrader.takeBreak.donut2d', () => controller.takeBreak('donut2d')),
    command('cedtGrader.takeBreak.breathe', () => controller.takeBreak('breathe')),
    command('cedtGrader.takeBreak.swarm', () => controller.takeBreak('swarm')),
    command('cedtGrader.openUserGuide', () => controller.openUserGuide()),
    command('cedtGrader.openTroubleshooting', () => controller.openTroubleshooting()),
    // Read-only documents with the source of past submissions (for "Compare with current file").
    // Statement tabs reopen after a restart, from the disk cache (no request).
    vscode.window.registerWebviewPanelSerializer(StatementPanels.viewType, {
      deserializeWebviewPanel: async (panel, state) => controller.statements.revive(panel, state as { problemId?: number; name?: string }),
    }),
    vscode.window.registerWebviewPanelSerializer(TestPanel.viewType, {
      deserializeWebviewPanel: async (panel) => controller.testPanel.revive(panel),
    }),
    vscode.workspace.registerTextDocumentContentProvider(CompareDocs.scheme, controller.compareDocs),
    vscode.workspace.registerTextDocumentContentProvider(SUBMISSION_SCHEME, {
      provideTextDocumentContent: async (uri) => {
        await controller.started;
        return controller.submissionSource(uri);
      },
    }),
    vscode.commands.registerCommand('cedtGrader.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'cedtGrader'),
    ),
  );

  // Development builds only: the path a real bug takes (checklist: "Crash report").
  if (ctx.extensionMode === vscode.ExtensionMode.Development) {
    void vscode.commands.executeCommand('setContext', 'cedtGrader.devMode', true);
    ctx.subscriptions.push(
      vscode.commands.registerCommand('cedtGrader.testCrashReport', () => {
        void Promise.reject(new TypeError(`Test crash report & more #1 from ${ctx.globalStorageUri.fsPath}/main.cpp`));
      }),
    );
  }

  void controller.init();
}

export function deactivate(): void {
  /* disposables handle cleanup */
}
