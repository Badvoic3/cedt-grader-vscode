import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMeter, decodeCapped, execCase, type ExecRequest, type ExecResult, runCases, verdictOf } from '../src/runner/execute';
import type { CaseRun, RunLimits } from '../src/runner/types';
import { RUNNER } from '../src/shared/constants';
import { type FakeCall, FakeProcessApi } from './fakeProcess';

const limits: RunLimits = { timeMs: 1000, memoryMB: 256, source: 'default' };
const req = (o: Partial<ExecRequest> = {}): ExecRequest => ({ command: '/bin/p', args: [], input: 'in', expectedBytes: 2, limits, cwd: '/tmp/x', env: {}, ...o });
const later = (fn: () => void) => setImmediate(fn);

describe('execCase', () => {
  it('gives the program its input and reads what it prints', async () => {
    let got = '';
    const p = new FakeProcessApi((c) => {
      c.child.stdin.on('data', (d) => (got += d));
      later(() => {
        c.child.stdout.write('out');
        c.child.stderr.write('err');
        later(() => c.child.finish(0));
      });
    });
    const r = await execCase(p, req());
    expect(got).toBe('in');
    expect(r).toMatchObject({ exitCode: 0, signal: null, fullStdout: 'out', stdout: { text: 'out', truncated: false }, stderr: { text: 'err', truncated: false } });
    expect(p.calls[0].options.cwd).toBe('/tmp/x');
  });

  it('a program that never reads its input is fine', async () => {
    const p = new FakeProcessApi((c) => later(() => {
      c.child.stdin.destroy(Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
      c.child.finish(0);
    }));
    expect((await execCase(p, req())).exitCode).toBe(0);
  });

  it('measures from spawn to exit', async () => {
    let t = 100;
    const p = new FakeProcessApi((c) => {
      later(() => {
        t = 150;
        later(() => {
          t = 170;
          c.child.finish(0);
          t = 900;
        });
      });
    });
    // `spawn` fires on the first immediate, before t moves on the second.
    const r = await execCase(p, req({ now: () => t }));
    expect(r.timeMs).toBeLessThanOrEqual(70);
    expect(r.timeMs).toBeGreaterThanOrEqual(20);
  });

  describe('with fake time', () => {
    beforeEach(() => void vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => void vi.useRealTimers());

    it('kills the tree at the limit plus the grace, not before', async () => {
      const p = new FakeProcessApi(() => {});
      const run = execCase(p, req());
      await vi.advanceTimersByTimeAsync(limits.timeMs + RUNNER.graceMs - 1);
      expect(p.kills).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(p.kills).toHaveLength(1);
      expect((await run).timedOut).toBe(true);
    });

    it('the hard stop holds whatever the limit', async () => {
      const p = new FakeProcessApi(() => {});
      const run = execCase(p, req({ limits: { ...limits, timeMs: 10 * 60_000 } }));
      await vi.advanceTimersByTimeAsync(RUNNER.hardStopMs);
      expect(p.kills).toHaveLength(1);
      await run;
    });

    it('reports the run when a leftover child holds the pipes open', async () => {
      const p = new FakeProcessApi((c) => later(() => {
        c.child.stdout.write('x');
        later(() => c.child.emit('exit', 0, null)); // no 'close'
      }));
      const run = execCase(p, req());
      await new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))));
      await vi.advanceTimersByTimeAsync(RUNNER.closeDeadlineMs);
      expect(await run).toMatchObject({ exitCode: 0, fullStdout: 'x', timedOut: false });
    });
  });

  it('keeps output after exit and before close', async () => {
    const p = new FakeProcessApi((c) => later(() => {
      c.child.emit('exit', 0, null);
      c.child.stdout.write('late');
      later(() => {
        c.child.stdout.end();
        c.child.stderr.end();
        later(() => c.child.emit('close', 0, null));
      });
    }));
    expect((await execCase(p, req())).fullStdout).toBe('late');
  });

  it('over the compare limit: marked, killed once, memory stays bounded', async () => {
    const chunk = Buffer.alloc(32 * 1024, 97);
    const p = new FakeProcessApi((c) => later(() => {
      for (let i = 0; i < 6; i++) c.child.stdout.write(chunk);
    }));
    const r = await execCase(p, req());
    expect(r.outputOver).toBe(true);
    expect(p.kills).toHaveLength(1);
    expect(r.fullStdout.length).toBe(RUNNER.displayBytes);
    expect(r.stdout.truncated).toBe(false);
  });

  it('a long correct answer passes: the compare limit follows the expected size', async () => {
    const big = 'x'.repeat(200 * 1024);
    const p = new FakeProcessApi((c) => later(() => {
      c.child.stdout.write(big);
      later(() => c.child.finish(0));
    }));
    const r = await execCase(p, req({ expectedBytes: big.length }));
    expect(r.outputOver).toBe(false);
    expect(r.fullStdout).toBe(big);
    expect(r.stdout).toMatchObject({ truncated: true });
    expect(r.stdout.text.length).toBe(RUNNER.displayBytes);
    expect(verdictOf(r, limits, big)).toBe('AC');
  });

  it('a flood on stderr is dropped and never kills', async () => {
    const p = new FakeProcessApi((c) => later(() => {
      for (let i = 0; i < 20; i++) c.child.stderr.write(Buffer.alloc(64 * 1024, 101));
      later(() => c.child.finish(0));
    }));
    const r = await execCase(p, req());
    expect(p.kills).toHaveLength(0);
    expect(r.stderr.truncated).toBe(true);
    expect(r.stderr.text.length).toBe(RUNNER.displayBytes);
  });

  it('Stop kills the tree and says so', async () => {
    const ac = new AbortController();
    const p = new FakeProcessApi(() => later(() => ac.abort()));
    const r = await execCase(p, req({ signal: ac.signal }));
    expect(r.stopped).toBe(true);
    expect(p.kills).toHaveLength(1);
  });

  it('a program that can not start reports the error', async () => {
    const p = new FakeProcessApi((c) => later(() => c.child.emit('error', Object.assign(new Error('no'), { code: 'EACCES' }))));
    expect((await execCase(p, req())).spawnError?.code).toBe('EACCES');
  });

  it('a throwing meter never fails the run', async () => {
    const p = new FakeProcessApi();
    const meter = { wrap: (c: { command: string; args: string[] }) => c, begin: () => { throw new Error('x'); }, end: () => Promise.reject(new Error('y')), cleanStderr: (t: string) => t };
    expect(await execCase(p, req({ meter }))).toMatchObject({ exitCode: 0, memoryKB: null });
  });
});

describe('decodeCapped', () => {
  it('never cuts a Thai character in half', () => {
    const text = 'ก'.repeat(10); // 3 bytes each
    const c = decodeCapped([Buffer.from(text)], 8);
    expect(c).toEqual({ text: 'กก', truncated: true });
  });
  it('joins chunks that split a character', () => {
    const b = Buffer.from('ก');
    expect(decodeCapped([b.subarray(0, 1), b.subarray(1)], 100)).toEqual({ text: 'ก', truncated: false });
  });
});

describe('verdictOf', () => {
  const r = (o: Partial<ExecResult> = {}): ExecResult => ({
    timeMs: 5, memoryKB: 100, exitCode: 0, signal: null, stdout: { text: '1', truncated: false }, fullStdout: '1', stderr: { text: '', truncated: false },
    outputOver: false, memoryOver: false, timedOut: false, stopped: false, spawnError: null, ...o,
  });
  it('AC and WA by the compare', () => {
    expect(verdictOf(r({ fullStdout: '1 \n\n' }), limits, '1')).toBe('AC');
    expect(verdictOf(r({ fullStdout: '2' }), limits, '1')).toBe('WA');
  });
  it('stderr never fails a case', () => {
    expect(verdictOf(r({ stderr: { text: 'debug', truncated: false } }), limits, '1')).toBe('AC');
  });
  it('a non-zero exit stays RE even when stdout matches, as on the grader', () => {
    expect(verdictOf(r({ exitCode: 1 }), limits, '1')).toBe('RE');
    expect(verdictOf(r({ exitCode: null, signal: 'SIGSEGV' }), limits, '1')).toBe('RE');
  });
  it('TLE from measured time, not only from the timer', () => {
    expect(verdictOf(r({ timeMs: 1001 }), limits, '1')).toBe('TLE');
    expect(verdictOf(r({ timeMs: 1000 }), limits, '1')).toBe('AC');
    expect(verdictOf(r({ timedOut: true, exitCode: null, signal: 'SIGKILL' }), limits, '1')).toBe('TLE');
  });
  it('MLE from the estimate; no figure is never a failure', () => {
    expect(verdictOf(r({ memoryKB: 256 * 1024 + 1 }), limits, '1')).toBe('MLE');
    expect(verdictOf(r({ memoryOver: true, exitCode: null, signal: 'SIGKILL' }), limits, '1')).toBe('MLE');
    expect(verdictOf(r({ memoryKB: null }), limits, '1')).toBe('AC');
  });
  it('OLE first, and Stop has no verdict', () => {
    expect(verdictOf(r({ outputOver: true, timedOut: true }), limits, '1')).toBe('OLE');
    expect(verdictOf(r({ stopped: true }), limits, '1')).toBeNull();
  });
});

describe('createMeter', () => {
  const deps = (o: Partial<Parameters<typeof createMeter>[1]> = {}) => ({ proc: new FakeProcessApi(), readFile: async () => '', exists: () => true, scratch: '/s/.time', ...o });
  const child = { pid: 77 } as never;

  it('Windows has no figure', async () => {
    const m = createMeter('win32', deps());
    expect(m.wrap({ command: 'p', args: [] })).toEqual({ command: 'p', args: [] });
    expect(await m.end()).toBeNull();
  });

  it('Linux reads VmHWM and stops the program over the limit', async () => {
    const m = createMeter('linux', deps({ readFile: async (p) => { expect(p).toBe('/proc/77/status'); return 'Name: x\nVmHWM:\t  5000 kB\n'; } }));
    const over = vi.fn();
    m.begin(child, 4000, over);
    await new Promise((r) => setImmediate(r));
    expect(await m.end()).toBe(5000);
    expect(over).toHaveBeenCalled();
  });

  it('Linux: a process already gone gives no figure', async () => {
    const m = createMeter('linux', deps({ readFile: () => Promise.reject(new Error('ENOENT')) }));
    m.begin(child, 4000, () => {});
    await new Promise((r) => setImmediate(r));
    expect(await m.end()).toBeNull();
  });

  it('macOS wraps with time -l and reads bytes', async () => {
    const m = createMeter('darwin', deps({ readFile: async () => '  0.1 real\n  3355443 maximum resident set size\n' }));
    expect(m.wrap({ command: '/b/p', args: ['a'] })).toEqual({ command: '/usr/bin/time', args: ['-l', '-o', '/s/.time', '/b/p', 'a'] });
    expect(await m.end()).toBe(3277);
  });

  it('macOS: no time tool or no file gives no figure', async () => {
    const none = createMeter('darwin', deps({ exists: () => false }));
    expect(none.wrap({ command: 'p', args: [] })).toEqual({ command: 'p', args: [] });
    expect(await createMeter('darwin', deps({ readFile: () => Promise.reject(new Error('x')) })).end()).toBeNull();
  });

  it('macOS: the line time adds for a crash is not the program’s stderr', () => {
    expect(createMeter('darwin', deps()).cleanStderr('mine\ntime: command terminated abnormally\n')).toBe('mine\n');
  });
});

describe('runCases', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'runner-cases-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const cases = [{ id: 'a', source: 'custom', input: '1', expected: '1' }, { id: 'b', source: 'custom', input: '2', expected: '2' }] as const;
  const echo = (c: FakeCall) => {
    c.child.stdin.on('data', (d) => c.child.stdout.write(d));
    c.child.stdin.on('end', () => later(() => c.child.finish(0)));
  };
  const run = async (p: FakeProcessApi, o: { fresh?: boolean; signal?: AbortSignal; limits?: RunLimits } = {}) => {
    const updates: CaseRun[] = [];
    const r = await runCases({
      proc: p, cases, program: { command: '/b/p', args: [], fresh: !!o.fresh }, limits: o.limits ?? limits, scratchRoot: root, env: {}, platform: 'win32',
      signal: o.signal ?? new AbortController().signal, onUpdate: (u) => updates.push(u),
    });
    return { r, updates };
  };

  it('runs one at a time, each in its own temp folder, and leaves nothing', async () => {
    let live = 0;
    let most = 0;
    const p = new FakeProcessApi((c) => {
      most = Math.max(most, ++live);
      c.child.on('close', () => live--);
      echo(c);
    });
    const { updates } = await run(p);
    expect(most).toBe(1);
    expect(updates.map((u) => `${u.caseId}:${u.state}`)).toEqual(['a:pending', 'b:pending', 'a:running', 'a:done', 'b:running', 'b:done']);
    expect(updates.filter((u) => u.state === 'done').map((u) => u.verdict)).toEqual(['AC', 'AC']);
    expect(new Set(p.calls.map((c) => c.options.cwd)).size).toBe(2);
    expect(String(p.calls[0].options.cwd).startsWith(root)).toBe(true);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(root)).toEqual([]);
  });

  it('Stop leaves every case in a final state', async () => {
    const ac = new AbortController();
    const p = new FakeProcessApi(() => later(() => ac.abort()));
    const { updates, r } = await run(p, { signal: ac.signal });
    expect(updates.slice(-2).map((u) => `${u.caseId}:${u.state}`)).toEqual(['a:stopped', 'b:stopped']);
    expect(p.calls).toHaveLength(1);
    expect(r.noexec).toBe(false);
  });

  it('reports a build folder that can not run programs', async () => {
    const p = new FakeProcessApi((c) => later(() => c.child.emit('error', Object.assign(new Error('no'), { code: 'EACCES' }))));
    expect((await run(p)).r.noexec).toBe(true);
  });

  it('a TLE on the first case after compiling gets one more try; later ones do not', async () => {
    const tiny = { ...limits, timeMs: 1 };
    const slow = (c: FakeCall) => setTimeout(() => c.child.finish(0), 20);
    const p = new FakeProcessApi(slow);
    const { updates } = await run(p, { fresh: true, limits: tiny });
    expect(p.calls).toHaveLength(3); // a, a again, b
    expect(updates.filter((u) => u.state === 'done').map((u) => u.verdict)).toEqual(['TLE', 'TLE']);
    const q = new FakeProcessApi(slow);
    await run(q, { fresh: false, limits: tiny });
    expect(q.calls).toHaveLength(2);
  });
});
