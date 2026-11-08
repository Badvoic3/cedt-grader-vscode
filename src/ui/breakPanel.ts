import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BreakScene } from '../flows/breakRules';
import type { BreakData } from '../shared/breakData';
import { BREAK } from '../shared/constants';
import { currentLang } from '../shared/i18n';
import { S } from '../shared/strings';
import { collectTheme, NO_COLORS, parseJsonc, type ThemeJson, tokenColors, type TokenColors } from '../shared/themeTokens';

/**
 * The break tab: the active editor's visible code, in the theme's colours, moves into one of five scenes
 * (webview/break/main.ts). It opens in the code's own group, over the code; Esc or "Back to code" plays the way
 * back, then the tab closes and the keyboard returns to the editor.
 */
export class BreakPanel implements vscode.Disposable {
  static readonly viewType = 'cedtGrader.break';
  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: (msg: string) => void,
  ) {}

  get open(): boolean {
    return !!this.panel;
  }

  /** Show `scene` over the active editor's code (an empty tab when there is no editor). */
  show(scene: BreakScene): void {
    this.panel?.dispose();
    const editor = vscode.window.activeTextEditor;
    const panel = vscode.window.createWebviewPanel(BreakPanel.viewType, S.breakTab.title, { viewColumn: editor?.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    });
    this.panel = panel;
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = null; });
    panel.webview.onDidReceiveMessage((m: unknown) => {
      if (!m || typeof m !== 'object') return;
      const msg = m as { type?: string };
      // Ready: make sure the keyboard is in the tab, so Esc works at once.
      if (msg.type === 'ready') panel.reveal(undefined, false);
      if (msg.type === 'closed') {
        panel.dispose();
        if (editor) void vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
      }
    });
    panel.webview.html = this.html(panel.webview, breakData(scene, editor, this.themeColors()));
  }

  dispose(): void {
    this.panel?.dispose();
  }

  /** The active colour theme's token colours (built-in and most installed themes; nothing when it can't be read). */
  private themeColors(): TokenColors {
    try {
      const label = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme') ?? '';
      const norm = (s: string) => s.replace(/^Default /, '');
      for (const ext of vscode.extensions.all) {
        const themes = (ext.packageJSON as { contributes?: { themes?: { id?: string; label?: string; path?: string }[] } }).contributes?.themes ?? [];
        const t = themes.find((x) => x.path && (norm(x.id ?? x.label ?? '') === norm(label) || x.label === label));
        if (!t?.path) continue;
        const file = path.join(ext.extensionPath, t.path);
        const read = (f: string): ThemeJson | null => parseJsonc(readFileSync(f, 'utf8'));
        const first = read(file);
        if (!first) return NO_COLORS;
        const files = new Map<ThemeJson, string>([[first, file]]);
        const theme = collectTheme(first, (inc, from) => {
          const f = path.join(path.dirname(files.get(from) ?? file), inc), j = read(f);
          if (j) files.set(j, f);
          return j;
        });
        return tokenColors(theme);
      }
    } catch (err) {
      this.log(`Break tab theme colours: ${String(err)}`);
    }
    return NO_COLORS;
  }

  private html(webview: vscode.Webview, data: BreakData): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', ...p)).toString();
    const csp = ["default-src 'none'", `style-src ${webview.cspSource}`, `font-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`].join('; ');
    // The data block is JSON, never run; `<` is escaped so no text in the user's code can close the tag.
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="${currentLang()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('dist', 'break.css')}">
<title>${S.breakTab.title}</title>
</head>
<body>
<canvas id="c"></canvas>
<div id="card" class="card" role="status"></div>
<div id="foot" class="foot"></div>
<button id="back" class="back" type="button"></button>
<script type="application/json" id="break-data">${json}</script>
<script nonce="${nonce}" src="${uri('dist', 'break.js')}"></script>
</body>
</html>`;
  }
}

/** What the tab draws: the visible lines, the editor's font and an estimate of where its text starts. */
export function breakData(scene: BreakScene, editor: vscode.TextEditor | undefined, colors: TokenColors): BreakData {
  const ed = vscode.workspace.getConfiguration('editor');
  const size = Number(ed.get('fontSize')) || 14;
  const lh = Number(ed.get('lineHeight')) || 0;
  const lineHeight = lh > 8 ? lh : lh > 0 ? Math.round(size * lh) : Math.round(size * (process.platform === 'darwin' ? 1.5 : 1.35));
  const lines: string[] = [];
  let digits = 2;
  if (editor) {
    const first = editor.visibleRanges[0]?.start.line ?? 0;
    const last = editor.visibleRanges[editor.visibleRanges.length - 1]?.end.line ?? first + 60;
    for (let i = first; i <= last && i < editor.document.lineCount; i++) lines.push(editor.document.lineAt(i).text);
    digits = Math.max(2, String(editor.document.lineCount).length);
  }
  const lineNumbers = ed.get<string>('lineNumbers') !== 'off';
  const breadcrumbs = vscode.workspace.getConfiguration('breadcrumbs').get<boolean>('enabled') !== false;
  // Estimate: glyph margin + line numbers + folding; breadcrumbs above the text.
  const x0 = Math.round(18 + (lineNumbers ? (digits + 1) * size * 0.6 : 0) + 24);
  return {
    scene,
    lines,
    font: { family: ed.get<string>('fontFamily') || 'monospace', size, lineHeight },
    layout: { x0, y0: breadcrumbs ? 22 : 0 },
    colors,
    seconds: BREAK.breakSeconds,
    texts: {
      breakTitle: S.breakTab.breakTitle,
      breakDone: S.breakTab.breakDone,
      breakSub: S.breakTab.breakSub,
      back: S.breakTab.back,
      backBtn: S.breakTab.backBtn,
      moveMouse: S.breakTab.moveMouse,
      sandHint: S.breakTab.sandHint,
      donutHint: S.breakTab.donutHint,
      breatheIn: S.breakTab.breatheIn,
      breatheOut: S.breakTab.breatheOut,
    },
  };
}
