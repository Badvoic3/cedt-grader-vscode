/**
 * Statement sample reader (src/data/sampleTables.ts) on synthetic
 * segments and text items shaped like the course PDFs (Word tables). The real
 * PDFs are checked locally with scripts/checkSamples.ts (never committed).
 */
import { describe, expect, it } from 'vitest';
import {
  addPageTables,
  baseFontName,
  cellText,
  fontId,
  gridsOf,
  isHeaderRow,
  mainFontOf,
  cellsOf,
  pathSegments,
  samplesFrom,
  stripNotes,
  type PathOps,
  type Seg,
  type Table,
  type TextItem,
} from '../src/data/sampleTables';

const OPS: PathOps = {
  save: 10, restore: 11, transform: 12, constructPath: 91, moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17, closePath: 18, rectangle: 19,
  fill: 22, eoFill: 23, stroke: 20, closeStroke: 21, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28,
};
const PAGE = { w: 595, h: 842 };

/** A Word-style ruled table: every border drawn as short thin filled pieces. */
function wordTable(xs: number[], ys: number[], pieces = 3): Seg[] {
  const segs: Seg[] = [];
  for (const y of ys) {
    const step = (xs[xs.length - 1] - xs[0]) / pieces;
    for (let i = 0; i < pieces; i++) segs.push({ rect: [xs[0] + i * step, y - 0.25, xs[0] + (i + 1) * step + 0.5, y + 0.25], paint: 'fill' });
  }
  for (const x of xs) for (let i = 0; i + 1 < ys.length; i++) segs.push({ rect: [x - 0.25, ys[i + 1], x + 0.25, ys[i]], paint: 'fill' });
  return segs;
}

const T = (str: string, x: number, y: number, font = 'Courier@11.0', h = 11): TextItem => ({ str, x, y, w: str.length * h * 0.6, h, font });

describe('rules from the operator list', () => {
  it('rects and lines under the CTM, tagged with the paint op; endPath drops the path', () => {
    const fn = [OPS.save, OPS.transform, OPS.constructPath, OPS.fill, OPS.restore, OPS.constructPath, OPS.stroke, OPS.constructPath, OPS.endPath];
    const args = [
      null,
      [1, 0, 0, 1, 100, 200],
      [[OPS.rectangle], [0, 0, 50, 1]],
      null,
      null,
      [[OPS.moveTo, OPS.lineTo, OPS.lineTo, OPS.closePath], [0, 0, 10, 0, 10, 10]],
      null,
      [[OPS.rectangle], [0, 0, 500, 500]], // clipping path: never painted
      null,
    ];
    const segs = pathSegments(fn, args, OPS);
    expect(segs[0]).toEqual({ rect: [100, 200, 150, 201], paint: 'fill' });
    expect(segs.slice(1)).toEqual([
      { line: [0, 0, 10, 0], paint: 'stroke' },
      { line: [10, 0, 10, 10], paint: 'stroke' },
      { line: [10, 10, 0, 0], paint: 'stroke' },
    ]);
  });
});

describe('grids', () => {
  it('pieces of a rule are merged into one grid', () => {
    expect(gridsOf(wordTable([50, 250, 450], [700, 680, 620]), PAGE.w, PAGE.h)).toHaveLength(1);
    const [g] = gridsOf(wordTable([50, 250, 450], [700, 680, 620], 7), PAGE.w, PAGE.h);
    expect(g.xs).toEqual([50, 250, 450]);
    expect(g.ys.map(Math.round)).toEqual([700, 680, 620]);
  });

  it('cell shading (a big filled rect) adds no rows; a stroked rect is a cell box', () => {
    const shaded = [...wordTable([50, 250, 450], [700, 680, 620]), { rect: [50, 680, 450, 700], paint: 'fill' } as Seg, { rect: [60, 630, 240, 660], paint: 'fill' } as Seg];
    expect(gridsOf(shaded, PAGE.w, PAGE.h)[0].ys.map(Math.round)).toEqual([700, 680, 620]);
    const boxes: Seg[] = [{ rect: [50, 600, 250, 640], paint: 'stroke' }, { rect: [250, 600, 450, 640], paint: 'stroke' }];
    expect(gridsOf(boxes, PAGE.w, PAGE.h)).toEqual([{ ys: [640, 600], xs: [50, 250, 450] }]);
  });

  it('a page-sized frame and a lone box with one column are not tables', () => {
    expect(gridsOf([{ rect: [5, 5, 590, 837], paint: 'stroke' }], PAGE.w, PAGE.h)).toEqual([]);
    expect(gridsOf([{ rect: [50, 600, 450, 640], paint: 'stroke' }], PAGE.w, PAGE.h)).toEqual([]); // 2 column lines only
  });
});

describe('cells and tables', () => {
  const header = [T('Input', 60, 685, 'Arial@11.0'), T('Output', 260, 685, 'Arial@11.0')];

  it('a header box followed by one box per case joins into one table', () => {
    const tables: Table[] = [];
    const grids = [
      ...gridsOf(wordTable([50, 250, 450], [700, 680]), PAGE.w, PAGE.h),
      ...gridsOf(wordTable([50, 250, 450], [670, 630]), PAGE.w, PAGE.h),
      ...gridsOf(wordTable([50, 250, 450], [620, 580]), PAGE.w, PAGE.h),
    ];
    addPageTables(tables, 1, grids, [...header, T('3', 60, 650), T('1 2 3', 60, 638), T('6', 260, 650), T('5', 60, 600), T('15', 260, 600)]);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toEqual([['Input', 'Output'], ['3\n1 2 3', '6'], ['5', '15']]);
    expect(samplesFrom(tables)).toEqual([{ page: 1, cases: [{ input: '3\n1 2 3', output: '6', annotated: false }, { input: '5', output: '15', annotated: false }] }]);
  });

  it('a header-less table on the next page with the same columns continues the sample table', () => {
    const tables: Table[] = [];
    addPageTables(tables, 1, gridsOf(wordTable([50, 250, 450], [700, 680, 640]), PAGE.w, PAGE.h), [...header, T('1', 60, 660), T('2', 260, 660)]);
    addPageTables(tables, 2, gridsOf(wordTable([50, 250, 450], [800, 760]), PAGE.w, PAGE.h), [T('7', 60, 780), T('8', 260, 780)]);
    expect(tables).toHaveLength(2);
    expect(samplesFrom(tables)).toEqual([{ page: 1, cases: [{ input: '1', output: '2', annotated: false }, { input: '7', output: '8', annotated: false }] }]);
  });

  it('the main font is the one with the most ASCII characters below the first row', () => {
    const g = { ys: [700, 680, 600], xs: [50, 250, 450] };
    const cells = cellsOf(g, [...header, T('1 2 3 4', 60, 650), T('10', 260, 650), T('หมายเหตุ', 120, 620, 'Thai@9.0', 9), T('->', 200, 640, 'Arial@9.0', 9)]);
    expect(mainFontOf(cells)).toBe('Courier@11.0');
  });
});

describe('cell text: runs and the main-font filter', () => {
  const main = 'Courier@11.0';

  it('a callout set apart beside the data is dropped', () => {
    expect(cellText([T('5', 60, 650), T('3 -> 5 -> 14 -> 20', 160, 650, 'Arial@9.0', 9)], main)).toBe('5');
  });

  it('a Thai note on the same baseline in another font is dropped', () => {
    expect(cellText([T('a 1', 60, 650), T('เพิ่ม 1 เข้าคิว', 100, 650, 'Tahoma@10.0', 10)], main)).toBe('a 1');
  });

  it('a lone value in another size at the cell edge is kept', () => {
    expect(cellText([T('9', 60, 650, 'Courier@10.5', 10.5), T('9999 B+', 60, 637)], main)).toBe('9\n9999 B+');
  });

  it('lines by baseline, words joined with a space at a gap, whitespace collapsed', () => {
    const it2 = (str: string, x: number, y: number) => ({ str, x, y, w: str.length * 6, h: 10, font: main });
    expect(cellText([it2('10', 60, 650), it2('20', 75, 650.5), it2('x', 60, 638), it2('  ', 66, 638)], main)).toBe('10 20\nx');
  });

  it('`// …` notes with Thai text are removed and mark the case', () => {
    expect(stripNotes('a 5\np // พิมพ์คิว\nq')).toEqual({ text: 'a 5\np\nq', annotated: true });
    expect(stripNotes('x = 1 // plain comment')).toEqual({ text: 'x = 1 // plain comment', annotated: false });
  });

  it('font ids: subset prefix stripped, size from the text matrix', () => {
    expect(baseFontName('ABCDEF+CourierNewPSMT')).toBe('CourierNewPSMT');
    expect(fontId('QWERTY+Courier', [11, 0, 0, 11, 0, 0])).toBe('Courier@11.0');
    expect(fontId('ASDFGH+Courier', [11, 0, 0, 11, 5, 5])).toBe(fontId('ZXCVBN+Courier', [11, 0, 0, 11, 9, 9]));
  });
});

describe('which tables are samples', () => {
  const table = (rows: string[][], cols = rows[0].length, pageNo = 1): Table => ({ pageNo, rows, xs: Array.from({ length: cols + 1 }, (_, i) => 50 + i * 100), bottom: 0 });

  it('header rows: Thai letters (even garbled) or input / output', () => {
    expect(isHeaderRow(['ข้อมูลเข้า', 'ข้อมูลออก'])).toBe(true);
    expect(isHeaderRow(['Input', 'Output'])).toBe(true);
    expect(isHeaderRow(['3', '6'])).toBe(false);
  });

  it('function-call tables are rejected (6 columns; non-ASCII values)', () => {
    const six = table([['ค่าใน vector v', 'a', 'b', 'm', 'ค่าที่คืน', 'v หลังเรียก'], ['{1,2,3}', '0', '1', '0', 'false', '{1,2,3}'], ['{1,2,3}', '0', '1', '1', 'true', '{2,1,3}']]);
    const quotes = table([['CP::pair<int,string> a', 'CP::pair<int,string> b', 'a >= b'], ['{5, “yes”}', '{1, “haha”}', 'true'], ['{9, “no”}', '{9, “zzz”}', 'false']]);
    expect(samplesFrom([six, quotes])).toEqual([]);
  });

  it('needs an input in at least half the body rows; a Thai-text table is not a sample', () => {
    expect(samplesFrom([table([['Input', 'Output'], ['', 'x'], ['', 'y'], ['1', '2']])])).toEqual([]);
    expect(samplesFrom([table([['ตัวอย่าง', 'คำอธิบาย'], ['ข้อความภาษาไทย', 'อธิบาย']])])).toEqual([]);
    expect(samplesFrom([table([['Input', 'Output', 'Note'], ['1', '2', 'x']])])).toEqual([{ page: 1, cases: [{ input: '1', output: '2', annotated: false }] }]);
  });
});
