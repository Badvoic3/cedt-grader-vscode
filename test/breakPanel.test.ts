import { describe, expect, it, vi } from 'vitest';

const v = vi.hoisted(() => ({
  panels: [] as { html: string; disposed: boolean; onMsg: (m: unknown) => void; opts: unknown; column: unknown }[],
  shown: [] as unknown[],
  settings: new Map<string, unknown>([['editor.fontSize', 13], ['editor.lineHeight', 0], ['editor.fontFamily', 'Menlo'], ['workbench.colorTheme', 'Nope']]),
}));

vi.mock('vscode', () => ({
  ViewColumn: { Active: -1, One: 1 },
  Uri: { joinPath: (_: unknown, ...p: string[]) => ({ path: p.join('/'), toString: () => p.join('/') }) },
  extensions: { all: [] },
  workspace: { getConfiguration: (section: string) => ({ get: (k: string) => v.settings.get(`${section}.${k}`) }) },
  window: {
    activeTextEditor: undefined as unknown,
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
          set html(h: string) { p.html = h; },
          get html() { return p.html; },
        },
        reveal: () => undefined,
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
  visibleRanges: [{ start: { line: 1 }, end: { line: 2 } }],
  document: { lineCount: lines.length, lineAt: (i: number) => ({ text: lines[i] }) },
});

describe('break tab', () => {
  it('sends the visible lines, the editor font and the texts; the code can never close the data block', () => {
    const d = breakData('sand', editor(['skip', 'int main() { // </script><script>alert(1)', 'return 0;', 'below']) as never, NO_COLORS);
    expect(d.lines).toEqual(['int main() { // </script><script>alert(1)', 'return 0;']);
    expect(d.font).toEqual({ family: 'Menlo', size: 13, lineHeight: Math.round(13 * (process.platform === 'darwin' ? 1.5 : 1.35)) });
    expect(d.texts.backBtn).toBe('Back to code');
    (vscode.window as { activeTextEditor: unknown }).activeTextEditor = editor(['a', '</script><script>alert(1)</script>', 'c']);
    new BreakPanel({ path: 'ext' } as never, () => undefined).show('breathe');
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
    panel.show('sand');
    const first = v.panels.at(-1)!;
    expect(first.column).toEqual({ viewColumn: 1, preserveFocus: false });
    panel.show('swarm');
    expect(first.disposed).toBe(true);
    const second = v.panels.at(-1)!;
    expect(panel.open).toBe(true);
    second.onMsg({ type: 'closed' });
    await Promise.resolve();
    expect(second.disposed).toBe(true);
    expect(panel.open).toBe(false);
    expect(v.shown.at(-1)).toBe(ed.document);
    second.onMsg('junk'); // odd messages are ignored
  });
});
