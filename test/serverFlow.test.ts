import { describe, expect, it, vi } from 'vitest';
import { needsCheck, ServerFlow, type ServerDeps } from '../src/flows/server';
import type { ServerCheck } from '../src/grader';
import { DEFAULT_BASE_URL, LIMITS } from '../src/shared/constants';

const GOOD = 'https://good.example';
const answer = (status: ServerCheck['status']): ServerCheck => ({ status });

function flow(over: Partial<ServerDeps> = {}, verified: string[] = []) {
  const state = { verified };
  const deps = {
    verified: () => state.verified,
    saveVerified: vi.fn(async (l: string[]) => void (state.verified = l)),
    check: vi.fn(async (_: string) => answer('compatible')),
    confirmInsecure: vi.fn(async () => true),
    changed: vi.fn(),
    ...over,
  };
  return { f: new ServerFlow(deps), deps, state };
}

describe('what needs a check', () => {
  it('never the default server or an accepted address', () => {
    expect(needsCheck(DEFAULT_BASE_URL, [])).toBe(false);
    expect(needsCheck(GOOD, [GOOD])).toBe(false);
    expect(needsCheck(GOOD, [])).toBe(true);
  });
});

describe('gate', () => {
  it('the default server passes with no request, even if the check would fail', async () => {
    const { f, deps } = flow({ check: vi.fn(async () => answer('incompatible')) });
    expect(await f.gate(undefined, DEFAULT_BASE_URL)).toEqual({ ok: true, url: DEFAULT_BASE_URL });
    expect(await f.gate('', GOOD)).toEqual({ ok: true, url: DEFAULT_BASE_URL });
    expect(deps.check).not.toHaveBeenCalled();
  });

  it('an accepted address passes with no request', async () => {
    const { f, deps } = flow({}, [GOOD]);
    expect(await f.gate(GOOD, DEFAULT_BASE_URL)).toEqual({ ok: true, url: GOOD });
    expect(deps.check).not.toHaveBeenCalled();
  });

  it('a new address is checked once, then remembered', async () => {
    const { f, deps, state } = flow();
    expect(await f.gate('good.example/', DEFAULT_BASE_URL)).toEqual({ ok: true, url: GOOD });
    expect(deps.check).toHaveBeenCalledTimes(1);
    expect(state.verified).toEqual([GOOD]);
    await f.gate(GOOD, DEFAULT_BASE_URL);
    expect(deps.check).toHaveBeenCalledTimes(1);
  });

  it('an address changed in Settings is checked too', async () => {
    const { f, deps } = flow({ check: vi.fn(async () => answer('incompatible')) });
    expect(await f.gate(undefined, 'https://edited.example')).toEqual({ ok: false });
    expect(deps.check).toHaveBeenCalledWith('https://edited.example');
  });

  it('an incompatible address is blocked with the reason, and not remembered', async () => {
    const { f, deps, state } = flow({ check: vi.fn(async () => answer('incompatible')) });
    expect(await f.gate(GOOD, DEFAULT_BASE_URL)).toEqual({ ok: false });
    expect(f.view()).toMatchObject({ status: 'bad', message: expect.stringContaining("wasn't sent") });
    expect(state.verified).toEqual([]);
    expect(deps.saveVerified).not.toHaveBeenCalled();
  });

  it('text that is no address is blocked with no request', async () => {
    const { f, deps } = flow();
    expect(await f.gate('ftp://x', DEFAULT_BASE_URL)).toEqual({ ok: false });
    expect(deps.check).not.toHaveBeenCalled();
    expect(f.view().status).toBe('bad');
  });

  it('unreachable blocks, and the next try really tries again', async () => {
    const check = vi.fn<(u: string) => Promise<ServerCheck>>().mockResolvedValueOnce(answer('unreachable')).mockResolvedValueOnce(answer('compatible'));
    const { f } = flow({ check });
    expect(await f.gate(GOOD, DEFAULT_BASE_URL)).toEqual({ ok: false });
    expect(f.view()).toMatchObject({ status: 'unreachable', message: expect.stringContaining('good.example') });
    expect(await f.gate(GOOD, DEFAULT_BASE_URL)).toEqual({ ok: true, url: GOOD });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('http asks first; cancelling stops it and remembers nothing', async () => {
    const { f, deps, state } = flow({ confirmInsecure: vi.fn(async () => false) });
    expect(await f.gate('http://plain.example', DEFAULT_BASE_URL)).toEqual({ ok: false });
    expect(deps.confirmInsecure).toHaveBeenCalledTimes(1);
    expect(state.verified).toEqual([]);
  });

  it('http accepted is remembered, so it asks once', async () => {
    const { f, deps } = flow();
    await f.gate('http://plain.example', DEFAULT_BASE_URL);
    await f.gate('http://plain.example', DEFAULT_BASE_URL);
    expect(deps.confirmInsecure).toHaveBeenCalledTimes(1);
  });

  it('http on this computer asks nothing; a failed check never reaches the question', async () => {
    const a = flow();
    await a.f.gate('http://localhost:3000', DEFAULT_BASE_URL);
    expect(a.deps.confirmInsecure).not.toHaveBeenCalled();
    const b = flow({ check: vi.fn(async () => answer('incompatible')) });
    await b.f.gate('http://plain.example', DEFAULT_BASE_URL);
    expect(b.deps.confirmInsecure).not.toHaveBeenCalled();
  });

  it('the remembered list stays short, newest first', async () => {
    const old = Array.from({ length: LIMITS.verifiedServers }, (_, i) => `https://s${i}.example`);
    const { f, state } = flow({}, old);
    await f.gate(GOOD, DEFAULT_BASE_URL);
    expect(state.verified).toHaveLength(LIMITS.verifiedServers);
    expect(state.verified[0]).toBe(GOOD);
  });
});

describe('inspect', () => {
  it('shows checking, then the result, and saves nothing', async () => {
    const { f, deps } = flow();
    const p = f.inspect(GOOD);
    expect(f.view()).toMatchObject({ draft: GOOD, status: 'checking' });
    await p;
    expect(f.view()).toMatchObject({ draft: GOOD, status: 'ok', message: null });
    expect(deps.saveVerified).not.toHaveBeenCalled();
  });

  it('the same address is requested once, also while running', async () => {
    const { f, deps } = flow();
    await Promise.all([f.inspect(GOOD), f.inspect(GOOD)]);
    await f.inspect(GOOD);
    expect(deps.check).toHaveBeenCalledTimes(1);
  });

  it('a login during a check shares the request', async () => {
    const { f, deps } = flow();
    await Promise.all([f.inspect(GOOD), f.gate(GOOD, DEFAULT_BASE_URL)]);
    expect(deps.check).toHaveBeenCalledTimes(1);
  });

  it('an older answer does not replace a newer address', async () => {
    let finish!: (r: ServerCheck) => void;
    const check = vi.fn((u: string) => (u === 'https://slow.example' ? new Promise<ServerCheck>((r) => (finish = r)) : Promise.resolve(answer('compatible'))));
    const { f } = flow({ check });
    const slow = f.inspect('https://slow.example');
    await f.inspect(GOOD);
    finish(answer('incompatible'));
    await slow;
    expect(f.view()).toMatchObject({ draft: GOOD, status: 'ok' });
  });

  it('the default server and an empty field need no request', async () => {
    const { f, deps } = flow();
    await f.inspect('');
    expect(f.view().status).toBe('idle');
    expect(deps.check).not.toHaveBeenCalled();
  });

  it('reset clears what is shown', async () => {
    const { f } = flow({ check: vi.fn(async () => answer('incompatible')) });
    await f.inspect(GOOD);
    f.reset();
    expect(f.view()).toEqual({ draft: null, status: 'idle', message: null });
  });
});
