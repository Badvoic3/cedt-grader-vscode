import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lookView, PLAIN_LOOK } from '../src/shared/look';

const on = { modernUI: true, frostedGlass: true, frostedGlassOpacity: 80, reduceTransparency: 'off' };

describe('panel look', () => {
  it('plain turns everything off, whatever VS Code says', () => {
    expect(lookView('plain', on)).toEqual(PLAIN_LOOK);
  });

  it('subtle is the default for anything else', () => {
    expect(lookView('subtle', on).on).toBe(true);
    expect(lookView(undefined, on).on).toBe(true);
    expect(lookView('glass', on).on).toBe(true);
  });

  it('frost follows VS Code: only when its own pop-ups are frosted', () => {
    expect(lookView('subtle', on).frost).toBe(true);
    expect(lookView('subtle', { ...on, modernUI: false }).frost).toBe(false);
    expect(lookView('subtle', { ...on, frostedGlass: false }).frost).toBe(false);
    expect(lookView('subtle', { ...on, reduceTransparency: 'on' }).frost).toBe(false);
    // "auto" follows the OS: the CSS media query decides.
    expect(lookView('subtle', { ...on, reduceTransparency: 'auto' }).frost).toBe(true);
    // A build without the settings has solid pop-ups.
    expect(lookView('subtle', { modernUI: undefined, frostedGlass: undefined, frostedGlassOpacity: undefined, reduceTransparency: undefined })).toEqual({ on: true, frost: false, frostOpacity: 80 });
  });

  it('opacity: clamped as VS Code does; odd values give the default', () => {
    const op = (frostedGlassOpacity: unknown) => lookView('subtle', { ...on, frostedGlassOpacity }).frostOpacity;
    expect(op(65)).toBe(65);
    expect(op(10)).toBe(50);
    expect(op(200)).toBe(100);
    expect(op('x')).toBe(80);
    expect(op(Number.NaN)).toBe(80);
  });
});

describe('panel look CSS', () => {
  const css = readFileSync(join(__dirname, '../webview/style.css'), 'utf8');
  const tests = readFileSync(join(__dirname, '../webview/tests.css'), 'utf8');

  it('blur only on menus and tooltips, behind every guard', () => {
    const rules = [...(css + tests).matchAll(/([^{}]+)\{[^{}]*backdrop-filter[^{}]*\}/g)].map((m) => m[1].trim());
    expect(rules).toHaveLength(2);
    for (const r of rules) expect(r).toMatch(/^body\.fx-frost:not\(\.vscode-high-contrast\) \.(menu|tooltip)$/);
    expect(css).toContain('@media (prefers-reduced-transparency: no-preference) and (forced-colors: none)');
  });

  it('both reduced-motion switches zero the timings and stop the celebration', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce) { :root { --t-fast: 0ms; --t-pop: 0ms; } }');
    expect(css).toContain('body.vscode-reduce-motion { --t-fast: 0ms; --t-pop: 0ms; }');
    expect(css).toContain('body.vscode-reduce-motion .fun-play *');
  });

  it('the score colours stay the theme\'s green, amber and red', () => {
    expect(css).toContain('.score-full { color: var(--ok); }');
    expect(css).toContain('.score-partial { color: var(--warn); }');
    expect(css).toContain('.score-zero { color: var(--bad); }');
    expect(css).toContain('--ok: var(--vscode-testing-iconPassed');
    expect(css).toContain('--bad: var(--vscode-testing-iconFailed');
    expect(css).toContain('--warn: var(--vscode-editorWarning-foreground');
  });
});
