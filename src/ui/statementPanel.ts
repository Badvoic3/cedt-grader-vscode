import { G, S } from '../shared/strings';
import { currentLang } from '../shared/i18n';
import { KEYS } from '../shared/stateKeys';
import { randomBytes } from 'node:crypto';
import * as cheerio from 'cheerio/slim';
import MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import type { Statement, StatementStore } from '../data/statementStore';
import { type SampleCase, validateSampleCases } from '../mapping/sampleImport';

/** Page, zoom and scroll of a statement tab. */
export interface StatementViewState {
  page: number;
  /** pdf.js scale value: a number as string, or 'page-width'. */
  scale: string;
  scrollTop: number;
  scrollLeft: number;
}

interface Base {
  title: string;
  problemId: number;
  name: string;
  /** Shown above the statement, e.g. when the problem is no longer on the grader. */
  note?: string | null;
}

/** Host → statement webview. */
export type ToStatement =
  | (Base & { type: 'loading' })
  | (Base & { type: 'pdf'; data: Uint8Array; view: StatementViewState | null })
  | (Base & { type: 'html'; html: string })
  | (Base & { type: 'message'; text: string; error: boolean });

/** Statement webview → host. */
export type FromStatement =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openInBrowser' }
  | { type: 'viewState'; state: StatementViewState }
  /** Experimental: sample cases read from the PDF's tables (untrusted: validated in the host). */
  | { type: 'importSamples'; problemId: number; cases: SampleCase[] };

const VIEW_KEY = KEYS.statementView;

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
      /** globalState, for page/zoom/scroll when a tab is closed and reopened. */
      memento: { get<T>(key: string, fallback: T): T; update(key: string, value: unknown): Thenable<void> };
      beside: () => boolean;
      openInBrowser: (problemId: number) => void;
      onError: (err: unknown) => string;
      /** Experimental: import sample cases read from this statement (null = the message was not valid). */
      importSamples: (problemId: number, name: string, cases: SampleCase[] | null) => void;
    },
  ) {}

  static readonly viewType = 'cedtGrader.statement';

  private readonly notes = new Map<number, string | null>();
  private readonly names = new Map<number, string>();

  /**
   * The display language changed: rebuild every open tab in the new language.
   * The statement comes from the disk cache again (no request); page and zoom are kept.
   */
  reloadAll(): void {
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    for (const [id, panel] of this.panels) {
      panel.title = S.statementTab(this.names.get(id) ?? `#${id}`);
      panel.webview.html = this.html(panel.webview, media);
    }
  }

  async open(problemId: number, name: string, opts: { outdated?: string | null } = {}): Promise<void> {
    this.notes.set(problemId, opts.outdated ?? null);
    const existing = this.panels.get(problemId);
    if (existing) {
      existing.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      StatementPanels.viewType,
      S.statementTab(name),
      { viewColumn: this.opts.beside() ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preserveFocus: this.opts.beside() },
      this.webviewOptions(),
    );
    this.attach(panel, problemId, name);
  }

  /** Restore a statement tab after VS Code restarts (panel serializer). Reads the disk cache: no request. */
  revive(panel: vscode.WebviewPanel, state: { problemId?: number; name?: string } | undefined): void {
    if (!state?.problemId || this.panels.has(state.problemId)) {
      panel.dispose();
      return;
    }
    panel.webview.options = this.webviewOptions();
    this.attach(panel, state.problemId, state.name ?? `#${state.problemId}`);
  }

  private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    // retainContextWhenHidden: hiding / showing the tab keeps the rendered PDF (no reload, no request).
    return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')], retainContextWhenHidden: true, enableFindWidget: false };
  }

  private attach(panel: vscode.WebviewPanel, problemId: number, name: string): void {
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
    this.panels.set(problemId, panel);
    this.names.set(problemId, name);
    panel.onDidDispose(() => {
      this.panels.delete(problemId);
      this.names.delete(problemId);
    });
    panel.webview.html = this.html(panel.webview, media);

    const base = () => ({ title: S.statementTab(name), problemId, name, note: this.notes.get(problemId) ?? null });
    const post = (m: ToStatement) => void panel.webview.postMessage(m);
    const load = async (refresh: boolean) => {
      post({ ...base(), type: 'loading' });
      try {
        const view = this.opts.memento.get<Record<string, StatementViewState>>(VIEW_KEY, {})[problemId] ?? null;
        post(render(base(), await this.store.get(problemId, { refresh }), view));
      } catch (err) {
        post({ ...base(), type: 'message', text: this.opts.onError(err), error: true });
      }
    };
    panel.webview.onDidReceiveMessage((m: FromStatement) => {
      if (m?.type === 'ready') void load(false);
      else if (m?.type === 'refresh') void load(true);
      else if (m?.type === 'openInBrowser') this.opts.openInBrowser(problemId);
      else if (m?.type === 'importSamples') this.opts.importSamples(problemId, name, m.problemId === problemId ? validateSampleCases(m.cases) : null);
      else if (m?.type === 'viewState') {
        const all = { ...this.opts.memento.get<Record<string, StatementViewState>>(VIEW_KEY, {}), [problemId]: m.state };
        void this.opts.memento.update(VIEW_KEY, all);
      }
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
<html lang="${currentLang()}">
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
export function render(base: Base, st: Statement, view: StatementViewState | null = null): ToStatement {
  if (st.kind === 'pdf') return { ...base, type: 'pdf', data: st.bytes, view };
  if (st.kind === 'description') {
    if (st.markdown) return { ...base, type: 'html', html: md.render(st.text) };
    // Non-markdown descriptions are HTML written for the website: show their text only.
    const $ = cheerio.load(st.text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '$&\n'));
    return { ...base, type: 'html', html: `<pre class="text">${md.utils.escapeHtml($.root().text().trim())}</pre>` };
  }
  return {
    ...base,
    type: 'message',
    error: false,
    text: st.reason === 'hidden' ? G.statementHidden : G.statementMissing,
  };
}
