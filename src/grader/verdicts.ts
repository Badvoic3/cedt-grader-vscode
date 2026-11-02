import type { Verdict } from './types';

/**
 * cafe-grader result codes (`Evaluation::RESULT_CODE`, `config/locales/en.yml`,
 * `app/helpers/grader_comment_helper.rb`).
 */
const CODES: Readonly<Record<string, { kind: string; word: string }>> = {
  P: { kind: 'correct', word: 'Correct' },
  '-': { kind: 'wrong', word: 'Wrong Answer' },
  s: { kind: 'partial', word: 'Partially Correct' },
  T: { kind: 'time_limit', word: 'Time Limit Exceed' },
  M: { kind: 'memory_limit', word: 'Memory Limit Exceed' },
  x: { kind: 'crash', word: 'Program Crashed' },
  E: { kind: 'unknown_error', word: 'UNKNOWN ERROR' },
  '!': { kind: 'grader_error', word: 'GRADER ERROR' },
  '?': { kind: 'waiting', word: 'Judging' },
};

/** Same shape the website accepts for a verdict strip: runs of codes and `[...]` groups. */
const STRIP = /^(?:[^[\]\s]+|\[[^[\]\s]+\])+$/;

/**
 * Turn a grader comment such as `PP-T[Px]` into one verdict per test.
 * Anything that is not a strip (e.g. `Compilation error`) yields `[]`.
 * Unknown codes are kept with kind `unknown` and the raw character as label.
 */
export function parseGraderComment(comment: string | null | undefined): Verdict[] {
  const c = (comment ?? '').trim();
  // Plain-text comments ("Compilation error", "No testcase", ...) contain spaces and fail STRIP.
  if (!c || !STRIP.test(c)) return [];
  const tokens: { code: string; group?: number }[] = [];
  let group = 0;
  for (const m of c.matchAll(/\[([^\]]+)\]|([^[\]]+)/g)) {
    if (m[1] !== undefined) {
      group++;
      for (const ch of m[1]) tokens.push({ code: ch, group });
    } else {
      for (const ch of m[2]) tokens.push({ code: ch });
    }
  }
  const n = tokens.length;
  return tokens.map((t, i) => {
    const known = CODES[t.code];
    const v: Verdict = {
      index: i + 1,
      ok: known?.kind === 'correct',
      kind: known?.kind ?? 'unknown',
      label: `Test ${i + 1} of ${n}: ${known?.word ?? `Result "${t.code}"`}`,
    };
    if (t.group !== undefined) v.group = t.group;
    return v;
  });
}

const WORDS: Readonly<Record<string, string>> = Object.fromEntries(Object.values(CODES).map((c) => [c.kind, c.word]));

/** Word for an evaluation `result` kind (`correct` → `Correct`), or the raw kind. */
export function resultWord(kind: string | null | undefined): string {
  return (kind && WORDS[kind]) || kind || 'Unknown';
}
