import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { networkErrorFrom } from '../src/grader/errors';
import { withTimeoutSignal } from '../src/grader/timeoutSignal';

describe('withTimeoutSignal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts with a TimeoutError after the time is up, not before', () => {
    const s = withTimeoutSignal(1000);
    vi.advanceTimersByTime(999);
    expect(s.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(s.aborted).toBe(true);
    expect((s.reason as Error).name).toBe('TimeoutError');
  });

  it('a timeout reads as the same network error as AbortSignal.timeout', () => {
    const s = withTimeoutSignal(1);
    vi.advanceTimersByTime(1);
    expect(networkErrorFrom(s.reason, 'grader.example').message).toBe(networkErrorFrom(new DOMException('x', 'TimeoutError'), 'grader.example').message);
  });

  it('follows the parent with its reason and stops the timer', () => {
    const parent = new AbortController();
    const s = withTimeoutSignal(1000, parent.signal);
    const why = new Error('cancelled');
    parent.abort(why);
    expect(s.aborted).toBe(true);
    expect(s.reason).toBe(why);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a parent already aborted aborts at once, with no timer', () => {
    const parent = new AbortController();
    parent.abort('stop');
    const s = withTimeoutSignal(1000, parent.signal);
    expect(s.aborted).toBe(true);
    expect(s.reason).toBe('stop');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no listener on the parent after the timeout', () => {
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    const s = withTimeoutSignal(1000, parent.signal);
    vi.advanceTimersByTime(1000);
    expect(remove).toHaveBeenCalledTimes(1);
    parent.abort('late');
    expect((s.reason as Error).name).toBe('TimeoutError');
  });
});

describe('Node 18 (VS Code 1.82)', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : [p];
    });

  it('the extension calls nothing Node 18.15 lacks', () => {
    const banned = /AbortSignal\.(any|timeout)\(|readdir\([^)]*recursive/;
    expect(files('src').filter((f) => banned.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
