/**
 * The real GraderController: what reaches the secret store and the network
 * when a login names another server. The rule is that a blocked address
 * changes nothing, and a password never goes to an address that wasn't checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const v = vi.hoisted(() => {
  const settings = new Map<string, unknown>();
  const listeners: ((e: { affectsConfiguration: (s: string) => boolean }) => void)[] = [];
  const event = () => ({ dispose() {} });
  return { settings, listeners, event, showWarningMessage: vi.fn(async (..._: unknown[]): Promise<string | undefined> => undefined), openExternal: vi.fn(async () => true) };
});

vi.mock('vscode', () => {
  const channel = { appendLine() {}, dispose() {}, show() {} };
  const configuration = () => ({
    get: (k: string, d?: unknown) => v.settings.get(k) ?? d,
    inspect: (k: string) => ({ globalValue: v.settings.get(k) }),
    update: async (k: string, value: unknown, target: number) => {
      if (target !== 1) throw new Error('settings must be written to user scope');
      if (value === undefined) v.settings.delete(k);
      else v.settings.set(k, value);
      for (const l of v.listeners) l({ affectsConfiguration: () => true });
    },
  });
  const uri = (s: string) => ({ toString: () => s, fsPath: s, path: s, scheme: 'file' });
  return {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    EventEmitter: class { event = v.event; fire() {} dispose() {} },
    Uri: { parse: uri, file: uri, joinPath: (_: unknown, ...p: string[]) => uri(p.join('/')) },
    env: { language: 'en', openExternal: v.openExternal },
    commands: { executeCommand: async () => undefined, registerCommand: () => ({ dispose() {} }) },
    extensions: { getExtension: () => undefined, onDidChange: v.event },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: () => channel,
      onDidChangeActiveTextEditor: v.event,
      showWarningMessage: v.showWarningMessage,
      showErrorMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      tabGroups: { all: [], onDidChangeTabs: v.event },
    },
    workspace: {
      workspaceFolders: undefined,
      textDocuments: [],
      getConfiguration: configuration,
      onDidChangeConfiguration: (l: (typeof v.listeners)[number]) => (v.listeners.push(l), { dispose() {} }),
      onDidRenameFiles: v.event,
      onDidDeleteFiles: v.event,
      onDidSaveTextDocument: v.event,
      onDidChangeWorkspaceFolders: v.event,
      createFileSystemWatcher: () => ({ onDidCreate: v.event, onDidDelete: v.event, onDidChange: v.event, dispose() {} }),
      asRelativePath: (p: unknown) => String(p),
      fs: { stat: async () => { throw new Error('none'); }, readFile: async () => { throw new Error('none'); } },
    },
  };
});

import type * as vscode from 'vscode';
import { GraderController } from '../src/controller';
import type { CrashReporter } from '../src/crashReporter';
import { DEFAULT_BASE_URL } from '../src/shared/constants';
import { KEYS } from '../src/shared/stateKeys';
import { FakeGrader } from './fakeServer';

const OTHER = 'https://other.example';
const memento = () => {
  const m = new Map<string, unknown>();
  return { get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d), update: async (k: string, x: unknown) => void (x === undefined ? m.delete(k) : m.set(k, x)), keys: () => [...m.keys()] };
};

function start() {
  const secrets = new Map<string, string>();
  const globalState = memento();
  const ctx = {
    subscriptions: [],
    extensionUri: { fsPath: '/ext', path: '/ext', scheme: 'file' },
    globalStorageUri: { fsPath: '/storage', path: '/storage', scheme: 'file' },
    globalState,
    workspaceState: memento(),
    secrets: { get: async (k: string) => secrets.get(k), store: async (k: string, x: string) => void secrets.set(k, x), delete: async (k: string) => void secrets.delete(k), onDidChange: v.event },
  } as unknown as vscode.ExtensionContext;
  const crash = { output: { appendLine() {}, show() {}, dispose() {} }, report() {}, caught() {} } as unknown as CrashReporter;
  return { c: new GraderController(ctx, crash), secrets, globalState };
}

/** Everything sent anywhere, by host; the same fake grader answers on each host. */
let sent: { host: string; path: string; method: string; body: string }[];
function serve(answer: (host: string) => FakeGrader | Response) {
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const u = new URL(input);
    sent.push({ host: u.host, path: u.pathname, method: init.method ?? 'GET', body: String(init.body ?? '') });
    const a = answer(u.host);
    return a instanceof Response ? a.clone() : a.fetch(input, init);
  });
}
const web = (text: string) => new Response(text, { status: 200, headers: { 'content-type': 'text/html' } });

beforeEach(() => {
  v.settings.clear();
  v.listeners.length = 0;
  v.showWarningMessage.mockReset();
  sent = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('logging in to another server', () => {
  it('a wrong address gets one anonymous GET and no password; the saved account stays', async () => {
    v.settings.set('username', 'old');
    serve(() => web('<html>not a grader</html>'));
    const { c, secrets } = start();
    secrets.set(`cedtGrader.password:${DEFAULT_BASE_URL}:old`, 'kept');

    expect(await c.loginWith('new', 'hunter2', true, OTHER)).toBe(false);

    expect(sent).toEqual([{ host: 'other.example', path: '/api/v1/languages', method: 'GET', body: '' }]);
    expect(JSON.stringify(sent)).not.toContain('hunter2');
    expect([...secrets.values()]).toEqual(['kept']);
    expect(v.settings.get('baseUrl')).toBeUndefined();
    expect(v.settings.get('username')).toBe('old');
    expect(c.state().account.server.status).toBe('bad');
  });

  it('checking an address changes nothing, even when it works', async () => {
    v.settings.set('username', 'old');
    serve(() => new FakeGrader());
    const { c, secrets } = start();
    secrets.set(`cedtGrader.password:${DEFAULT_BASE_URL}:old`, 'kept');

    await c.checkServer(OTHER);

    expect(c.state().account.server.status).toBe('ok');
    expect([...secrets.values()]).toEqual(['kept']);
    expect(v.settings.get('baseUrl')).toBeUndefined();
  });

  it('a good address: checked first, saved to user settings, password goes only there', async () => {
    v.settings.set('username', 'student');
    const server = new FakeGrader();
    serve(() => server);
    const { c, secrets, globalState } = start();
    secrets.set(`cedtGrader.password:${DEFAULT_BASE_URL}:student`, 'old-password');

    expect(await c.loginWith('student', server.password, true, 'other.example')).toBe(true);

    expect(sent[0]).toMatchObject({ path: '/api/v1/languages', body: '' });
    expect(sent.findIndex((r) => r.path === '/api/v1/auth/login')).toBeGreaterThan(0);
    expect(new Set(sent.map((r) => r.host))).toEqual(new Set(['other.example']));
    expect(v.settings.get('baseUrl')).toBe(OTHER);
    expect(globalState.get(KEYS.verifiedServers)).toEqual([OTHER]);
    expect(secrets.has(`cedtGrader.password:${DEFAULT_BASE_URL}:student`)).toBe(false);
    expect(secrets.get(`cedtGrader.password:${OTHER}:student`)).toBe(server.password);
    expect(c.state().baseUrl).toBe(OTHER);
    expect(c.state().account.status).toBe('logged-in');
    expect(c.state().account.server.status).toBe('idle');
  });

  it('the default server is never probed', async () => {
    const server = new FakeGrader();
    serve(() => server);
    const { c } = start();
    expect(await c.loginWith('student', server.password, false)).toBe(true);
    expect(sent[0].path).toBe('/api/v1/auth/login');
  });

  it('going back to the default clears the setting', async () => {
    v.settings.set('baseUrl', OTHER);
    const server = new FakeGrader();
    serve(() => server);
    const { c } = start();
    expect(await c.loginWith('student', server.password, false, '')).toBe(true);
    expect(v.settings.has('baseUrl')).toBe(false);
    expect(c.state().baseUrl).toBe(DEFAULT_BASE_URL);
    expect(new Set(sent.map((r) => r.host))).toEqual(new Set([new URL(DEFAULT_BASE_URL).host]));
  });

  it('an address edited in Settings is checked before the first password', async () => {
    v.settings.set('baseUrl', OTHER);
    serve(() => web('nope'));
    const { c } = start();
    expect(await c.loginWith('student', 'hunter2', true)).toBe(false);
    expect(sent.map((r) => r.path)).toEqual(['/api/v1/languages']);
  });

  it('http: cancelling the warning sends no password', async () => {
    serve(() => new FakeGrader());
    const { c, secrets } = start();
    expect(await c.loginWith('student', 'hunter2', true, 'http://plain.example')).toBe(false);
    expect(v.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(v.showWarningMessage.mock.calls[0][1]).toMatchObject({ modal: true });
    expect(sent.map((r) => r.path)).toEqual(['/api/v1/languages']);
    expect(secrets.size).toBe(0);
    expect(v.settings.has('baseUrl')).toBe(false);
  });

  it('a saved password logs in with no check: it has already been to that address', async () => {
    v.settings.set('baseUrl', OTHER);
    v.settings.set('username', 'student');
    const server = new FakeGrader();
    serve(() => server);
    const { c, secrets } = start();
    secrets.set(`cedtGrader.password:${OTHER}:student`, server.password);
    expect(await c.login()).toBe(true);
    expect(sent[0].path).toBe('/api/v1/auth/login');
  });
});
