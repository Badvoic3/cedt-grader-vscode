import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ProcessApi, RunnerChild } from './types';

/** The real thing. No shell anywhere: arguments are never parsed by anything. */
export const nodeProcessApi: ProcessApi = {
  spawn(command, args, options) {
    // Own process group on POSIX, so one signal reaches everything the program started. On Windows
    // `detached` would open a console window, and `taskkill /T` walks the tree instead.
    return spawn(command, [...args], { ...options, detached: process.platform !== 'win32', windowsHide: true, shell: false });
  },
  killTree(child) {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      if (process.platform === 'win32') {
        const taskkill = join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        const killer = spawn(taskkill, ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => child.kill());
      } else process.kill(-pid, 'SIGKILL'); // SIGKILL at once: a program may catch SIGTERM
    } catch {
      /* already gone */
    }
  },
};

export interface ToEnd {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** It never started (`ENOENT`, `EACCES`, …). */
  spawnError: NodeJS.ErrnoException | null;
}

/**
 * Run a short helper command to its end (a version check, a compiler) and
 * keep at most `maxBytes` of each stream; the rest is read and dropped so the
 * process never blocks on a full pipe. The whole tree is killed at `timeoutMs`
 * or when `signal` aborts.
 */
export function runToEnd(
  proc: ProcessApi,
  command: string,
  args: readonly string[],
  opts: { timeoutMs: number; maxBytes?: number; cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<ToEnd> {
  const max = opts.maxBytes ?? 64 * 1024;
  return new Promise((resolve) => {
    let child: RunnerChild;
    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const size = { stdout: 0, stderr: 0 };
    let timedOut = false;
    let done = false;
    const finish = (code: number | null, sig: string | null, spawnError: NodeJS.ErrnoException | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
      resolve({ code, signal: sig, stdout: Buffer.concat(out.stdout).toString('utf8'), stderr: Buffer.concat(out.stderr).toString('utf8'), timedOut, spawnError });
    };
    const stop = () => proc.killTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    try {
      child = proc.spawn(command, args, { cwd: opts.cwd, env: opts.env });
    } catch (err) {
      finish(null, null, err as NodeJS.ErrnoException);
      return;
    }
    if (opts.signal?.aborted) stop();
    else opts.signal?.addEventListener('abort', stop, { once: true });
    const keep = (name: 'stdout' | 'stderr') => (d: Buffer) => {
      const room = max - size[name];
      if (room > 0) out[name].push(d.subarray(0, room));
      size[name] += d.length;
    };
    child.stdout.on('data', keep('stdout'));
    child.stderr.on('data', keep('stderr'));
    child.stdin.on('error', () => {});
    child.stdin.end();
    child.on('error', (err) => finish(null, null, err));
    child.on('close', (code, sig) => finish(code, sig, null));
  });
}
