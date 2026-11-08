import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { BreakScene } from '../flows/breakRules';
import type { BreakData, CodePaint, EditorView } from '../shared/breakData';
import { BREAK } from '../shared/constants';
import { currentLang } from '../shared/i18n';
import { S } from '../shared/strings';
import { NO_COLORS, tokenColors, type TokenColors } from '../shared/themeTokens';
import { activeTheme, editorPaint } from './codePaint';

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
  async show(scene: BreakScene): Promise<void> {
    this.panel?.dispose();
    const editor = vscode.window.activeTextEditor;
    let paint: CodePaint | null = null;
    let first = 0;
    if (editor) {
      first = editor.visibleRanges[0]?.start.line ?? 0;
      const last = (editor.visibleRanges.at(-1)?.end.line ?? first + 60) + 1;
      try {
        paint = await editorPaint(editor, first, last, vscode.Uri.joinPath(this.extensionUri, 'dist', 'onig.wasm').fsPath);
      } catch (err) {
        this.log(`Break tab colours: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // The tab loads behind the code and comes forward once its first frame (the code, as the editor shows it) is
    // drawn: no empty tab in between.
    const column = editor?.viewColumn ?? vscode.ViewColumn.Active;
    const panel = vscode.window.createWebviewPanel(BreakPanel.viewType, S.breakTab.title, { viewColumn: column, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    });
    this.panel = panel;
    let shown = false, ready = false;
    /** The animation starts only once the tab is in front and has drawn its first frame. */
    const go = () => { if (shown && ready) void panel.webview.postMessage({ type: 'go' }); };
    const bringForward = () => {
      if (this.panel !== panel) return;
      if (!shown) {
        shown = true;
        // The editor lands on the line the tab's first frame starts with, right before the switch; then the keyboard
        // goes to the tab, so Esc works at once.
        const reveal = () => {
          if (this.panel !== panel) return;
          panel.reveal(column, false);
          go();
        };
        if (editor) void snapToLine(editor, (m) => this.log(m)).then(reveal, reveal);
        else reveal();
        return;
      }
      go();
    };
    const fallback = setTimeout(bringForward, BREAK.tabLoadMs);
    panel.onDidDispose(() => { clearTimeout(fallback); if (this.panel === panel) this.panel = null; });
    panel.webview.onDidReceiveMessage((m: unknown) => {
      if (!m || typeof m !== 'object') return;
      const msg = m as { type?: string };
      if (msg.type === 'ready') { ready = true; bringForward(); }
      if (msg.type === 'closed') {
        // The code first (the tab's last frame is the same picture), then the tab goes: no empty frame between.
        if (!editor) { panel.dispose(); return; }
        void vscode.window.showTextDocument(editor.document, { viewColumn: column, preserveFocus: false }).then(
          () => panel.dispose(),
          () => panel.dispose(),
        );
      }
    });
    panel.webview.html = this.html(panel.webview, breakData(scene, editor, this.themeColors(), paint, first));
    if (editor) void vscode.window.showTextDocument(editor.document, { viewColumn: column, preserveFocus: true });
  }

  dispose(): void {
    this.panel?.dispose();
  }

  /** The lexer's colours, used when the editor's own can't be worked out. */
  private themeColors(): TokenColors {
    try {
      const theme = activeTheme();
      if (theme) return tokenColors(theme);
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

/**
 * Scroll the editor so a whole line sits at the top: the first fully visible line. There is no API for the pixel scroll,
 * and `visibleRanges` starts at the first line that is fully visible: `editorScroll` by model lines lands exactly on
 * a line, so one line down and one back up ends on that line. A view already on a whole line doesn't move; one
 * that was part-way into a line moves by less than a line. Both commands go out together, so they land in one frame
 * and nothing flickers. (Scroll values are whole lines; `revealRange` at the top scrolls further, leaving room for
 * sticky-scroll headers.)
 */
export async function snapToLine(editor: vscode.TextEditor, log: (m: string) => void): Promise<void> {
  const first = editor.visibleRanges[0]?.start.line ?? 0;
  // Line 0 fully visible means the view is at the very top. At the very end "down" can't move, and "up" alone would
  // go a line too far: the view stays.
  const beyond = vscode.workspace.getConfiguration('editor', editor.document).get<boolean>('scrollBeyondLastLine') !== false;
  const lastShown = (editor.visibleRanges.at(-1)?.end.line ?? first) >= editor.document.lineCount - 1;
  if (first === 0 || first >= editor.document.lineCount - 1 || (lastShown && !beyond)) return;
  try {
    await Promise.all(['down', 'up'].map((to) => vscode.commands.executeCommand('editorScroll', { to, by: 'line', value: 1 })));
  } catch (err) {
    log(`Break tab scroll: ${String(err)}`);
  }
}

/** What the tab draws: the visible lines, their colours, and the editor's font and layout settings. */
export function breakData(scene: BreakScene, editor: vscode.TextEditor | undefined, colors: TokenColors, paint: CodePaint | null = null, first?: number): BreakData {
  const ed = vscode.workspace.getConfiguration('editor', editor?.document);
  const size = Number(ed.get('fontSize')) || 14;
  const lh = Number(ed.get('lineHeight')) || 0;
  // VS Code: 0 = the golden ratio of the font size, under 8 = a multiplier, else pixels.
  const lineHeight = lh >= 8 ? Math.round(lh) : lh > 0 ? Math.round(size * lh) : Math.round(size * (process.platform === 'darwin' ? 1.5 : 1.35));
  const lines: string[] = [];
  let firstLine = 0;
  if (editor) {
    firstLine = first ?? editor.visibleRanges[0]?.start.line ?? 0;
    const last = (editor.visibleRanges.at(-1)?.end.line ?? firstLine + 60) + 1;
    for (let i = firstLine; i <= last && i < editor.document.lineCount; i++) lines.push(editor.document.lineAt(i).text);
  }
  const ln = ed.get<string>('lineNumbers');
  const view: EditorView = {
    firstLine,
    lineCount: editor?.document.lineCount ?? 1,
    cursor: editor ? { line: editor.selection.active.line, character: editor.selection.active.character } : null,
    lineNumbers: ln === 'off' || ln === 'relative' || ln === 'interval' ? ln : 'on',
    // VS Code's text editors override the setting with 3 (getConfigurationOverrides), whatever the user set.
    lineNumbersMinChars: 3,
    glyphMargin: ed.get<boolean>('glyphMargin') !== false,
    folding: ed.get<boolean>('folding') !== false && ed.get<string>('showFoldingControls') !== 'never',
    lineDecorationsWidth: ((v) => (typeof v === 'number' || typeof v === 'string' ? v : 10))(ed.get('lineDecorationsWidth')),
    tabSize: Number(editor?.options.tabSize) || Number(ed.get('tabSize')) || 4,
    letterSpacing: Number(ed.get('letterSpacing')) || 0,
    fontWeight: String(ed.get('fontWeight') ?? 'normal'),
    top: (vscode.workspace.getConfiguration('breadcrumbs').get<boolean>('enabled') !== false ? 22 : 0) + (Number(ed.get('padding.top')) || 0),
    renderLineHighlight: String(ed.get('renderLineHighlight') ?? 'line'),
    indentGuides: ed.get<boolean>('guides.indentation') !== false,
    focused: !!editor,
  };
  return {
    scene,
    lines,
    font: { family: ed.get<string>('fontFamily') || 'monospace', size, lineHeight },
    view,
    paint,
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
