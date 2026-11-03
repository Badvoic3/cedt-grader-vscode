/*
 * Experimental: sample input/output tables read from a statement PDF.
 *
 * Pure functions over plain arrays (pdf.js operator lists and text items are
 * turned into these by webview/sampleExtract.ts), so the geometry and the
 * cell rules are unit tested in Node and the local check script
 * (scripts/checkSamples.ts) runs the same code on real PDFs.
 *
 * Coordinates are PDF user space after the page CTM: points, y grows upwards.
 *   1. Rules from the drawing operators: thin filled rects (Word draws borders
 *      as many short pieces), stroked rects (cell boxes), straight lines.
 *      Big filled rects (cell shading, highlights) and page-sized rects are ignored.
 *   2. Collinear pieces merged; short leftovers dropped.
 *   3. Grids = touching H/V lines (union-find); ≥ 2 row lines and ≥ 3 column lines.
 *   4. Text items go to the cell holding their centre. A grid right below one
 *      with the same columns joins it (header box + one box per case).
 *   5. Main font of a table = the font with the most ASCII characters below the
 *      first row; callouts and notes in other fonts, set apart, are dropped.
 *   6. Sample table = 2–3 columns, at least half the body rows are cases with an
 *      input and ≥ 97 % ASCII. Thai text is often garbled (broken ToUnicode), so
 *      only its presence is used, never its words.
 */

export type Rect = [x0: number, y0: number, x1: number, y1: number];
export type Line = [ax: number, ay: number, bx: number, by: number];

/** A painted path piece: a rectangle or a straight line, with how it was painted. */
export interface Seg {
  rect?: Rect;
  line?: Line;
  paint: 'fill' | 'stroke';
}

/** A text item: x, y = baseline start, w / h in points, font = "<real name>@<size>". */
export interface TextItem {
  x: number;
  y: number;
  w: number;
  h: number;
  str: string;
  font: string;
}

/** Row lines top → bottom, column lines left → right. */
export interface Grid {
  ys: number[];
  xs: number[];
}

export interface Table {
  pageNo: number;
  /** Cell texts per row (empty rows dropped). */
  rows: string[][];
  xs: number[];
  /** y of the last row line (for stacking grids). */
  bottom: number;
}

export interface SampleCase {
  input: string;
  output: string;
  /** A note (`// …` with Thai text) was removed from this case: check it. */
  annotated: boolean;
}

export interface SampleTable {
  page: number;
  cases: SampleCase[];
}

/** The pdf.js `OPS` codes this module reads (passed in: no pdf.js import here). */
export interface PathOps {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  moveTo: number;
  lineTo: number;
  curveTo: number;
  curveTo2: number;
  curveTo3: number;
  closePath: number;
  rectangle: number;
  fill: number;
  eoFill: number;
  stroke: number;
  closeStroke: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
  endPath: number;
}

const TOL = 2.5;
/** A filled rect this thin (pt) in one direction is a rule. */
const RULE_MAX = 3;
const MIN_H_LINE = 10;
const MIN_V_LINE = 6;
/** A grid this close (pt) below one with the same columns continues it. */
const STACK_GAP = 24;
const SAME_X = 3;
const ASCII_MIN = 0.97;

type M = [number, number, number, number, number, number];
const mul = (a: M, b: number[]): M => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/**
 * Rectangles and straight lines of a page's operator list, under the CTM
 * (save / restore / transform), tagged with the paint operator that follows.
 * Paths ended without painting (`endPath`, clipping) are dropped; curves are skipped.
 */
export function pathSegments(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, ops: PathOps): Seg[] {
  const segs: Seg[] = [];
  let pending: Omit<Seg, 'paint'>[] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  const tp = (x: number, y: number): [number, number] => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  const fills = new Set([ops.fill, ops.eoFill]);
  const strokes = new Set([ops.stroke, ops.closeStroke, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  for (let k = 0; k < fnArray.length; k++) {
    const fn = fnArray[k];
    const args = argsArray[k] as unknown[] | null;
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() ?? ctm;
    else if (fn === ops.transform && args) ctm = mul(ctm, args as number[]);
    else if (fills.has(fn) || strokes.has(fn)) {
      const paint = fills.has(fn) ? 'fill' : 'stroke';
      for (const s of pending) segs.push({ ...s, paint });
      pending = [];
    } else if (fn === ops.endPath) pending = [];
    else if (fn === ops.constructPath && args) {
      const sub = args[0] as ArrayLike<number>;
      const coords = args[1] as ArrayLike<number>;
      let c = 0;
      let cur: [number, number] | null = null;
      let start: [number, number] | null = null;
      for (let i = 0; i < sub.length; i++) {
        const op = sub[i];
        if (op === ops.moveTo) {
          cur = start = tp(coords[c], coords[c + 1]);
          c += 2;
        } else if (op === ops.lineTo) {
          const p = tp(coords[c], coords[c + 1]);
          c += 2;
          if (cur) pending.push({ line: [cur[0], cur[1], p[0], p[1]] });
          cur = p;
        } else if (op === ops.rectangle) {
          const [x, y, w, h] = [coords[c], coords[c + 1], coords[c + 2], coords[c + 3]];
          c += 4;
          const a = tp(x, y);
          const b = tp(x + w, y + h);
          pending.push({ rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
        } else if (op === ops.curveTo) c += 6;
        else if (op === ops.curveTo2 || op === ops.curveTo3) c += 4;
        else if (op === ops.closePath && cur && start) {
          pending.push({ line: [cur[0], cur[1], start[0], start[1]] });
          cur = start;
        }
      }
    }
  }
  return segs;
}

const cluster = (vals: number[]): number[] => {
  const out: number[] = [];
  for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > TOL) out.push(v);
  return out;
};

interface HLine {
  y: number;
  x0: number;
  x1: number;
}
interface VLine {
  x: number;
  y0: number;
  y1: number;
}

/** Pieces on (nearly) the same coordinate whose spans touch (gap ≤ 4 pt) become one. */
export function mergeCollinear<T extends Record<K | L | H, number>, K extends string, L extends string, H extends string>(segs: T[], key: K, lo: L, hi: H): T[] {
  const out: T[] = [];
  for (const sg of [...segs].sort((a, b) => a[key] - b[key] || a[lo] - b[lo])) {
    const m = out.find((o) => Math.abs(o[key] - sg[key]) <= 1.5 && sg[lo] <= o[hi] + 4 && sg[hi] >= o[lo] - 4);
    if (m) {
      (m as Record<string, number>)[lo] = Math.min(m[lo], sg[lo]);
      (m as Record<string, number>)[hi] = Math.max(m[hi], sg[hi]);
    } else out.push({ ...sg });
  }
  return out;
}

/** Ruled grids of a page, top first. */
export function gridsOf(segs: Seg[], pageW: number, pageH: number): Grid[] {
  let H: HLine[] = [];
  let V: VLine[] = [];
  for (const s of segs) {
    if (s.rect) {
      const [x0, y0, x1, y1] = s.rect;
      const w = x1 - x0;
      const h = y1 - y0;
      if (w > pageW * 0.9 && h > pageH * 0.9) continue; // page background / frame
      if (h <= RULE_MAX && w >= h) H.push({ y: (y0 + y1) / 2, x0, x1 });
      else if (w <= RULE_MAX && h > w) V.push({ x: (x0 + x1) / 2, y0, y1 });
      else if (s.paint === 'stroke') {
        H.push({ y: y0, x0, x1 }, { y: y1, x0, x1 });
        V.push({ x: x0, y0, y1 }, { x: x1, y0, y1 });
      }
      // A big filled rect is cell shading or a highlight: ignored (it would add fake rows).
    } else if (s.line) {
      const [ax, ay, bx, by] = s.line;
      if (Math.abs(ay - by) <= 1) H.push({ y: (ay + by) / 2, x0: Math.min(ax, bx), x1: Math.max(ax, bx) });
      else if (Math.abs(ax - bx) <= 1) V.push({ x: (ax + bx) / 2, y0: Math.min(ay, by), y1: Math.max(ay, by) });
    }
  }
  H = mergeCollinear(H, 'y', 'x0', 'x1').filter((l) => l.x1 - l.x0 > MIN_H_LINE);
  V = mergeCollinear(V, 'x', 'y0', 'y1').filter((l) => l.y1 - l.y0 > MIN_V_LINE);
  // Union-find: H and V lines that touch belong to one grid.
  const parent = [...H, ...V].map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  H.forEach((a, i) =>
    V.forEach((b, j) => {
      if (b.x >= a.x0 - TOL && b.x <= a.x1 + TOL && a.y >= b.y0 - TOL && a.y <= b.y1 + TOL) parent[find(i)] = find(H.length + j);
    }),
  );
  const groups = new Map<number, { h: HLine[]; v: VLine[] }>();
  const group = (i: number) => {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { h: [], v: [] }));
    return g;
  };
  H.forEach((l, i) => group(i).h.push(l));
  V.forEach((l, j) => group(H.length + j).v.push(l));
  const grids: Grid[] = [];
  for (const g of groups.values()) {
    const ys = cluster(g.h.map((l) => l.y)).reverse(); // top → bottom
    const xs = cluster(g.v.map((l) => l.x));
    if (ys.length >= 2 && xs.length >= 3) grids.push({ ys, xs });
  }
  return grids.sort((a, b) => b.ys[0] - a.ys[0]);
}

/** Text items per cell (rows top → bottom), by the item's centre. */
export function cellsOf(g: Grid, items: TextItem[]): TextItem[][][] {
  const cells: TextItem[][][] = [];
  for (let r = 0; r + 1 < g.ys.length; r++) {
    const row: TextItem[][] = [];
    for (let c = 0; c + 1 < g.xs.length; c++) {
      row.push(
        items.filter((it) => {
          const cx = it.x + it.w / 2;
          const cy = it.y + it.h * 0.3;
          return cx > g.xs[c] && cx < g.xs[c + 1] && cy < g.ys[r] && cy > g.ys[r + 1];
        }),
      );
    }
    cells.push(row);
  }
  return cells;
}

/** The font with the most ASCII-only characters below the first row (sample data is set in one font). */
export function mainFontOf(cells: TextItem[][][]): string | null {
  const share = new Map<string, number>();
  for (const row of cells.slice(1))
    for (const cell of row)
      for (const it of cell) {
        const n = it.str.replace(/\s/g, '').length;
        if (!n || /[^\x20-\x7e]/.test(it.str)) continue;
        share.set(it.font, (share.get(it.font) ?? 0) + n);
      }
  return [...share].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * A cell's text: lines by baseline, each split into runs at wide gaps (or a
 * font change after a gap). With a main font, a run is kept when it has
 * main-font text or starts at the cell's left edge; callouts and notes set
 * beside the data are dropped.
 */
export function cellText(items: TextItem[], mainFont: string | null = null): string {
  const lines: { y: number; items: TextItem[] }[] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, it.h * 0.4));
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  const runsOf = (l: { items: TextItem[] }): TextItem[][] => {
    const runs: TextItem[][] = [];
    let end: number | null = null;
    let font: string | null = null;
    for (const it of [...l.items].sort((a, b) => a.x - b.x)) {
      if (!it.str.trim()) {
        if (runs.length) runs[runs.length - 1].push(it);
        continue;
      }
      const gap = end === null ? Infinity : it.x - end;
      if (gap > it.h * 3 || (it.font !== font && gap > it.h * 0.5)) runs.push([it]);
      else runs[runs.length - 1].push(it);
      end = Math.max(end ?? -Infinity, it.x + it.w);
      font = it.font;
    }
    return runs;
  };
  const all = lines.map((l) => ({ y: l.y, runs: runsOf(l) }));
  const starts = all.flatMap((l) => l.runs.map((r) => r[0].x));
  const margin = starts.length ? Math.min(...starts) : 0;
  const keep = (r: TextItem[]) => !mainFont || r.some((it) => it.font === mainFont && it.str.trim()) || r[0].x - margin <= r[0].h * 1.5;
  const join = (r: TextItem[]) => {
    let s = '';
    let end: number | null = null;
    for (const it of r) {
      if (end !== null && it.x - end > it.h * 0.15 && !s.endsWith(' ') && !it.str.startsWith(' ')) s += ' ';
      s += it.str;
      end = Math.max(end ?? -Infinity, it.x + it.w);
    }
    return s;
  };
  return all
    .sort((a, b) => b.y - a.y)
    .map((l) => l.runs.filter(keep).map(join).join(' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length)
    .join('\n');
}

/** Add one page's grids to `tables` (a grid right below one with the same columns joins it). */
export function addPageTables(tables: Table[], pageNo: number, grids: Grid[], items: TextItem[]): void {
  for (const g of grids) {
    const cells = cellsOf(g, items);
    const mainFont = mainFontOf(cells);
    const rows = cells.map((row, r) => row.map((cell) => cellText(cell, r === 0 ? null : mainFont)));
    const kept = rows.filter((r) => r.some((c) => c));
    const last = tables[tables.length - 1];
    if (last && last.pageNo === pageNo && sameXs(last.xs, g.xs) && last.bottom - g.ys[0] < STACK_GAP) {
      last.rows.push(...kept);
      last.bottom = g.ys[g.ys.length - 1];
    } else if (kept.length) tables.push({ pageNo, rows: kept, xs: g.xs, bottom: g.ys[g.ys.length - 1] });
  }
}

const sameXs = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < SAME_X);
const THAI = /[฀-๿]/;
const asciiShare = (s: string) => (s.length ? [...s].filter((ch) => ch <= '~').length / s.length : 1);

/** A header row: Thai letters, or "input" / "output" / "ตัวอย่าง". */
export function isHeaderRow(row: string[]): boolean {
  return row.some((c) => THAI.test(c) || /\b(input|output)\b/i.test(c));
}

/** Remove `// …` notes that contain Thai text (marks the case `annotated`). */
export function stripNotes(cell: string): { text: string; annotated: boolean } {
  let annotated = false;
  const text = cell
    .split('\n')
    .map((l) => {
      const m = /^(.*?)\s*\/\/.*[฀-๿].*$/.exec(l);
      if (!m) return l;
      annotated = true;
      return m[1];
    })
    .filter((l) => l.trim())
    .join('\n');
  return { text, annotated };
}

/** The sample tables among the extracted tables (a header-less table on the next page with the same columns continues one). */
export function samplesFrom(tables: Table[]): SampleTable[] {
  const out: SampleTable[] = [];
  let prev: Table | null = null;
  for (const t of tables) {
    const header = isHeaderRow(t.rows[0]);
    const body = header ? t.rows.slice(1) : t.rows;
    const cols = t.xs.length - 1;
    const cases = body
      .map((r) => {
        const a = stripNotes(r[0] ?? '');
        const b = stripNotes(r[1] ?? '');
        return { input: a.text, output: b.text, annotated: a.annotated || b.annotated };
      })
      .filter((c) => c.input && asciiShare(c.input + c.output) > ASCII_MIN);
    const ok = cols >= 2 && cols <= 3 && cases.length > 0 && cases.length >= body.length / 2;
    if (ok && !header && prev && prev.pageNo === t.pageNo - 1 && sameXs(prev.xs, t.xs)) out[out.length - 1].cases.push(...cases);
    else if (ok) out.push({ page: t.pageNo, cases });
    prev = ok ? t : null;
  }
  return out;
}

/** "ABCDEF+Courier" → "Courier" (one PDF has the same font as two subsets). */
export function baseFontName(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '');
}

/** Font id of a text item: real font name + size (from the text matrix). */
export function fontId(name: string, transform: number[]): string {
  return `${baseFontName(name)}@${Math.hypot(transform[0], transform[1]).toFixed(1)}`;
}
