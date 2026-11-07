import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const v = vi.hoisted(() => ({
  groups: 1,
  created: [] as { column: unknown; preserveFocus: boolean }[],
  panel: null as null | Record<string, unknown>,
  posted: [] as unknown[],
  commands: [] as unknown[][],
  onMessage: (_: unknown) => {},
  onDispose: () => {},
  clipboard: [] as string[],
}));

vi.mock('vscode', () => {
  const makePanel = () => ({
    title: '',
    visible: true,
    iconPath: undefined,
    webview: {
      html: '',
      options: {},
      cspSource: 'csp',
      asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: (f: (m: unknown) => void) => void (v.onMessage = f),
      postMessage: async (m: unknown) => void v.posted.push(m),
    },
    onDidChangeViewState: () => {},
    onDidDispose: (f: () => void) => void (v.onDispose = f),
    reveal: vi.fn(),
    dispose: vi.fn(),
  });
  return {
    ViewColumn: { Beside: -2 },
    Uri: { joinPath: (...p: unknown[]) => p.join('/') },
    env: { clipboard: { writeText: async (t: string) => void v.clipboard.push(t) } },
    commands: { executeCommand: async (...a: unknown[]) => void v.commands.push(a) },
    window: {
      get tabGroups() { return { all: Array.from({ length: v.groups }) }; },
      createWebviewPanel: (_t: string, _n: string, show: { viewColumn: unknown; preserveFocus: boolean }) => {
        v.created.push({ column: show.viewColumn, preserveFocus: show.preserveFocus });
        v.panel = makePanel();
        return v.panel;
      },
    },
  };
});

import { StatementPanels } from '../src/ui/statementPanel';
import { TestPanel } from '../src/ui/testPanel';

describe('TestPanel', () => {
  let view: ReturnType<typeof makeView>;
  const makeView = () => ({ head: { title: 'P', running: false } as never, key: 'problem:1' as string | null, cases: [{ id: 'a', source: 'custom' as const, input: 'i', expected: 'e' }], runs: new Map() });
  const runner = {
    testsView: () => view,
    fetchLimits: vi.fn(),
    run: vi.fn(async () => null),
    stop: vi.fn(),
    addCase: vi.fn(async () => {}),
    editCase: vi.fn(async () => {}),
    removeCase: vi.fn(async () => {}),
    reorderCases: vi.fn(async () => {}),
    setExpected: vi.fn(async () => {}),
    textOf: vi.fn(() => 'whole text'),
    failureText: vi.fn(() => null),
    dismissSampleTip: vi.fn(async () => {}),
  };
  const tests = { loadTestcases: vi.fn(async () => {}), loadSampleCases: vi.fn(async () => {}) };
  let shared: number | undefined;
  const compare = vi.fn(async () => {});
  const openStatement = vi.fn(async () => {});
  const make = () =>
    new TestPanel('ext' as never, { runner: () => runner as never, tests: () => tests as never, sharedColumn: () => shared, started: Promise.resolve(), changed: () => {}, compare, openStatement, webviewError: vi.fn(), log: () => {} });
  const send = async (m: unknown) => {
    v.onMessage(m);
    await new Promise((done) => setImmediate(done));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(v, { groups: 1, created: [], panel: null, posted: [], commands: [], clipboard: [] });
    shared = undefined;
    view = makeView();
  });

  it('one group: opens beside the code without taking focus, and sizes the split it made', async () => {
    await make().open();
    expect(v.created).toEqual([{ column: -2, preserveFocus: true }]);
    expect(v.commands).toHaveLength(1);
    expect(v.commands[0][0]).toBe('vscode.setEditorLayout');
    const layout = v.commands[0][1] as { groups: { size: number }[] };
    expect(layout.groups[1].size).toBeCloseTo(1 / 3);
  });

  it('a layout the user already has keeps its sizes', async () => {
    v.groups = 2;
    await make().open();
    expect(v.created[0].column).toBe(-2);
    expect(v.commands).toEqual([]);
  });

  it('shares the statement\'s group when that is open', async () => {
    shared = 2;
    await make().open();
    expect(v.created[0].column).toBe(2);
    expect(v.commands).toEqual([]);
  });

  it('a second open shows the same tab, focus staying in the editor', async () => {
    const p = make();
    await p.open();
    await p.open();
    expect(v.created).toHaveLength(1);
    expect((v.panel as { reveal: ReturnType<typeof vi.fn> }).reveal).toHaveBeenCalledWith(undefined, true);
  });

  it('the page has a strict CSP and no inline script', async () => {
    await make().open();
    const html = (v.panel as { webview: { html: string } }).webview.html;
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-");
    expect(html).not.toContain('unsafe');
  });

  it('sends nothing before the page is ready, everything on ready, then only changes', async () => {
    const p = make();
    await p.open();
    p.update();
    expect(v.posted).toEqual([]);
    await send({ type: 'ready' });
    expect(v.posted).toHaveLength(1);
    expect(v.posted[0]).toMatchObject({ type: 'state', fresh: true, order: ['a'], cases: [{ id: 'a' }] });
    expect((v.panel as { title: string }).title).toBe('Tests: P');
    expect(runner.fetchLimits).toHaveBeenCalledTimes(1);
    p.update();
    expect(v.posted).toHaveLength(1);
    view.head = { title: 'P', running: true } as never;
    p.update();
    expect(v.posted).toHaveLength(2);
    expect(v.posted[1]).toMatchObject({ fresh: false, cases: [], runs: {} });
    // The page reloaded (language change): it gets everything again.
    await send({ type: 'ready' });
    expect(v.posted[2]).toMatchObject({ fresh: true, cases: [{ id: 'a' }] });
  });

  it('the page\'s Close button closes the tab', async () => {
    await make().open();
    await send({ type: 'close' });
    expect((v.panel as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalled();
  });

  it('Open tests: opens, a second press closes, and a tab hidden behind another comes to the front', async () => {
    const p = make();
    await p.toggle();
    expect(v.created).toHaveLength(1);
    expect(p.showing).toBe(true);
    (v.panel as { visible: boolean }).visible = false;
    await p.toggle();
    expect((v.panel as { reveal: ReturnType<typeof vi.fn> }).reveal).toHaveBeenCalled();
    (v.panel as { visible: boolean }).visible = true;
    await p.toggle();
    expect((v.panel as { dispose: ReturnType<typeof vi.fn> }).dispose).toHaveBeenCalled();
  });

  it('a closed tab opens anew', async () => {
    const p = make();
    await p.open();
    v.onDispose();
    p.update();
    await p.open();
    expect(v.created).toHaveLength(2);
  });

  it('passes each action on; copy takes the host\'s whole text', async () => {
    await make().open();
    await send({ type: 'run' });
    expect(runner.run).toHaveBeenLastCalledWith(undefined);
    await send({ type: 'run', caseId: 'a' });
    expect(runner.run).toHaveBeenLastCalledWith(['a']);
    await send({ type: 'stop' });
    expect(runner.stop).toHaveBeenCalled();
    await send({ type: 'add' });
    expect(runner.addCase).toHaveBeenCalled();
    await send({ type: 'edit', caseId: 'a', expected: 'x' });
    expect(runner.editCase).toHaveBeenCalledWith('a', { expected: 'x' });
    await send({ type: 'remove', caseId: 'a' });
    expect(runner.removeCase).toHaveBeenCalledWith('a');
    await send({ type: 'reorder', ids: ['a'] });
    expect(runner.reorderCases).toHaveBeenCalledWith(['a']);
    await send({ type: 'setExpected', caseId: 'a' });
    expect(runner.setExpected).toHaveBeenCalledWith('a');
    await send({ type: 'copy', caseId: 'a', what: 'input' });
    expect(v.clipboard).toEqual(['whole text']);
    await send({ type: 'compare', caseId: 'a' });
    expect(compare).toHaveBeenCalledWith('a');
    await send({ type: 'openStatement' });
    expect(openStatement).toHaveBeenCalled();
    await send({ type: 'dismissTip' });
    expect(runner.dismissSampleTip).toHaveBeenCalled();
    await send({ type: 'loadTestcases' });
    expect(tests.loadTestcases).toHaveBeenCalledWith(false);
    await send({ type: 'loadSamples' });
    expect(tests.loadSampleCases).toHaveBeenCalled();
  });
});

describe('the split stays ours', () => {
  // VS Code locks a new group that opens with one of these tabs, so a file clicked in the Explorer goes to the code's group.
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const locked = pkg.contributes.configurationDefaults['workbench.editor.autoLockGroups'];

  it('both tabs lock the group they make, by their real view types', () => {
    expect(locked[`mainThreadWebview-${TestPanel.viewType}`]).toBe(true);
    expect(locked[`mainThreadWebview-${StatementPanels.viewType}`]).toBe(true);
  });

  // Our default replaces VS Code's whole list (seen in 1.145), so a terminal in the editor would lose its lock.
  it("keeps VS Code's own entries", () => {
    for (const id of ['terminalEditor', 'mainThreadWebview-simpleBrowser.view', 'mainThreadWebview-browserPreview', 'workbench.editor.processExplorer']) expect(locked[id]).toBe(true);
  });
});
