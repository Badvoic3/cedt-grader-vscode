import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { revealPanelOnce } from '../src/flows/firstReveal';
import { KEYS } from '../src/shared/stateKeys';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe('where the panel lives', () => {
  // VS Code registers the first listing and skips the second; Cursor refuses `secondarySidebar` and takes `activitybar`.
  it('secondarySidebar comes first, or VS Code would use the Activity Bar', () => {
    expect(Object.keys(pkg.contributes.viewsContainers)).toEqual(['secondarySidebar', 'activitybar']);
  });

  it('both list the same single container', () => {
    const { secondarySidebar, activitybar } = pkg.contributes.viewsContainers;
    expect(secondarySidebar).toHaveLength(1);
    expect(secondarySidebar).toEqual(activitybar);
    expect(Object.keys(pkg.contributes.views)).toEqual([secondarySidebar[0].id]);
    expect(pkg.contributes.views[secondarySidebar[0].id]).toHaveLength(1);
  });

  // 1.104 and 1.105 throw on the key, which also costs other extensions their views.
  it('needs VS Code 1.106, where the key is final', () => {
    expect(pkg.engines.vscode).toBe('^1.106.0');
    expect(pkg.devDependencies['@types/vscode']).toBe('~1.106.0');
  });
});

describe('revealPanelOnce', () => {
  const flags = (seen = false) => {
    const m = new Map<string, unknown>(seen ? [[KEYS.panelRevealed, true]] : []);
    return { m, get: <T>(k: string, d: T) => (m.has(k) ? (m.get(k) as T) : d), update: async (k: string, v: unknown) => void m.set(k, v) };
  };

  it('shows the panel once, then gives the cursor back to the editor', async () => {
    const f = flags();
    const run = vi.fn(async (_: string) => undefined);
    await revealPanelOnce(f, false, run);
    await revealPanelOnce(f, false, run);
    expect(run.mock.calls.map((c) => c[0])).toEqual(['cedtGrader.panel.focus', 'workbench.action.focusActiveEditorGroup']);
  });

  it('a panel already on screen is left alone, and the flag is still set', async () => {
    const f = flags();
    const run = vi.fn(async (_: string) => undefined);
    await revealPanelOnce(f, true, run);
    expect(run).not.toHaveBeenCalled();
    expect(f.m.get(KEYS.panelRevealed)).toBe(true);
  });

  it('a failed reveal tries again next time', async () => {
    const f = flags();
    await expect(revealPanelOnce(f, false, async () => { throw new Error('no view'); })).rejects.toThrow('no view');
    expect(f.m.has(KEYS.panelRevealed)).toBe(false);
  });
});
