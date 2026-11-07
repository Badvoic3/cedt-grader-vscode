import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Runner } from '../flows/runner';
import type { TestCases } from '../flows/testcases';
import { nothingSent, testsDelta } from '../runner/view';
import { currentLang } from '../shared/i18n';
import { type FromTests, isFromWebview, type ToTests } from '../shared/messages';
import { S } from '../shared/strings';

/** The share of the editor the split takes when we create it. */
const SPLIT_SIZE = 1 / 3;

/**
 * The one "Tests: <problem>" tab, a small split beside the code. It follows
 * the active file, never takes the keyboard, and only sends what changed.
 */
export class TestPanel implements vscode.Disposable {
  static readonly viewType = 'cedtGrader.tests';
  private panel: vscode.WebviewPanel | null = null;
  private ready = false;
  private sent = nothingSent();
  private sentHead = '';
  private sentOrder = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly opts: {
      runner: () => Runner;
      tests: () => TestCases;
      /** The statement's group when it isn't the code's: the tab goes there. */
      sharedColumn: () => vscode.ViewColumn | undefined;
      /** Messages wait until the session is read. */
      started: Promise<unknown>;
      webviewError: (message: string, stack: string) => void;
      log: (msg: string) => void;
    },
  ) {}

  /** Open the split, or show the tab. The keyboard stays in the editor. */
  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }
    const shared = this.opts.sharedColumn();
    // Our own split only: a layout the user already has keeps its sizes.
    const newSplit = !shared && vscode.window.tabGroups.all.length === 1;
    const panel = vscode.window.createWebviewPanel(TestPanel.viewType, S.testsTab(''), { viewColumn: shared ?? vscode.ViewColumn.Beside, preserveFocus: true }, this.webviewOptions());
    this.attach(panel);
    if (newSplit) {
      await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0, groups: [{ size: 1 - SPLIT_SIZE }, { size: SPLIT_SIZE }] }).then(undefined, (err: unknown) => this.opts.log(`Test split size: ${String(err)}`));
    }
  }

  /** Restore the tab after VS Code restarts. */
  revive(panel: vscode.WebviewPanel): void {
    if (this.panel) {
      panel.dispose();
      return;
    }
    panel.webview.options = this.webviewOptions();
    this.attach(panel);
  }

  private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    // Hiding the tab keeps open cases and text being typed.
    return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')], retainContextWhenHidden: true };
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    this.ready = false;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m: unknown) => {
      if (isFromWebview(m)) void this.handle(m as unknown as FromTests);
    });
    panel.onDidChangeViewState(() => {
      if (panel.visible) this.opts.runner().fetchLimits();
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = null;
    });
  }

  /** The display language changed. */
  reload(): void {
    if (!this.panel) return;
    this.ready = false;
    this.panel.webview.html = this.html(this.panel.webview);
  }

  /** The state changed: send what is new. */
  update(): void {
    const panel = this.panel;
    if (!panel || !this.ready) return;
    const v = this.opts.runner().testsView();
    const keyChanged = this.sent.key !== v.key;
    const d = testsDelta(this.sent, v.key, v.cases, v.runs);
    const head = JSON.stringify(v.head);
    const order = d.order.join();
    if (!d.fresh && !d.cases.length && !Object.keys(d.runs).length && head === this.sentHead && order === this.sentOrder) return;
    this.sentHead = head;
    this.sentOrder = order;
    panel.title = S.testsTab(v.head.title ?? '');
    const m: ToTests = { type: 'state', head: v.head, ...d };
    void panel.webview.postMessage(m);
    if (keyChanged && panel.visible) this.opts.runner().fetchLimits();
  }

  private async handle(m: FromTests): Promise<void> {
    if (m.type === 'webviewError') {
      this.opts.webviewError(m.message, m.stack);
      return;
    }
    await this.opts.started;
    const r = this.opts.runner();
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.sent = nothingSent();
        this.update();
        return;
      case 'run':
        await r.run(m.caseId ? [m.caseId] : undefined);
        return;
      case 'stop':
        r.stop();
        return;
      case 'add':
        await r.addCase();
        return;
      case 'edit':
        await r.editCase(m.caseId, { ...(typeof m.input === 'string' ? { input: m.input } : {}), ...(typeof m.expected === 'string' ? { expected: m.expected } : {}) });
        return;
      case 'remove':
        await r.removeCase(m.caseId);
        return;
      case 'reorder':
        if (Array.isArray(m.ids)) await r.reorderCases(m.ids);
        return;
      case 'setExpected':
        await r.setExpected(m.caseId);
        return;
      case 'copy': {
        const text = r.textOf(m.caseId, m.what);
        if (text !== null) await vscode.env.clipboard.writeText(text);
        return;
      }
      case 'copyFailure': {
        const text = r.failureText();
        if (text !== null) await vscode.env.clipboard.writeText(text);
        return;
      }
      case 'loadTestcases':
        await this.opts.tests().loadTestcases(false);
        return;
      case 'loadSamples':
        await this.opts.tests().loadSampleCases();
        return;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p)).toString();
    const csp = ["default-src 'none'", `style-src ${webview.cspSource}`, `font-src ${webview.cspSource}`, `img-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');
    return `<!DOCTYPE html>
<html lang="${currentLang()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('dist', 'codicon.css')}">
<link rel="stylesheet" href="${uri('dist', 'webview.css')}">
<link rel="stylesheet" href="${uri('dist', 'tests.css')}">
<title>Tests</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('dist', 'tests.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
