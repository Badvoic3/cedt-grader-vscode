/**
 * Activation doesn't wait for `controller.init()`, so the panel loads while the saved session is read.
 * The panel gets no state before that (no flash of the login form), and commands wait for it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ Uri: { joinPath: (...parts: unknown[]) => ({ path: parts.map(String).join('/') }) } }));
const { SidebarProvider } = await import('../src/ui/sidebarProvider');

type Provider = InstanceType<typeof SidebarProvider>;
const flush = () => new Promise((done) => setTimeout(done));

function setup() {
  let finish = () => {};
  const listeners: ((s: unknown) => void)[] = [];
  const state = { account: { status: 'logged-in' } };
  const controller = {
    isStarted: false,
    started: new Promise<void>((done) => (finish = done)),
    onState(l: (s: unknown) => void) {
      listeners.push(l);
      l(state);
      return { dispose() {} };
    },
    state: () => state,
    setPanelVisible: vi.fn(),
  };
  const posted: { type: string }[] = [];
  let receive: (m: unknown) => void = () => {};
  const view = {
    visible: true,
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
    webview: {
      options: {},
      html: '',
      cspSource: 'csp',
      asWebviewUri: (u: unknown) => u,
      postMessage: (m: { type: string }) => (posted.push(m), Promise.resolve(true)),
      onDidReceiveMessage: (l: (m: unknown) => void) => ((receive = l), { dispose() {} }),
    },
  };
  const sidebar = new SidebarProvider({} as never, controller as never) as Provider;
  sidebar.resolveWebviewView(view as never);
  return {
    posted,
    controller,
    send: (m: unknown) => receive(m),
    emit: () => listeners.forEach((l) => l(state)),
    start() {
      controller.isStarted = true;
      finish();
    },
  };
}

describe('panel before the saved session is read', () => {
  it('sends no state, even when the webview is ready', async () => {
    const t = setup();
    t.send({ type: 'ready' });
    t.emit();
    await flush();
    expect(t.posted).toEqual([]);
  });

  it('answers ready once it is read, and states flow from then on', async () => {
    const t = setup();
    t.send({ type: 'ready' });
    t.start();
    await flush();
    expect(t.posted.map((m) => m.type)).toEqual(['state']);
    t.emit();
    expect(t.posted).toHaveLength(2);
  });

  it('tells the controller the panel is visible right away (the controller applies it after init)', () => {
    expect(setup().controller.setPanelVisible).toHaveBeenCalledWith(true);
  });
});

describe('commands', () => {
  const source = readFileSync('src/extension.ts', 'utf8');

  it('only commands that need no session skip the wait', () => {
    const direct = [...source.matchAll(/vscode\.commands\.registerCommand\('cedtGrader\.(\w+)'/g)].map((m) => m[1]).sort();
    expect(direct).toEqual(['focus', 'openSettings', 'openWalkthrough', 'testCrashReport']);
  });

  it('checks that the file is still active before loading a root package', () => {
    const controller = readFileSync('src/controller.ts', 'utf8');
    const check = controller.indexOf('await this.folder.atRootPackage(');
    const load = controller.indexOf('await this.folder.load(', check);
    expect(check).toBeGreaterThan(-1);
    expect(controller.slice(check, load)).toContain('seq !== this.refreshSeq');
  });

  it('activation does not wait for init', () => {
    expect(source).not.toMatch(/await controller\.init\(\)/);
  });
});
