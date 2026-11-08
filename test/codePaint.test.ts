import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bracketLevels, customRules, fontBits, scopeStyle, selectorScore, semanticContext, semanticRules, semanticStyle, themeBlocks } from '../src/shared/codePaint';
import { paintCode } from '../src/ui/textmatePaint';

describe('editor colours: theme rules', () => {
  const rules = [
    { scope: 'keyword', settings: { foreground: '#111111' } },
    { scope: ['keyword.control', 'storage.type'], settings: { foreground: '#222222', fontStyle: 'italic' } },
    { scope: 'source.cpp entity.name.function', settings: { foreground: '#333333' } },
  ];

  it('the most specific scope wins; parent selectors match on their last part', () => {
    expect(scopeStyle(rules, 'keyword.operator')).toEqual({ foreground: '#111111', fontStyle: undefined });
    expect(scopeStyle(rules, 'keyword.control.flow')).toEqual({ foreground: '#222222', fontStyle: 'italic' });
    expect(scopeStyle(rules, 'entity.name.function.cpp')).toEqual({ foreground: '#333333', fontStyle: undefined });
    expect(scopeStyle(rules, 'string')).toBeNull();
  });

  it('customizations: groups, TextMate rules, and blocks for this theme only (wildcards too)', () => {
    const custom = { comments: '#00ff00', '[Dark Modern]': { textMateRules: [{ scope: 'string', settings: { foreground: '#ff0000' } }] }, '[Light*]': { numbers: '#0000ff' }, '[*Dark*]': { keywords: { foreground: '#abcdef' } } };
    expect(themeBlocks(custom, ['Dark Modern'])).toHaveLength(3);
    const r = customRules(custom, ['Default Dark Modern', 'Dark Modern']);
    expect(scopeStyle(r, 'comment.line')?.foreground).toBe('#00ff00');
    expect(scopeStyle(r, 'string.quoted')?.foreground).toBe('#ff0000');
    expect(scopeStyle(r, 'storage.type')?.foreground).toBe('#abcdef');
    expect(scopeStyle(r, 'constant.numeric')).toBeNull();
    expect(customRules(null, ['x'])).toEqual([]);
  });
});

describe('editor colours: semantic tokens', () => {
  const tm = [{ scope: 'entity.name.function', settings: { foreground: '#dcdcaa' } }, { scope: 'variable.other.readwrite', settings: { foreground: '#9cdcfe' } }, { scope: 'support.function', settings: { foreground: '#ffffff' } }];

  it('selector scores: type, modifiers, language', () => {
    expect(selectorScore('*', 'function', [], 'cpp')).toBe(0);
    expect(selectorScore('function', 'function', [], 'cpp')).toBe(100);
    expect(selectorScore('function.static', 'function', ['static'], 'cpp')).toBe(200);
    expect(selectorScore('function.static', 'function', [], 'cpp')).toBe(-1);
    expect(selectorScore('*.readonly:cpp', 'variable', ['readonly'], 'cpp')).toBe(110);
    expect(selectorScore('*.readonly:python', 'variable', ['readonly'], 'cpp')).toBe(-1);
  });

  it('the theme rule wins; otherwise the default TextMate scopes; nothing = keep the TextMate colour', () => {
    const ctx = semanticContext(semanticRules({ 'variable.readonly': '#4fc1ff', 'function.declaration': { fontStyle: 'bold' }, parameter: { foreground: '#888888', italic: true } }), {}, tm);
    expect(semanticStyle(ctx, 'variable', ['readonly'], 'cpp')).toEqual({ foreground: '#4fc1ff', fontStyle: undefined });
    expect(semanticStyle(ctx, 'variable', [], 'cpp')).toEqual({ foreground: '#9cdcfe', fontStyle: undefined });
    expect(semanticStyle(ctx, 'function', ['declaration'], 'cpp')).toEqual({ foreground: '#dcdcaa', fontStyle: 'bold' });
    expect(semanticStyle(ctx, 'function', ['defaultLibrary'], 'cpp')?.foreground).toBe('#ffffff');
    expect(semanticStyle(ctx, 'parameter', [], 'cpp')).toEqual({ foreground: '#888888', fontStyle: 'italic' });
    expect(semanticStyle(ctx, 'label', [], 'cpp')).toBeNull();
  });

  it('scopes an extension contributes for its language are probed', () => {
    const ctx = semanticContext([], { 'function:cpp': ['support.function'] }, tm);
    expect(semanticStyle(ctx, 'function', [], 'cpp')?.foreground).toBe('#ffffff');
    expect(semanticStyle(ctx, 'function', [], 'python')?.foreground).toBe('#dcdcaa');
  });
});

describe('editor colours: bracket pairs', () => {
  const pairs = [['(', ')'], ['[', ']'], ['{', '}']] as const;
  const at = (s: string) => [...s].map((ch, col) => ({ line: 0, col, ch })).filter((b) => '()[]{}'.includes(b.ch));

  it('levels by depth across all kinds; a stray closer is unexpected (-1)', () => {
    const m = bracketLevels(at('{([])}) ]'), pairs, false);
    expect([...m.values()]).toEqual([0, 1, 2, 2, 1, 0, -1, -1]);
  });

  it('independent pools: one depth per bracket kind', () => {
    const m = bracketLevels(at('{(())}'), pairs, true);
    expect([...m.values()]).toEqual([0, 0, 1, 1, 0, 0]);
  });

  it('font style bits', () => {
    expect(fontBits('italic bold')).toBe(3);
    expect(fontBits('underline strikethrough')).toBe(12);
    expect(fontBits('')).toBe(0);
  });
});

describe('editor colours: the real grammar engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-'));
  const file = join(dir, 'mini.tmLanguage.json');
  writeFileSync(file, JSON.stringify({
    scopeName: 'source.mini',
    patterns: [
      { match: '//.*$', name: 'comment.line.mini' },
      { begin: '"', end: '"', name: 'string.quoted.mini' },
      { match: '\\b(if|return)\\b', name: 'keyword.control.mini' },
      { match: '\\b\\d+\\b', name: 'constant.numeric.mini' },
    ],
  }));
  const wasm = resolve(__dirname, '../node_modules/vscode-oniguruma/release/onig.wasm');
  const rules = [{ scope: 'keyword.control', settings: { foreground: '#C586C0' } }, { scope: 'comment', settings: { foreground: '#6A9955', fontStyle: 'italic' } }, { scope: 'string', settings: { foreground: '#CE9178' } }];
  const expand = (p: { palette: string[]; runs: number[][] }, row: number) => {
    const out: string[] = [];
    const r = p.runs[row];
    for (let k = 0; k < r.length; k += 3) for (let n = 0; n < r[k]; n++) out.push(`${p.palette[r[k + 1]]}${r[k + 2] ? `/${r[k + 2]}` : ''}`);
    return out;
  };

  it('colours each character as the theme says; brackets get levels unless in a string or comment; semantic styles win', async () => {
    const p = (await paintCode({
      wasm, grammars: [{ scopeName: 'source.mini', file, language: 'mini' }], scopeName: 'source.mini', rules,
      lines: ['{ (', 'if (x) return 1; // ) c', '"(" ) }'], first: 1,
      semantic: [{ line: 1, col: 4, len: 1, style: { foreground: '#4FC1FF' } }],
      brackets: { pairs: [['(', ')'], ['{', '}']], independent: false },
    }))!;
    expect(p.runs).toHaveLength(2); // only the visible lines
    const row = expand(p, 0);
    expect(row.slice(0, 2)).toEqual(['#C586C0', '#C586C0']); // if
    expect(row[3]).toBe('b2'); // ( inside "{ (" from the hidden line
    expect(row[4]).toBe('#4FC1FF'); // x: semantic
    expect(row[5]).toBe('b2');
    expect(row[7]).toBe('#C586C0');
    expect(row.slice(17)).toEqual(Array(6).fill('#6A9955/1')); // the comment, italic; its ) is not a bracket
    const last = expand(p, 1);
    expect(last.slice(0, 3)).toEqual(['#CE9178', '#CE9178', '#CE9178']); // "(" is a string
    expect(last[4]).toBe('b1');
    expect(last[6]).toBe('b0');
    expect(last[3]).toBe('fg'); // a space in the default colour
  });

  it('out of time on the lines above: the visible lines are still coloured, starting fresh', async () => {
    const p = (await paintCode({ wasm, grammars: [{ scopeName: 'source.mini', file, language: 'mini' }], scopeName: 'source.mini', rules, lines: ['"open', '"open', 'if 1'], first: 2, semantic: null, brackets: null, budgetMs: -1 }))!;
    expect(expand(p, 0).slice(0, 2)).toEqual(['#C586C0', '#C586C0']);
  });

  it('no grammar for the scope: null', async () => {
    expect(await paintCode({ wasm, grammars: [], scopeName: 'source.none', rules, lines: ['x'], first: 0, semantic: null, brackets: null })).toBeNull();
  });
});
