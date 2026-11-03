/**
 * Statement tabs follow the active file's problem (StatementPanels.follow):
 * the following tab switches in place, a tab already showing the problem is
 * revealed instead, no problem closes the tab; view state stays per problem.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Statement, StatementStore } from '../src/data/statementStore';

vi.mock('vscode', () => ({ Uri: { joinPath: (...parts: unknown[]) => ({ path: parts.map(String).join('/') }) } }));
const { StatementPanels } = await import('../src/ui/statementPanel');

type Msg = Record<string, unknown>;
function fakePanel() {
  const recv: ((m: Msg) => void)[] = [];
  const disposed: (() => void)[] = [];
  const viewState: ((e: { webviewPanel: { active: boolean } }) => void)[] = [];
  const panel = {
    title: '',
    visible: true,
    active: false,
    gone: false,
    posted: [] as Msg[],
    iconPath: undefined as unknown,
    reveal: vi.fn(),
    webview: {
      options: {},
      html: '',
      cspSource: 'csp',
      asWebviewUri: (u: unknown) => u,
      postMessage: (m: Msg) => (panel.posted.push(m), Promise.resolve(true)),
      onDidReceiveMessage: (cb: (m: Msg) => void) => recv.push(cb),
    },
    onDidDispose: (cb: () => void) => disposed.push(cb),
    onDidChangeViewState: (cb: (e: { webviewPanel: { active: boolean } }) => void) => viewState.push(cb),
    dispose() {
      panel.gone = true;
      disposed.forEach((f) => f());
    },
    send: (m: Msg) => recv.forEach((f) => f(m)),
    activate: () => viewState.forEach((f) => f({ webviewPanel: { active: true } })),
  };
  return panel;
}

function setup() {
  const gets: number[] = [];
  const store = { get: async (id: number): Promise<Statement> => (gets.push(id), { kind: 'pdf', bytes: new Uint8Array([id]) }) } as unknown as StatementStore;
  const saved: Record<string, unknown> = {};
  const memento = { get: <T>(k: string, f: T) => (saved[k] as T) ?? f, update: (k: string, v: unknown) => ((saved[k] = v), Promise.resolve()) };
  const panels = new StatementPanels({ path: 'ext' } as never, store, { memento, beside: () => true, openInBrowser: () => {}, onError: () => 'x' });
  const revive = (id: number) => {
    const p = fakePanel();
    panels.revive(p as never, { problemId: id, name: `P${id}` });
    return p;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { panels, revive, gets, saved, flush };
}

describe('statement tab follows the active file', () => {
  it('no open tab: nothing opens', () => {
    const { panels, gets } = setup();
    panels.follow({ problemId: 2, name: 'P2' });
    panels.follow(null);
    expect(gets).toEqual([]);
  });

  it('switches the open tab in place (title, content), and opening that problem reuses it', async () => {
    const { panels, revive, gets, flush } = setup();
    const a = revive(1);
    panels.follow({ problemId: 2, name: 'P2' });
    await flush();
    expect(a.title).toContain('P2');
    expect(gets).toEqual([2]);
    expect(a.posted.map((m) => [m.type, m.problemId])).toEqual([['loading', 2], ['pdf', 2]]);
    await panels.open(2, 'P2');
    expect(a.reveal).toHaveBeenCalled(); // the same tab, no new one
    a.send({ type: 'refresh' });
    await flush();
    expect(gets).toEqual([2, 2]); // the tab now belongs to problem 2
  });

  it('a tab already showing the problem is revealed (without focus); the other one stays', async () => {
    const { panels, revive } = setup();
    const a = revive(1);
    const b = revive(2);
    b.visible = false;
    a.activate(); // the user looked at A last: A follows
    panels.follow({ problemId: 2, name: 'P2' });
    expect(b.reveal).toHaveBeenCalledWith(undefined, true);
    expect(a.posted).toEqual([]); // A keeps its problem
  });

  it('a source file with no problem closes the following tab', () => {
    const { panels, revive } = setup();
    const a = revive(1);
    const b = revive(2);
    b.activate();
    panels.follow(null);
    expect(b.gone).toBe(true);
    expect(a.gone).toBe(false);
  });

  it('view state is stored for the problem the webview names (a late save after a switch)', async () => {
    const { panels, revive, saved, flush } = setup();
    const a = revive(1);
    panels.follow({ problemId: 2, name: 'P2' });
    await flush();
    const view = { page: 3, scale: '1.5', scrollTop: 10, scrollLeft: 0 };
    a.send({ type: 'viewState', state: view, problemId: 1 });
    expect(Object.keys(saved['cedtGrader.statementView'] as object)).toEqual(['1']);
  });
});
