import { normalizeLine, trailOf } from './lines';

/**
 * What differs between Expected and Actual, by the compare's rules: blank
 * lines and spaces at line ends don't count, so they are never marked. Lines
 * first, then words on changed lines only. Bounded: 64 KB of one-character
 * lines must not hang the page, so a big difference falls back to comparing
 * line by line in place, and a very long line to marking it whole.
 */

export interface DiffPart {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  /** From 1. Blank lines keep their number. */
  n: number;
  changed: boolean;
  parts: DiffPart[];
  /** Spaces at the line's end, as marks. */
  trail: string;
}

export interface OutputDiff {
  expected: DiffLine[];
  actual: DiffLine[];
}

const MAX_LINE_CELLS = 1_000_000;
const MAX_WORD_CELLS = 40_000;

const rawLines = (text: string): string[] => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

const marks = (trail: string): string => trail.replace(/\t/g, '→').replace(/[ \f\v]/g, '·');

function plainLine(raw: string, n: number): DiffLine {
  const trail = trailOf(raw);
  const body = raw.slice(0, raw.length - trail.length);
  return { n, changed: false, parts: body ? [{ text: body, changed: false }] : [], trail: marks(trail) };
}

/** Text as lines with nothing marked. */
export const plainLines = (text: string): DiffLine[] => rawLines(text).map((l, i) => plainLine(l, i + 1));

/** Pairs of equal items, in order; null when the middle is larger than `maxCells`. */
function matches(a: readonly string[], b: readonly string[], maxCells: number): [number, number][] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > maxCells) return null;
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  // Longest common subsequence, walked from the start so the first equal lines pair up.
  const w = m + 1;
  const t = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[start + i] === b[start + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      pairs.push([start + i, start + j]);
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
    else j++;
  }
  for (let k = 0; endA + k < a.length; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

const words = (body: string): string[] => body.match(/[ \t\f\v]+|[^ \t\f\v]+/g) ?? [];
const wordKey = (w: string): string => (/^[ \t\f\v]/.test(w) ? ' ' : w);

function joined(tokens: readonly string[], same: ReadonlySet<number>): DiffPart[] {
  const parts: DiffPart[] = [];
  tokens.forEach((text, i) => {
    const changed = !same.has(i);
    const last = parts.at(-1);
    if (last?.changed === changed) last.text += text;
    else parts.push({ text, changed });
  });
  return parts;
}

/** Mark the words that differ in two changed lines. */
function markWords(a: DiffLine, b: DiffLine): void {
  const left = a.parts.map((p) => p.text).join('');
  const right = b.parts.map((p) => p.text).join('');
  const [wa, wb] = [words(left), words(right)];
  const pairs = matches(wa.map(wordKey), wb.map(wordKey), MAX_WORD_CELLS) ?? [];
  a.parts = joined(wa, new Set(pairs.map((p) => p[0])));
  b.parts = joined(wb, new Set(pairs.map((p) => p[1])));
}

const wholeChanged = (l: DiffLine): void => {
  l.changed = true;
  for (const p of l.parts) p.changed = true;
};

export function diffOutputs(expected: string, actual: string): OutputDiff {
  const e = rawLines(expected);
  const a = rawLines(actual);
  const out: OutputDiff = { expected: e.map((l, i) => plainLine(l, i + 1)), actual: a.map((l, i) => plainLine(l, i + 1)) };

  // Blank lines take no part: they don't count in the compare.
  const counted = (lines: readonly string[]) => lines.flatMap((l, i) => (normalizeLine(l) ? [i] : []));
  const ei = counted(e);
  const ai = counted(a);
  const ek = ei.map((i) => normalizeLine(e[i]));
  const ak = ai.map((i) => normalizeLine(a[i]));
  // Too different to align: same place, same line.
  const pairs = matches(ek, ak, MAX_LINE_CELLS) ?? Array.from({ length: Math.min(ek.length, ak.length) }, (_, i) => [i, i] as [number, number]).filter(([i]) => ek[i] === ak[i]);

  let x = 0;
  let y = 0;
  for (const [px, py] of [...pairs, [ek.length, ak.length] as [number, number]]) {
    // Between two equal lines: pair what was replaced, the rest is only on one side.
    const both = Math.min(px - x, py - y);
    for (let k = 0; k < both; k++) {
      const l = out.expected[ei[x + k]];
      const r = out.actual[ai[y + k]];
      l.changed = r.changed = true;
      markWords(l, r);
    }
    for (let k = x + both; k < px; k++) wholeChanged(out.expected[ei[k]]);
    for (let k = y + both; k < py; k++) wholeChanged(out.actual[ai[k]]);
    x = px + 1;
    y = py + 1;
  }
  return out;
}
