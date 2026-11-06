import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { revealPanelOnStart } from '../src/flows/panelReveal';

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

describe('revealPanelOnStart', () => {
  const run = () => vi.fn(async (_: string, __: { preserveFocus: boolean }) => undefined);

  it('shows the panel on every start and leaves the cursor where it is', async () => {
    const r = run();
    await revealPanelOnStart(true, false, r);
    await revealPanelOnStart(true, false, r);
    expect(r.mock.calls).toEqual([['cedtGrader.panel.focus', { preserveFocus: true }], ['cedtGrader.panel.focus', { preserveFocus: true }]]);
  });

  it('a panel already on screen is left alone', async () => {
    const r = run();
    await revealPanelOnStart(true, true, r);
    expect(r).not.toHaveBeenCalled();
  });

  it('the setting turns it off', async () => {
    const r = run();
    await revealPanelOnStart(false, false, r);
    expect(r).not.toHaveBeenCalled();
  });

  it('activates after startup, so a window with no source file shows the panel too', () => {
    expect(pkg.activationEvents).toContain('onStartupFinished');
    expect(JSON.stringify(pkg.contributes.configuration)).toContain('cedtGrader.panel.openOnStartup');
  });
});
