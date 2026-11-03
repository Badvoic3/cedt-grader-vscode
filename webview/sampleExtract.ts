/*
 * Experimental: read the sample tables of a PDF already opened with pdf.js
 * (the statement viewer's document; the check script passes its own).
 * No network, no second parse: operator lists and text content of each page.
 */
import { addPageTables, fontId, gridsOf, pathSegments, samplesFrom, type PathOps, type SampleTable, type Table, type TextItem } from './sampleTables';

/** The bits of a pdf.js page this needs (browser and Node builds alike). */
interface PageLike {
  view: number[];
  getOperatorList(): Promise<{ fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }>;
  getTextContent(): Promise<{ items: unknown[] }>;
  commonObjs: { get(id: string, cb?: (v: unknown) => void): unknown };
}
interface DocLike {
  numPages: number;
  getPage(n: number): Promise<PageLike>;
}
interface RawItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
}

/** Font objects arrive asynchronously in the browser (FontFace binding): wait a little, else use the id. */
const FONT_WAIT_MS = 1000;

function fontName(page: PageLike, id: string): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(id), FONT_WAIT_MS);
    try {
      page.commonObjs.get(id, (f) => {
        clearTimeout(timer);
        const name = (f as { name?: unknown } | null)?.name;
        resolve(typeof name === 'string' && name ? name : id);
      });
    } catch {
      clearTimeout(timer);
      resolve(id);
    }
  });
}

export async function extractSampleTables(doc: DocLike, ops: PathOps): Promise<SampleTable[]> {
  const tables: Table[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const [, , pw, ph] = page.view;
    const opList = await page.getOperatorList(); // also loads the page's fonts into commonObjs
    const grids = gridsOf(pathSegments(opList.fnArray, opList.argsArray, ops), pw, ph);
    if (!grids.length) continue;
    const raw = ((await page.getTextContent()).items as RawItem[]).filter((i) => i.str && i.transform);
    const names = new Map<string, string>();
    for (const id of new Set(raw.map((i) => i.fontName ?? ''))) names.set(id, await fontName(page, id));
    const items: TextItem[] = raw.map((i) => ({
      x: i.transform![4],
      y: i.transform![5],
      w: i.width ?? 0,
      h: i.height || Math.abs(i.transform![3]),
      str: i.str!,
      font: fontId(names.get(i.fontName ?? '') ?? '', i.transform!),
    }));
    addPageTables(tables, p, grids, items);
  }
  return samplesFrom(tables);
}
