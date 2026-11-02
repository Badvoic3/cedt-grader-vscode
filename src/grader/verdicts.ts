import type { Verdict } from './types';

/**
 * cafe-grader result codes (`Evaluation::RESULT_CODE`, `config/locales/en.yml`,
 * `app/helpers/grader_comment_helper.rb`).
 */
const CODES: Readonly<Record<string, { kind: string; word: string }>> = {
  '?': { kind: 'waiting', word: 'Judging' },
  P: { kind: 'correct', word: 'Correct' },
  '-': { kind: 'wrong', word: 'Wrong Answer' },
  s: { kind: 'partial', word: 'Partially Correct' },
  T: { kind: 'time_limit', word: 'Time Limit Exceed' },
  M: { kind: 'memory_limit', word: 'Memory Limit Exceed' },
  x: { kind: 'crash', word: 'Program Crashed' },
  E: { kind: 'unknown_error', word: 'UNKNOWN ERROR' },
  '!': { kind: 'grader_error', word: 'GRADER ERROR' },
};

/** The 9 codes, in `Evaluation::RESULT_CODE` order. */
export const VERDICT_CODES = Object.keys(CODES);
const LETTERS = '?P\\-sTMxE!';
/**
 * Exactly the website's pattern (`GraderCommentHelper::VERDICT_STRING_RE`):
 * runs of known codes and `[...]` groups of known codes. Anything else
 * (free text, unknown codes, nested or unbalanced brackets) is not a strip.
 */
export const VERDICT_STRING_RE = new RegExp(`^(?:[${LETTERS}]+|\\[[${LETTERS}]+\\])+$`);

/** Group tooltip hint, as on the website. */
export const GROUP_HINT = 'Tests in a box are scored together — the box earns the lowest score inside it.';

/**
 * Turn a grader comment such as `PP-T[Px]` into one verdict per test, in order.
 * Returns `[]` when the comment is not a verdict strip: show it as plain text.
 */
export function parseGraderComment(comment: string | null | undefined): Verdict[] {
  const c = (comment ?? '').trim();
  if (!c || !VERDICT_STRING_RE.test(c)) return [];
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
    const v: Verdict = { index: i + 1, ok: known.kind === 'correct', kind: known.kind, label: `Test ${i + 1} of ${n}: ${known.word}` };
    if (t.group !== undefined) v.group = t.group;
    return v;
  });
}

/** "Group 2 of 3: 2/3 passed. Tests in a box are …" (passed = tiles with code P, as on the website). */
export function groupLabel(group: number, groupCount: number, members: Pick<Verdict, 'ok'>[]): string {
  return `Group ${group} of ${groupCount}: ${members.filter((m) => m.ok).length}/${members.length} passed. ${GROUP_HINT}`;
}

/** Legend rows ("Reading the results"). */
export const VERDICT_LEGEND: readonly { code: string; kind: string; word: string }[] = Object.entries(CODES).map(([code, v]) => ({ code, ...v }));

const WORDS: Readonly<Record<string, string>> = Object.fromEntries(Object.values(CODES).map((c) => [c.kind, c.word]));

/** Word for an evaluation `result` kind (`correct` → `Correct`), or the raw kind. */
export function resultWord(kind: string | null | undefined): string {
  return (kind && WORDS[kind]) || kind || 'Unknown';
}
