import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNNER } from '../shared/constants';
import { sameOutput } from './compare';
import { runToEnd } from './process';
import type { Captured, CaseRun, ProcessApi, RunLimits, RunnerCase, RunnerChild, Verdict } from './types';

/**
 * Runs a program on one case at a time. Measuring must never fail a run: if a
 * figure can't be had it is shown as "—". Local time and memory only estimate
 * what the grader will say; the verdict is a local check.
 */

/** What a memory figure needs around a run. Every step may do nothing. */
export interface MemoryMeter {
  wrap(cmd: { command: string; args: string[] }): { command: string; args: string[] };
  /** Called once the process has started; `over` kills it. */
  begin(child: RunnerChild, limitKB: number, over: () => void): void;
  /** Peak in KB, or null when there is no figure. */
  end(): Promise<number | null>;
  cleanStderr(text: string): string;
}

const noMeter: MemoryMeter = { wrap: (c) => c, begin: () => {}, end: async () => null, cleanStderr: (t) => t };

export interface MeterDeps {
  proc: ProcessApi;
  readFile: (path: string) => Promise<string>;
  exists: (path: string) => boolean;
  /** A file for `time -o`. */
  scratch: string;
}

/** `VmHWM` is a high-water mark, so only growth after the last sample is lost. A very short run may give no figure. */
function linuxMeter(d: MeterDeps): MemoryMeter {
  let timer: NodeJS.Timeout | undefined;
  let peak: number | null = null;
  return {
    ...noMeter,
    begin(child, limitKB, over) {
      const sample = () => {
        d.readFile(`/proc/${child.pid}/status`).then((text) => {
          const kb = Number(/^VmHWM:\s*(\d+)\s*kB/m.exec(text)?.[1]);
          if (!kb) return;
          peak = Math.max(peak ?? 0, kb);
          if (kb > limitKB) over();
        }, () => {});
      };
      sample();
      timer = setInterval(sample, RUNNER.memoryPollLinuxMs);
    },
    async end() {
      clearInterval(timer);
      return peak;
    },
  };
}

/**
 * `/usr/bin/time -l` gives the kernel's figure once the program ends. It can't
 * stop a program mid-run, so `ps` looks at the process group now and then.
 */
function macMeter(d: MeterDeps): MemoryMeter {
  const TIME = '/usr/bin/time';
  if (!d.exists(TIME)) return noMeter;
  let timer: NodeJS.Timeout | undefined;
  return {
    wrap: (c) => ({ command: TIME, args: ['-l', '-o', d.scratch, c.command, ...c.args] }),
    begin(child, limitKB, over) {
      timer = setInterval(() => {
        void runToEnd(d.proc, '/bin/ps', ['-o', 'rss=', '-g', String(child.pid)], { timeoutMs: 2_000 }).then((r) => {
          const kb = r.stdout.split('\n').reduce((n, l) => n + (Number(l.trim()) || 0), 0);
          if (kb > limitKB) over();
        });
      }, RUNNER.memoryPollMacMs);
    },
    async end() {
      clearInterval(timer);
      const text = await d.readFile(d.scratch).catch(() => '');
      const bytes = Number(/(\d+)\s+maximum resident set size/.exec(text)?.[1]);
      return bytes ? Math.round(bytes / 1024) : null;
    },
    cleanStderr: (t) => t.replace(/^time: command terminated abnormally\n?/m, ''),
  };
}

export function createMeter(platform: NodeJS.Platform, d: MeterDeps): MemoryMeter {
  if (platform === 'linux') return linuxMeter(d);
  if (platform === 'darwin') return macMeter(d);
  return noMeter;
}

/** Text from the start of `chunks`, at most `limit` bytes, cut at a character boundary. */
export function decodeCapped(chunks: readonly Buffer[], limit: number): Captured {
  const all = Buffer.concat(chunks);
  if (all.length <= limit) return { text: all.toString('utf8'), truncated: false };
  let end = limit;
  while (end > 0 && (all[end] & 0xc0) === 0x80) end--;
  return { text: all.subarray(0, end).toString('utf8'), truncated: true };
}

export interface ExecRequest {
  command: string;
  args: string[];
  input: string;
  /** Size of the expected output in bytes: the compare limit follows it. */
  expectedBytes: number;
  limits: RunLimits;
  cwd: string;
  env: NodeJS.ProcessEnv;
  meter?: MemoryMeter;
  signal?: AbortSignal;
  now?: () => number;
}

export interface ExecResult {
  timeMs: number;
  memoryKB: number | null;
  exitCode: number | null;
  signal: string | null;
  stdout: Captured;
  /** Everything kept for the compare. */
  fullStdout: string;
  stderr: Captured;
  outputOver: boolean;
  memoryOver: boolean;
  timedOut: boolean;
  stopped: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

const clock = () => Number(process.hrtime.bigint() / 1000n) / 1000;

/** One run of the program. Never rejects. */
export function execCase(proc: ProcessApi, r: ExecRequest): Promise<ExecResult> {
  const meter = r.meter ?? noMeter;
  const now = r.now ?? clock;
  const compareLimit = Math.max(RUNNER.displayBytes, 2 * r.expectedBytes);
  return new Promise((resolve) => {
    const { command, args } = meter.wrap({ command: r.command, args: r.args });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let started = now();
    let ended: number | null = null;
    let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
    const flags = { outputOver: false, memoryOver: false, timedOut: false, stopped: false };
    let spawnError: NodeJS.ErrnoException | null = null;
    let settled = false;
    let child: RunnerChild;
    let killed = false;
    let deadline: NodeJS.Timeout | undefined;

    const kill = () => {
      if (killed) return;
      killed = true;
      proc.killTree(child);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      r.signal?.removeEventListener('abort', onAbort);
      child?.stdout.destroy();
      child?.stderr.destroy();
      void meter.end().catch(() => null).then((memoryKB) => {
        const stderr = decodeCapped(errChunks, RUNNER.displayBytes);
        resolve({
          timeMs: Math.max(0, (ended ?? now()) - started),
          memoryKB,
          exitCode: exit.code,
          signal: exit.signal,
          stdout: decodeCapped(outChunks, RUNNER.displayBytes),
          fullStdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: { ...stderr, text: meter.cleanStderr(stderr.text) },
          ...flags,
          spawnError,
        });
      });
    };
    const onAbort = () => {
      flags.stopped = true;
      kill();
    };
    const timer = setTimeout(() => {
      flags.timedOut = true;
      kill();
    }, Math.min(r.limits.timeMs + RUNNER.graceMs, RUNNER.hardStopMs));

    try {
      child = proc.spawn(command, args, { cwd: r.cwd, env: r.env });
    } catch (err) {
      spawnError = err as NodeJS.ErrnoException;
      finish();
      return;
    }
    if (r.signal?.aborted) onAbort();
    else r.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('spawn', () => {
      started = now();
      try {
        meter.begin(child, r.limits.memoryMB * 1024, () => {
          flags.memoryOver = true;
          kill();
        });
      } catch {
        /* no figure, then */
      }
    });
    child.on('error', (err) => {
      if (ended !== null || settled) return;
      spawnError = err;
      finish();
    });
    child.on('exit', (code, sig) => {
      ended = now();
      exit = { code, signal: sig };
      clearTimeout(timer); // it ended in time, whatever the pipes do next
      // A child the program left behind can hold the pipes open.
      deadline = setTimeout(finish, RUNNER.closeDeadlineMs);
    });
    child.on('close', finish);

    // The listeners stay on after a kill: an unread pipe would block the program.
    child.stdout.on('data', (d: Buffer) => {
      const room = compareLimit - outBytes;
      if (room > 0) outChunks.push(d.length > room ? d.subarray(0, room) : d);
      outBytes += d.length;
      if (outBytes > compareLimit && !flags.outputOver) {
        flags.outputOver = true; // it can't match any more
        kill();
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      const room = RUNNER.displayBytes + 4 - errBytes;
      if (room > 0) errChunks.push(d.length > room ? d.subarray(0, room) : d);
      errBytes += d.length; // past the cap: read and dropped, so heavy `cerr` debugging doesn't fail a run
    });
    child.stdin.on('error', () => {}); // a program that doesn't read its input
    child.stdin.end(r.input);
  });
}

/** The verdict from the exit code and the compared output: stderr never counts. Null: stopped. */
export function verdictOf(r: ExecResult, limits: RunLimits, expected: string): Verdict | null {
  if (r.stopped) return null;
  if (r.outputOver) return 'OLE';
  if (r.timedOut || r.timeMs > limits.timeMs) return 'TLE';
  if (r.memoryOver || (r.memoryKB ?? 0) > limits.memoryMB * 1024) return 'MLE';
  if (r.spawnError || r.exitCode !== 0 || r.signal) return 'RE';
  return sameOutput(r.fullStdout, expected) ? 'AC' : 'WA';
}

export interface RunCasesInput {
  proc: ProcessApi;
  cases: readonly RunnerCase[];
  program: { command: string; args: string[]; fresh: boolean };
  limits: RunLimits;
  /** Parent of the temp folders the program runs in. */
  scratchRoot: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  signal: AbortSignal;
  onUpdate: (run: CaseRun) => void;
}

/**
 * Cases one at a time: running them together would inflate wall time and give
 * false TLEs. Each runs in its own temp folder, so a program's files never
 * reach the workspace. Every path, Stop included, leaves each case in a final
 * state. `noexec`: the program could not be started from its build folder.
 */
export async function runCases(o: RunCasesInput): Promise<{ noexec: boolean }> {
  for (const c of o.cases) o.onUpdate({ caseId: c.id, state: 'pending' });
  let first = o.program.fresh;
  for (const c of o.cases) {
    if (o.signal.aborted) {
      o.onUpdate({ caseId: c.id, state: 'stopped' });
      continue;
    }
    o.onUpdate({ caseId: c.id, state: 'running' });
    const cwd = await mkdtemp(join(o.scratchRoot, 'cedt-grader-run-'));
    try {
      const once = () => {
        const scratch = join(cwd, '.time');
        const meter = createMeter(o.platform, { proc: o.proc, readFile: (p) => readFile(p, 'utf8'), exists: existsSync, scratch });
        return execCase(o.proc, { ...o.program, input: c.input, expectedBytes: Buffer.byteLength(c.expected), limits: o.limits, cwd, env: o.env, meter, signal: o.signal });
      };
      let r = await once();
      if (r.spawnError && (r.spawnError.code === 'EACCES' || r.spawnError.code === 'EPERM')) return { noexec: true };
      // A first run after compiling can be held up by antivirus, so it gets one more try.
      if (first && verdictOf(r, o.limits, c.expected) === 'TLE') r = await once();
      first = false;
      const verdict = verdictOf(r, o.limits, c.expected);
      if (!verdict) {
        o.onUpdate({ caseId: c.id, state: 'stopped' });
        continue;
      }
      o.onUpdate({ caseId: c.id, state: 'done', verdict, timeMs: Math.round(r.timeMs), memoryKB: r.memoryKB, exitCode: r.exitCode, signal: r.signal, actual: r.stdout, stderr: r.stderr });
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { noexec: false };
}
