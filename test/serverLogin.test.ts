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
  return { settings, listeners, event, failUpdate: null as string | null, showWarningMessage: vi.fn(async (..._: unknown[]): Promise<string | undefined> => undefined), openExternal: vi.fn(async () => true) };
});

vi.mock('vscode', () => {
  const channel = { appendLine() {}, dispose() {}, show() {} };
  const configuration = () => ({
    get: (k: string, d?: unknown) => v.settings.get(k) ?? d,
    inspect: (k: string) => ({ globalValue: v.settings.get(k) }),
    update: async (k: string, value: unknown, target: number) => {
      if (target !== 1) throw new Error('settings must be written to user scope');
      if (k === v.failUpdate) throw new Error('settings file is read-only');
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
  v.failUpdate = null;
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

/** The user edits a setting by hand. */
function editSetting(key: string, value: string): void {
  v.settings.set(key, value);
  for (const l of v.listeners) l({ affectsConfiguration: () => true });
}
const offline = () => new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });

describe('changing account while something is still going on', () => {
  it('Retry after a failed login sends nothing to an address changed since', async () => {
    const server = new FakeGrader();
    vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
      const u = new URL(input);
      sent.push({ host: u.host, path: u.pathname, method: init.method ?? 'GET', body: String(init.body ?? '') });
      if (u.host !== 'other.example') throw offline();
      return server.fetch(input, init);
    });
    const { c } = start();
    expect(await c.loginWith('student', 'hunter2', false)).toBe(false);
    expect(c.state().connection).not.toBeNull();

    editSetting('baseUrl', OTHER);
    expect(c.state().connection).toBeNull();
    await c.retry();

    expect(JSON.stringify(sent.filter((r) => r.host === 'other.example'))).not.toContain('hunter2');
  });

  it('a login finishing after the address changed leaves no banner to retry', async () => {
    let fail!: (e: Error) => void;
    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) => {
      const u = new URL(input);
      sent.push({ host: u.host, path: u.pathname, method: init.method ?? 'GET', body: String(init.body ?? '') });
      return new Promise((_, reject) => (fail = reject));
    });
    const { c } = start();
    const login = c.loginWith('student', 'hunter2', false);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    editSetting('baseUrl', OTHER);
    fail(offline());

    expect(await login).toBe(false);
    expect(c.state().connection).toBeNull();
  });

  it('an abandoned check does not undo a newer login', async () => {
    const server = new FakeGrader();
    let finish!: () => void;
    const held = new Promise<void>((r) => (finish = r));
    vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
      const u = new URL(input);
      sent.push({ host: u.host, path: u.pathname, method: init.method ?? 'GET', body: String(init.body ?? '') });
      if (u.host === 'other.example') await held;
      return server.fetch(input, init);
    });
    const { c, secrets } = start();

    const abandoned = c.loginWith('student', server.password, true, OTHER);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(await c.loginWith('student', server.password, true)).toBe(true);
    finish();

    expect(await abandoned).toBe(false);
    expect(sent.filter((r) => r.host === 'other.example').map((r) => r.path)).toEqual(['/api/v1/languages']);
    expect(v.settings.get('baseUrl')).toBeUndefined();
    expect(secrets.get(`cedtGrader.password:${DEFAULT_BASE_URL}:student`)).toBe(server.password);
    expect(c.state().account.status).toBe('logged-in');
  });

  it('a client still running reads only its own account', async () => {
    v.settings.set('username', 'student');
    serve(() => new FakeGrader());
    const { c, secrets } = start();
    secrets.set(`cedtGrader.password:${DEFAULT_BASE_URL}:student`, 'first');
    secrets.set(`cedtGrader.password:${OTHER}:student`, 'second');
    const old = (c as unknown as { client: { opts: { getStoredCredentials(): Promise<{ password: string } | undefined> } } }).client;

    editSetting('baseUrl', OTHER);

    const creds = await old.opts.getStoredCredentials();
    expect(creds?.password).not.toBe('second');
  });

  it('a submission of the old server is not polled on the new one', async () => {
    serve(() => new FakeGrader());
    const { c } = start();
    const flow = (c as unknown as { submitFlow: { pendingPoll: unknown } }).submitFlow;
    flow.pendingPoll = { key: 'k', problem: { id: 1 }, submissionId: 7, countedBefore: null };

    editSetting('baseUrl', OTHER);

    expect(flow.pendingPoll).toBeNull();
  });

  it('correcting the setting clears a refused address from the form', async () => {
    serve(() => web('<html>not a grader</html>'));
    const { c } = start();
    await c.loginWith('student', 'hunter2', false, OTHER);
    expect(c.state().account.server.draft).toBe(OTHER);

    editSetting('baseUrl', 'https://right.example');

    expect(c.state().account.server).toMatchObject({ draft: null, status: 'idle' });
  });

  it('settings that cannot be written change nothing and send nothing', async () => {
    v.settings.set('username', 'old');
    const server = new FakeGrader();
    serve(() => server);
    v.failUpdate = 'baseUrl';
    const { c, secrets } = start();
    secrets.set(`cedtGrader.password:${DEFAULT_BASE_URL}:old`, 'kept');

    expect(await c.loginWith('new', server.password, true, OTHER)).toBe(false);

    expect(secrets.get(`cedtGrader.password:${DEFAULT_BASE_URL}:old`)).toBe('kept');
    expect(v.settings.get('username')).toBe('old');
    expect(v.settings.get('baseUrl')).toBeUndefined();
    expect(sent.some((r) => r.path === '/api/v1/auth/login')).toBe(false);
    expect(c.state().account.error).toBeTruthy();
  });
});
