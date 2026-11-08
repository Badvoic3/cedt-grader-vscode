import { G, S } from '../shared/strings';
import type { LookView } from '../shared/look';
import { currentLang } from '../shared/i18n';
import { KEYS } from '../shared/stateKeys';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Statement, StatementStore } from '../data/statementStore';

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
  | (Base & { type: 'message'; text: string; error: boolean })
  | { type: 'look'; look: LookView };

/** Statement webview → host. */
export type FromStatement =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'openInBrowser' }
  | { type: 'close' }
  | { type: 'viewState'; state: StatementViewState; problemId?: number };

const VIEW_KEY = KEYS.statementView;

/**
 * Read-only "Statement: <problem>" editor tabs (one per problem), rendering
 * the PDF with the bundled pdf.js, or the text description.
 *
 * Following the active file (`follow`): the most recently active tab shows
 * the active file's problem (a tab already showing it is revealed instead);
 * a source file without a problem closes that tab.
 */
export class StatementPanels implements vscode.Disposable {
  private readonly panels = new Map<number, vscode.WebviewPanel>();
  /** Show another problem in an open tab (set by attach). */
  private readonly retarget = new WeakMap<vscode.WebviewPanel, (problemId: number, name: string) => void>();
  /** The tab that follows the active file: the last one that was active. */
  private following: vscode.WebviewPanel | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: StatementStore,
    private readonly opts: {
      look: () => LookView;
      /** globalState, for page/zoom/scroll when a tab is closed and reopened. */
      memento: { get<T>(key: string, fallback: T): T; update(key: string, value: unknown): Thenable<void> };
      beside: () => boolean;
      /** The open Test split: "beside" means there, not in a third group. */
      besideColumn: () => vscode.ViewColumn | undefined;
      openInBrowser: (problemId: number) => void;
      onError: (err: unknown) => string;
    },
  ) {}

  /** The look setting changed: the open tabs follow. */
  lookChanged(): void {
    for (const p of this.panels.values()) void p.webview.postMessage({ type: 'look', look: this.opts.look() } satisfies ToStatement);
  }

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

  /**
   * The active file's problem changed (null: a source file with no problem).
   * Only an open tab changes: nothing opens, focus stays in the editor. The
   * statement comes from the disk cache, else the same request as opening it.
   */
  follow(target: { problemId: number; name: string; outdated?: string | null } | null): void {
    const panel = this.following && [...this.panels.values()].includes(this.following) ? this.following : [...this.panels.values()].at(-1);
    if (!panel) return;
    if (!target) {
      panel.dispose();
      return;
    }
    this.notes.set(target.problemId, target.outdated ?? null);
    const shown = this.panels.get(target.problemId);
    if (shown) {
      if (!shown.visible) shown.reveal(undefined, true);
      this.following = shown;
      return;
    }
    this.retarget.get(panel)?.(target.problemId, target.name);
  }

  /** Where an open statement tab is. */
  column(): vscode.ViewColumn | undefined {
    return [...this.panels.values()].at(-1)?.viewColumn;
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
      { viewColumn: this.opts.beside() ? (this.opts.besideColumn() ?? vscode.ViewColumn.Beside) : vscode.ViewColumn.Active, preserveFocus: this.opts.beside() },
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
    // What this tab shows (changes when it follows the active file).
    const t = { problemId, name };
    this.panels.set(problemId, panel);
    this.names.set(problemId, name);
    this.following = panel;
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) this.following = panel;
    });
    panel.onDidDispose(() => {
      if (this.panels.get(t.problemId) === panel) this.panels.delete(t.problemId);
      this.names.delete(t.problemId);
      if (this.following === panel) this.following = null;
    });
    panel.webview.html = this.html(panel.webview, media);

    const base = () => ({ title: S.statementTab(t.name), problemId: t.problemId, name: t.name, note: this.notes.get(t.problemId) ?? null });
    const post = (m: ToStatement) => void panel.webview.postMessage(m);
    const load = async (refresh: boolean) => {
      const id = t.problemId;
      post({ ...base(), type: 'loading' });
      try {
        const view = this.opts.memento.get<Record<string, StatementViewState>>(VIEW_KEY, {})[id] ?? null;
        const st = await this.store.get(id, { refresh });
        const message = await render(base(), st, view);
        if (t.problemId === id) post(message); // switched again meanwhile: the newer load posts
      } catch (err) {
        if (t.problemId === id) post({ ...base(), type: 'message', text: this.opts.onError(err), error: true });
      }
    };
    this.retarget.set(panel, (id, newName) => {
      if (this.panels.get(t.problemId) === panel) this.panels.delete(t.problemId);
      this.names.delete(t.problemId);
      t.problemId = id;
      t.name = newName;
      this.panels.set(id, panel);
      this.names.set(id, newName);
      panel.title = S.statementTab(newName);
      void load(false);
    });
    panel.webview.onDidReceiveMessage((m: FromStatement) => {
      if (m?.type === 'ready') {
        post({ type: 'look', look: this.opts.look() });
        void load(false);
      }
      else if (m?.type === 'refresh') void load(true);
      else if (m?.type === 'openInBrowser') this.opts.openInBrowser(t.problemId);
      else if (m?.type === 'close') panel.dispose();
      else if (m?.type === 'viewState') {
        // The webview says which problem the view belongs to (a save can arrive after a switch).
        const id = typeof m.problemId === 'number' ? m.problemId : t.problemId;
        const all = { ...this.opts.memento.get<Record<string, StatementViewState>>(VIEW_KEY, {}), [id]: m.state };
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
<body data-worker="${uri('dist', 'pdfjs', 'pdf.worker.min.mjs')}" data-fonts="${uri('dist', 'pdfjs', 'standard_fonts')}/">
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
export async function render(base: Base, st: Statement, view: StatementViewState | null = null): Promise<ToStatement> {
  if (st.kind === 'pdf') return { ...base, type: 'pdf', data: st.bytes, view };
  if (st.kind === 'description') {
    const { descriptionHtml } = await import('./descriptionHtml');
    return { ...base, type: 'html', html: descriptionHtml(st.text, st.markdown) };
  }
  return {
    ...base,
    type: 'message',
    error: false,
    text: st.reason === 'hidden' ? G.statementHidden : G.statementMissing,
  };
}
