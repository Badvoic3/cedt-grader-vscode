import { normalizeEol } from '../mapping/testCases';
import type { RunnerCase } from './types';

/**
 * The output compare, matching the grader's default `diff -q -b -B -Z`
 * (cafe-grader `app/engine/checker.rb`). Two outputs are the same when their
 * normal forms are equal:
 *  - `-Z`: whitespace at a line's end doesn't count (this covers `\r`);
 *  - `-b`: a run of whitespace equals any other run, but whitespace against
 *    none still differs, so ` a` is not `a` and `a b` is not `ab`;
 *  - `-B`: blank lines don't count.
 * `diff` works on bytes in the C locale, so only ASCII whitespace counts here
 * (never a no-break or a Thai-context space).
 */
export function normalizeOutput(text: string): string {
  const lines: string[] = [];
  for (const raw of normalizeEol(text).split('\n')) {
    const line = raw.replace(/[ \t\f\v]+$/, '').replace(/[ \t\f\v]+/g, ' ');
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

export function sameOutput(actual: string, expected: string): boolean {
  return normalizeOutput(actual) === normalizeOutput(expected);
}

/**
 * Duplicate key of a case. Spacing in an input can change what a program
 * does, so the input keeps it (only line endings and the end of the text are
 * evened out); the output counts as the compare counts it. Two cases with the
 * same key behave the same in the runner.
 */
export function caseKey(c: Pick<RunnerCase, 'input' | 'expected'>): string {
  return `${normalizeEol(c.input).trimEnd()}\u0000${normalizeOutput(c.expected)}`;
}
