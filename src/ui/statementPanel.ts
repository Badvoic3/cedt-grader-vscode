import { randomBytes } from 'node:crypto';
import * as cheerio from 'cheerio/slim';
import MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import type { Statement, StatementStore } from '../data/statementStore';

/** Host → statement webview. */
export type ToStatement =
  | { type: 'loading'; title: string }
  | { type: 'pdf'; title: string; data: Uint8Array }
  | { type: 'html'; title: string; html: string }
  | { type: 'message'; title: string; text: string; error: boolean };

/** Statement webview → host. */
export type FromStatement = { type: 'ready' } | { type: 'refresh' } | { type: 'openInBrowser' };

/** Raw HTML is disabled: markdown-it escapes it, so the output is safe to insert. */
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/**
 * Read-only "Statement: <problem>" editor tabs (one per problem), rendering
 * the PDF with the bundled pdf.js, or the text description.
 */
export class StatementPanels implements vscode.Disposable {
  private readonly panels = new Map<number, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: StatementStore,
    private readonly opts: {
      beside: () => boolean;
      openInBrowser: (problemId: number) => void;
      onError: (err: unknown) => string;
    },
  ) {}

  async open(problemId: number, name: string): Promise<void> {
    const existing = this.panels.get(problemId);
    if (existing) {
      existing.reveal();
      return;
    }
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'cedtGrader.statement',
      `Statement: ${name}`,
      { viewColumn: this.opts.beside() ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preserveFocus: this.opts.beside() },
      { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true, enableFindWidget: false },
    );
    panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
    this.panels.set(problemId, panel);
    panel.onDidDispose(() => this.panels.delete(problemId));
    panel.webview.html = this.html(panel.webview, media);

    const title = `Statement: ${name}`;
    const post = (m: ToStatement) => void panel.webview.postMessage(m);
    const load = async (refresh: boolean) => {
      post({ type: 'loading', title });
      try {
        post(render(title, await this.store.get(problemId, { refresh })));
      } catch (err) {
        post({ type: 'message', title, text: this.opts.onError(err), error: true });
      }
    };
    panel.webview.onDidReceiveMessage((m: FromStatement) => {
      if (m?.type === 'ready') void load(false);
      else if (m?.type === 'refresh') void load(true);
      else if (m?.type === 'openInBrowser') this.opts.openInBrowser(problemId);
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(media, ...p)).toString();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`, // pdf.js sets inline styles on pages / text layer
      `font-src ${webview.cspSource} data:`,
      `img-src ${webview.cspSource} data: blob:`,
      `script-src 'nonce-${nonce}'`,
      // pdf.js worker: fetched from media/ and started from a blob URL.
      `worker-src blob:`,
      `connect-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('dist', 'codicon.css')}">
<link rel="stylesheet" href="${uri('dist', 'pdfjs', 'pdf_viewer.css')}">
<link rel="stylesheet" href="${uri('dist', 'statement.css')}">
<title>Statement</title>
</head>
<body data-worker="${uri('dist', 'pdfjs', 'pdf.worker.min.mjs')}" data-cmaps="${uri('dist', 'pdfjs', 'cmaps')}/" data-fonts="${uri('dist', 'pdfjs', 'standard_fonts')}/">
<div id="app"></div>
<script nonce="${nonce}" type="module" src="${uri('dist', 'statement.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const p of this.panels.values()) p.dispose();
    this.panels.clear();
  }
}

/** Turn a cached statement into a webview message. Descriptions are rendered safely in the host. */
export function render(title: string, st: Statement): ToStatement {
  if (st.kind === 'pdf') return { type: 'pdf', title, data: st.bytes };
  if (st.kind === 'description') {
    if (st.markdown) return { type: 'html', title, html: md.render(st.text) };
    // Non-markdown descriptions are HTML written for the website: show their text only.
    const $ = cheerio.load(st.text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '$&\n'));
    return { type: 'html', title, html: `<pre class="text">${md.utils.escapeHtml($.root().text().trim())}</pre>` };
  }
  return {
    type: 'message',
    title,
    error: false,
    text: st.reason === 'hidden' ? 'The statement is not available in VS Code for this problem. Use "Open in Browser".' : 'This problem has no statement.',
  };
}
