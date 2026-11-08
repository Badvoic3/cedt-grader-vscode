import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const v = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  extensions: [] as unknown[],
  commands: new Map<string, unknown>(),
}));

vi.mock('vscode', () => ({
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  extensions: { get all() { return v.extensions; } },
  window: { activeColorTheme: { kind: 2 } },
  commands: { executeCommand: async (name: string) => v.commands.get(name) },
  workspace: { getConfiguration: (section: string) => ({ get: (k: string, d?: unknown) => v.settings.get(`${section}.${k}`) ?? d }) },
}));

import { activeTheme, editorPaint } from '../src/ui/codePaint';

const wasm = resolve(__dirname, '../node_modules/vscode-oniguruma/release/onig.wasm');
const dir = mkdtempSync(join(tmpdir(), 'paint-'));
mkdirSync(join(dir, 'themes'));
writeFileSync(join(dir, 'themes/base.json'), `{ // a base theme
  "semanticHighlighting": true,
  "colors": { "editor.foreground": "#cccccc" },
  "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#111111" } }],
}`);
writeFileSync(join(dir, 'themes/mine.json'), JSON.stringify({ include: './base.json', tokenColors: [{ scope: 'string', settings: { foreground: '#222222' } }], semanticTokenColors: { variable: '#333333' } }));
const grammar = (scopeName: string, keyword: string) => JSON.stringify({ scopeName, patterns: [{ match: `\\b${keyword}\\b`, name: 'keyword.mini' }, { begin: '"', end: '"', name: 'string.mini' }, { match: '\\bv\\b', name: 'variable.mini' }] });
writeFileSync(join(dir, 'first.tmLanguage.json'), grammar('source.first', 'nope'));
writeFileSync(join(dir, 'mini.tmLanguage.json'), grammar('source.mini', 'if'));
writeFileSync(join(dir, 'lang.json'), '{ "colorizedBracketPairs": [["<", ">"]], "brackets": [["(", ")"]] }');
const extension = {
  extensionPath: dir,
  packageJSON: {
    contributes: {
      themes: [{ id: 'Mine', label: 'Mine', path: './themes/mine.json' }],
      grammars: [{ language: 'mini', scopeName: 'source.first', path: './first.tmLanguage.json' }, { language: 'mini', scopeName: 'source.mini', path: './mini.tmLanguage.json' }],
      languages: [{ id: 'mini', configuration: './lang.json' }],
    },
  },
};

const editor = (lines: string[]) => ({
  document: { languageId: 'mini', uri: { path: '/x' }, lineCount: lines.length, lineAt: (i: number) => ({ text: lines[i] }) },
}) as never;
const colorsOf = (p: { palette: string[]; runs: number[][] }, row: number) => {
  const out: string[] = [];
  const r = p.runs[row];
  for (let k = 0; k < r.length; k += 3) for (let n = 0; n < r[k]; n++) out.push(p.palette[r[k + 1]]);
  return out;
};

beforeEach(() => {
  v.settings.clear();
  v.commands.clear();
  v.extensions = [extension];
  v.settings.set('workbench.colorTheme', 'Mine');
});

describe('the editor\'s colours for the break tab', () => {
  it('finds the active theme through its include', () => {
    const t = activeTheme()!;
    expect(t.rules.map((r) => r.scope)).toEqual(['keyword', 'string']); // the base first
    expect(t.colors['editor.foreground']).toBe('#cccccc');
    expect(t.semanticHighlighting).toBe(true);
    v.settings.set('workbench.colorTheme', 'Missing');
    expect(activeTheme()).toBeNull();
  });

  it('the language\'s last grammar counts, its colorized pairs are the brackets, customizations apply', async () => {
    v.settings.set('editor.tokenColorCustomizations', { strings: '#ABCDEF' });
    const p = (await editorPaint(editor(['if "s" < (', '> )']), 0, 1, wasm))!;
    const row = colorsOf(p, 0);
    expect(row.slice(0, 2)).toEqual(['#111111', '#111111']); // `if` is a keyword only in the last grammar
    expect(row[3]).toBe('#ABCDEF');
    expect(row[7]).toBe('b0'); // <
    expect(row[9]).toBe('fg'); // ( is not a colorized pair here
    expect(colorsOf(p, 1)[0]).toBe('b0');
  });

  it('bracket colours can be off', async () => {
    v.settings.set('editor.bracketPairColorization.enabled', false);
    const p = (await editorPaint(editor(['<>']), 0, 0, wasm))!;
    expect(colorsOf(p, 0)).toEqual(['fg', 'fg']);
  });

  it('semantic tokens follow the theme: on when it says so, off when the setting says so; only the asked lines', async () => {
    v.commands.set('vscode.provideDocumentSemanticTokensLegend', { tokenTypes: ['variable'], tokenModifiers: [] });
    v.commands.set('vscode.provideDocumentSemanticTokens', { data: new Uint32Array([0, 0, 1, 0, 0, 1, 2, 1, 0, 0]) });
    const on = (await editorPaint(editor(['v', 'a v']), 1, 1, wasm))!;
    expect(on.runs).toHaveLength(1);
    expect(colorsOf(on, 0)).toEqual(['fg', 'fg', '#333333']);
    v.settings.set('editor.semanticHighlighting.enabled', false);
    const off = (await editorPaint(editor(['v', 'a v']), 1, 1, wasm))!;
    expect(colorsOf(off, 0)).toEqual(['fg', 'fg', 'fg']);
  });

  it('no theme file or no grammar: null, and the tab uses its own lexer', async () => {
    v.settings.set('workbench.colorTheme', 'Missing');
    expect(await editorPaint(editor(['x']), 0, 0, wasm)).toBeNull();
    v.settings.set('workbench.colorTheme', 'Mine');
    const other = { document: { languageId: 'other', lineCount: 1, lineAt: () => ({ text: 'x' }) } } as never;
    expect(await editorPaint(other, 0, 0, wasm)).toBeNull();
  });
});
