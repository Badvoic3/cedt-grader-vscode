import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const v = vi.hoisted(() => ({
  openExternal: vi.fn(async () => true),
  showErrorMessage: vi.fn(async (..._: unknown[]): Promise<string | undefined> => undefined),
  appendLine: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: { createOutputChannel: () => ({ appendLine: v.appendLine, dispose: vi.fn() }), showErrorMessage: v.showErrorMessage },
  env: { openExternal: v.openExternal, appName: 'Visual Studio Code' },
  workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: () => undefined, inspect: () => undefined }) },
  version: '1.145.0',
}));

import type * as vscode from 'vscode';
import { CrashReporter } from '../src/crashReporter';
import { GraderError } from '../src/grader/errors';
import { S } from '../src/shared/strings';

const EXT = '/opt/ext/our-extension';
const ctx = { extensionPath: EXT, extension: { packageJSON: { version: '1.0.1' } } } as unknown as vscode.ExtensionContext;

function bug(message = 'x', path = EXT): TypeError {
  const err = new TypeError(message);
  err.stack = `TypeError: ${message}\n    at f (${path}/dist/extension.js:1:2)`;
  return err;
}
const tick = () => new Promise((r) => setTimeout(r));

describe('CrashReporter', () => {
  let c: CrashReporter;
  const made: CrashReporter[] = [];
  const make = () => {
    const r = new CrashReporter(ctx);
    r.privateInfo = () => ({});
    made.push(r);
    return r;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    c = make();
    c.panelReady = () => true;
  });
  afterEach(() => {
    while (made.length) made.pop()?.dispose();
  });

  it('shows the card and opens nothing by itself', async () => {
    const changed = vi.fn();
    c.onChange = changed;
    c.report(bug(), 'command submit');
    expect(c.view?.report).toContain('Where: command submit');
    await tick();
    expect(changed).toHaveBeenCalled();
    expect(v.showErrorMessage).not.toHaveBeenCalled();
    expect(v.openExternal).not.toHaveBeenCalled();
  });

  it('opens the exact text only on the button, as a string so that VS Code keeps the query', async () => {
    c.report(bug('a & b #c'), 'command submit');
    const view = c.view!;
    await c.answer(view.id, 'open');
    expect(v.openExternal).toHaveBeenCalledTimes(1);
    const url = (v.openExternal.mock.calls as unknown[][])[0][0];
    expect(typeof url).toBe('string');
    expect(new URL(url as string).searchParams.get('report')).toBe(view.report);
    expect(c.view).toBeNull();
  });

  it('sends nothing on Not now, or for an old card', async () => {
    c.report(bug(), 'command submit');
    const id = c.view!.id;
    await c.answer(id + 1, 'open');
    expect(c.view).not.toBeNull();
    await c.answer(id, 'dismiss');
    await c.answer(id, 'open');
    expect(c.view).toBeNull();
    expect(v.openExternal).not.toHaveBeenCalled();
  });

  it('offers the same error once per session', async () => {
    c.report(bug(), 'command submit');
    await c.answer(c.view!.id, 'dismiss');
    c.report(bug(), 'command submit');
    expect(c.view).toBeNull();
    expect(v.appendLine).toHaveBeenCalledTimes(2); // still logged
  });

  it('uses a notification when there is no panel, then shows the exact text before opening', async () => {
    c.panelReady = () => false;
    v.showErrorMessage.mockResolvedValueOnce(S.crash.review).mockResolvedValueOnce(S.crash.report);
    c.report(bug(), 'activation');
    await tick();
    expect(c.view).toBeNull();
    expect(v.showErrorMessage).toHaveBeenCalledTimes(2);
    const [, options] = v.showErrorMessage.mock.calls[1] as [string, { modal: boolean; detail: string }];
    expect(options.modal).toBe(true);
    expect(options.detail).toContain('Where: activation');
    expect(v.openExternal).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Not now', [undefined]],
    ['closing the dialog', [S.crash.review, undefined]],
  ])('sends nothing after %s in the notification', async (_, answers) => {
    c.panelReady = () => false;
    for (const a of answers) v.showErrorMessage.mockResolvedValueOnce(a);
    c.report(bug(), 'activation');
    await tick();
    expect(v.openExternal).not.toHaveBeenCalled();
  });

  it('uses a notification for a panel script error, even with the panel showing', async () => {
    c.panelError('boom', '    at f (https://x/media/dist/webview.js:1:2)');
    await tick();
    expect(c.view).toBeNull();
    expect(v.showErrorMessage).toHaveBeenCalledTimes(1);
  });

  it('caps what the panel can send', () => {
    c.report = vi.fn();
    c.panelError('m'.repeat(10000), 's'.repeat(10000));
    const err = (c.report as ReturnType<typeof vi.fn>).mock.calls[0][0] as Error;
    expect(err.message.length).toBeLessThanOrEqual(4000);
    expect(err.stack?.length).toBeLessThanOrEqual(4000);
  });

  it('skips grader errors, and handled errors that are not bugs', () => {
    c.report(new GraderError('x'), 'command submit');
    c.caught(new Error('plain'), 'handled error');
    expect(c.view).toBeNull();
    c.caught(bug(), 'handled error');
    expect(c.view).not.toBeNull();
  });

  it('reacts to process errors only when they come from this extension', () => {
    process.emit('unhandledRejection', bug('theirs', '/opt/ext/other'), Promise.resolve());
    expect(c.view).toBeNull();
    process.emit('unhandledRejection', bug('ours'), Promise.resolve());
    expect(c.view?.report).toContain('Where: unhandled error');
  });

  it('stops listening when disposed', () => {
    const before = process.listenerCount('unhandledRejection');
    const r = make();
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    r.dispose();
    expect(process.listenerCount('unhandledRejection')).toBe(before);
    expect(process.listenerCount('uncaughtException')).toBeGreaterThanOrEqual(0);
  });

  it('never throws from the reporter', () => {
    c.privateInfo = () => {
      throw new Error('no config');
    };
    expect(() => c.report(bug(), 'activation')).not.toThrow();
  });

  it('has no way to send anything except the browser', () => {
    for (const file of ['src/crashReporter.ts', 'src/shared/crashReport.ts']) {
      const code = readFileSync(file, 'utf8');
      expect(code).not.toMatch(/\bfetch\(|https?\.request|XMLHttpRequest/);
      expect(code.match(/openExternal\(/g)?.length ?? 0).toBe(file.includes('crashReporter') ? 1 : 0);
    }
  });
});
