import type { BreakScene } from '../flows/breakRules';
import type { TokenColors } from './themeTokens';

/** What the host gives the break tab (src/ui/breakPanel.ts → webview/break/main.ts), as a JSON block. */
export interface BreakData {
  scene: BreakScene;
  /** The lines the editor shows, top to bottom. */
  lines: string[];
  font: { family: string; size: number; lineHeight: number };
  /** Where the editor draws the first visible character (its gutter and breadcrumbs, estimated). */
  layout: { x0: number; y0: number };
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
