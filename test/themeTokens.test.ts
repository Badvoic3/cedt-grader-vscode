import { describe, expect, it } from 'vitest';
import { collectTheme, colorFor, NO_COLORS, parseJsonc, tokenColors, type ThemeJson } from '../src/shared/themeTokens';

describe('theme token colours', () => {
  it('reads theme JSON with comments, BOM, and trailing commas (without touching strings), and nothing that is not JSON', () => {
    const t = parseJsonc('\uFEFF{\n // a comment\n "colors": { "editor.foreground": "#ccc", }, /* more */ "tokenColors": [ { "scope": "x, ]", "settings": { "foreground": "#123" } }, ],\n "url": "http://not/a//comment" }');
    expect(t?.colors?.['editor.foreground']).toBe('#ccc');
    expect((t?.tokenColors as { scope: string }[])[0].scope).toBe('x, ]');
    expect((t as { url: string }).url).toBe('http://not/a//comment');
    expect(parseJsonc('not json')).toBeNull();
    expect(parseJsonc('42')).toBeNull();
  });

  it('follows include: the base theme first, the including theme wins, settings array works, and a loop stops', () => {
    const base: ThemeJson = { settings: [{ settings: { foreground: '#root', background: '#basebg' } }, { scope: 'string', settings: { foreground: '#b' } }] };
    const top: ThemeJson = { include: './base.json', tokenColors: [{ scope: 'string', settings: { foreground: '#t' } }] };
    const theme = collectTheme(top, (inc) => (inc === './base.json' ? base : null));
    expect(theme.colors['editor.foreground']).toBe('#root');
    expect(theme.colors['editor.background']).toBe('#basebg');
    expect(colorFor(theme.rules, 'string.quoted.double')).toBe('#t');
    const loop: ThemeJson = { include: 'self' };
    expect(collectTheme(loop, () => loop).rules).toEqual([]);
  });

  it('the most specific scope wins; a scope matches its dotted children only', () => {
    const rules = [
      { scope: 'keyword', settings: { foreground: '#1' } },
      { scope: ['keyword.control', 'storage'], settings: { foreground: '#2' } },
      { scope: 'keyword.control.directive, meta.x', settings: { foreground: '#3' } },
      { scope: 'keywordish', settings: { foreground: '#bad' } },
      { scope: 'keyword.control', settings: {} },
    ];
    expect(colorFor(rules, 'keyword.control.flow')).toBe('#2');
    expect(colorFor(rules, 'keyword.control.directive')).toBe('#3');
    expect(colorFor(rules, 'keyword.other')).toBe('#1');
    expect(colorFor(rules, 'comment')).toBeNull();
    expect(tokenColors({ rules: [], colors: {} })).toEqual(NO_COLORS);
    expect(tokenColors({ rules: [], colors: { 'editor.background': '#000', 'editor.foreground': '#fff' } }).bg).toBe('#000');
  });
});
