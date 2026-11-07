import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ProcessApi, RunnerChild } from '../src/runner/types';

export class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  /** End the process: `'exit'`, then the streams, then `'close'`. */
  finish(code: number | null = 0, signal: string | null = null): void {
    this.emit('exit', code, signal);
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

export interface FakeCall {
  command: string;
  args: readonly string[];
  options: { cwd?: string | URL; env?: NodeJS.ProcessEnv };
  child: FakeChild;
}

/** `start` plays the process; nothing real ever runs. `killTree` ends the child, like the real signal. */
export class FakeProcessApi implements ProcessApi {
  calls: FakeCall[] = [];
  kills: FakeChild[] = [];
  constructor(private readonly start: (call: FakeCall) => void = (c) => setImmediate(() => c.child.finish(0))) {}
  spawn: ProcessApi['spawn'] = (command, args, options) => {
    const child = new FakeChild();
    const call = { command, args, options, child };
    this.calls.push(call);
    setImmediate(() => child.emit('spawn'));
    this.start(call);
    return child as unknown as RunnerChild;
  };
  killTree: ProcessApi['killTree'] = (child) => {
    const c = child as unknown as FakeChild;
    this.kills.push(c);
    setImmediate(() => c.finish(null, 'SIGKILL'));
  };
}
