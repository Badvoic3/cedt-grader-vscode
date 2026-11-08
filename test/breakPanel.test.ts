import { describe, expect, it, vi } from 'vitest';

const v = vi.hoisted(() => ({
  panels: [] as { html: string; disposed: boolean; onMsg: (m: unknown) => void; opts: unknown; column: unknown }[],
  shown: [] as unknown[],
  revealed: [] as unknown[][],
  posted: [] as unknown[],
  commands: [] as unknown[][],
  settings: new Map<string, unknown>([['editor.fontSize', 13], ['editor.lineHeight', 0], ['editor.fontFamily', 'Menlo'], ['workbench.colorTheme', 'Nope']]),
}));

vi.mock('vscode', () => ({
  ViewColumn: { Active: -1, One: 1 },
  Range: class { constructor(public sl: number, public sc: number, public el: number, public ec: number) {} },
  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  Uri: { joinPath: (_: unknown, ...p: string[]) => ({ path: p.join('/'), toString: () => p.join('/') }) },
  extensions: { all: [] },
  commands: { executeCommand: async (...a: unknown[]) => void v.commands.push(a) },
  workspace: { getConfiguration: (section: string) => ({ get: (k: string, d?: unknown) => v.settings.get(`${section}.${k}`) ?? d }) },
  window: {
    activeTextEditor: undefined as unknown,
    activeColorTheme: { kind: 2 },
    showTextDocument: async (doc: unknown) => void v.shown.push(doc),
    createWebviewPanel: (_type: string, _title: string, column: unknown, opts: unknown) => {
      const p: (typeof v.panels)[number] = { html: '', disposed: false, onMsg: () => undefined, opts, column };
      v.panels.push(p);
      const disposers: (() => void)[] = [];
      return {
        webview: {
          cspSource: 'vscode-resource:',
          asWebviewUri: (u: { path: string }) => ({ toString: () => `vscode-resource:/${u.path}` }),
          onDidReceiveMessage: (f: (m: unknown) => void) => void (p.onMsg = f),
          postMessage: async (m: unknown) => (v.posted.push(m), true),
          set html(h: string) { p.html = h; },
          get html() { return p.html; },
        },
        reveal: (...a: unknown[]) => void v.revealed.push(a),
        onDidDispose: (f: () => void) => void disposers.push(f),
        dispose: () => { p.disposed = true; disposers.forEach((f) => f()); },
      };
    },
  },
}));

import * as vscode from 'vscode';
import { BreakPanel, breakData } from '../src/ui/breakPanel';
import { NO_COLORS } from '../src/shared/themeTokens';

const editor = (lines: string[]) => ({
  viewColumn: 1,
  visibleRanges: [{ start: { line: 1 }, end: { line: 1 } }],
  selection: { active: { line: 2, character: 3 } },
  options: { tabSize: 2 },
  document: { lineCount: lines.length, lineAt: (i: number) => ({ text: lines[i] }) },
});

describe('break tab', () => {
  it('sends the visible lines, the editor font, its layout settings and the texts; the code can never close the data block', async () => {
    const d = breakData('sand', editor(['skip', 'int main() { // </script><script>alert(1)', 'return 0;', 'below']) as never, NO_COLORS);
    expect(d.lines).toEqual(['int main() { // </script><script>alert(1)', 'return 0;']); // the visible lines and one more
    expect(d.font).toEqual({ family: 'Menlo', size: 13, lineHeight: Math.round(13 * (process.platform === 'darwin' ? 1.5 : 1.35)) });
    expect(d.view).toMatchObject({ firstLine: 1, lineCount: 4, cursor: { line: 2, character: 3 }, lineNumbers: 'on', lineNumbersMinChars: 3, glyphMargin: true, folding: true, lineDecorationsWidth: 10, tabSize: 2, top: 22 });
    expect(d.paint).toBeNull();
    expect(d.texts.backBtn).toBe('Back to code');
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = editor(['a', '</script><script>alert(1)</script>', 'c']);
    v.commands.length = 0;
    await new BreakPanel({ path: 'ext' } as never, () => undefined).show('breathe');
    expect(v.commands).toEqual([]); // the editor moves only right before the tab comes forward
    v.panels.at(-1)!.onMsg({ type: 'ready' });
    // The scroll snaps to a whole line: one line down and back up, sent together.
    expect(v.commands).toEqual([['editorScroll', { to: 'down', by: 'line', value: 1 }], ['editorScroll', { to: 'up', by: 'line', value: 1 }]]);
    await new Promise((r) => setTimeout(r, 0));
    const html = v.panels.at(-1)!.html;
    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/script-src 'nonce-[^']+'/);
    expect(html).not.toContain('unsafe-inline');
    expect(html.match(/<\/script>/g)).toHaveLength(2); // the data block's and break.js's, nothing from the code
    expect(html).toContain('\\u003c/script>');
    const json = /<script type="application\/json" id="break-data">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(JSON.parse(json).scene).toBe('breathe');
  });

  it('opens over the code in its group, one tab at a time; "closed" disposes it and gives the keyboard back to the code', async () => {
    const ed = editor(['x', 'y', 'z']);
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = ed;
    const panel = new BreakPanel({ path: 'ext' } as never, () => undefined);
    v.shown.length = 0; v.posted.length = 0;
    await panel.show('sand');
    const first = v.panels.at(-1)!;
    // It loads behind the code (the code tab comes back to the front), then comes forward when its first frame is
    // drawn, and only then starts moving.
    expect(first.column).toEqual({ viewColumn: 1, preserveFocus: true });
    expect(first.opts).toMatchObject({ retainContextWhenHidden: true });
    expect(v.shown).toEqual([ed.document]);
    expect(v.posted).toEqual([]);
    first.onMsg({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    expect(v.revealed.at(-1)).toEqual([1, false]);
    expect(v.posted).toEqual([{ type: 'go' }]);
    await panel.show('swarm');
    expect(first.disposed).toBe(true);
    const second = v.panels.at(-1)!;
    expect(panel.open).toBe(true);
    second.onMsg({ type: 'closed' });
    // The code comes back first, then the tab goes.
    expect(v.shown.at(-1)).toBe(ed.document);
    expect(second.disposed).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(second.disposed).toBe(true);
    expect(panel.open).toBe(false);
    expect(v.shown.at(-1)).toBe(ed.document);
    second.onMsg('junk'); // odd messages are ignored
  });
});
