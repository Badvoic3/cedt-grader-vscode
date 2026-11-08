import type { BreakScene } from '../flows/breakRules';
import type { TokenColors } from './themeTokens';

/**
 * The editor's colours for the visible lines (src/ui/textmatePaint.ts). Palette entries are colours, or names the
 * webview resolves from VS Code's own CSS variables: `fg` (editor foreground), `b<n>` (bracket level n), `bu`
 * (unexpected bracket).
 */
export interface CodePaint {
  palette: string[];
  /** Per visible line: [length, palette index, font bits (1 italic, 2 bold, 4 underline, 8 strikethrough), …]. */
  runs: number[][];
}

/** What the editor shows around the text, so the tab's first and last frames match it (VS Code's layout rules). */
export interface EditorView {
  /** 0-based number of the first visible line; the editor is scrolled so it sits exactly at the top. */
  firstLine: number;
  lineCount: number;
  cursor: { line: number; character: number } | null;
  lineNumbers: 'on' | 'off' | 'relative' | 'interval';
  lineNumbersMinChars: number;
  glyphMargin: boolean;
  /** Folding controls take 16 px of the decorations lane. */
  folding: boolean;
  /** `editor.lineDecorationsWidth`: pixels, or "<n>ch". */
  lineDecorationsWidth: number | string;
  tabSize: number;
  letterSpacing: number;
  fontWeight: string;
  /** Breadcrumbs height above the text (0 when off). */
  top: number;
  renderLineHighlight: string;
  indentGuides: boolean;
  /** The editor had the keyboard (its current line and cursor show). */
  focused: boolean;
}

/** What the host gives the break tab (src/ui/breakPanel.ts → webview/break/main.ts), as a JSON block. */
export interface BreakData {
  scene: BreakScene;
  /** The lines the editor shows, top to bottom. */
  lines: string[];
  font: { family: string; size: number; lineHeight: number };
  view: EditorView;
  /** The editor's colours (null: the tab's own lexer with `colors`). */
  paint: CodePaint | null;
  colors: TokenColors;
  /** The break's countdown. */
  seconds: number;
  texts: {
    breakTitle: string;
    breakDone: string;
    breakSub: string;
    back: string;
    backBtn: string;
    moveMouse: string;
    sandHint: string;
    donutHint: string;
    breatheIn: string;
    breatheOut: string;
  };
}
