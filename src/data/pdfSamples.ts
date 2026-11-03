import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { S } from '../shared/strings';
import { addPageTables, fontId, gridsOf, pathSegments, samplesFrom, type PathOps, type SampleTable, type Table, type TextItem } from './sampleTables';

/*
 * "Load sample cases": read the example tables of a statement PDF in the
 * extension host with the pdf.js legacy build (Node). pdf.js is not part of
 * dist/extension.js: its library is copied to dist/pdfjs/ by the build and
 * imported on first use only, so activation never loads it. The worker module
 * is the statement viewer's (media/dist/pdfjs, the same legacy build), so it
 * is packed once. In Node pdf.js
 * runs its "fake worker" (the worker module imported into this thread).
 * Nothing here sends a request: no font or CMap URLs are given.
 */

/** The bits of a pdf.js page this needs. */
interface PageLike {
  view: number[];
  getOperatorList(): Promise<{ fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }>;
  getTextContent(): Promise<{ items: unknown[] }>;
  commonObjs: { get(id: string, cb?: (v: unknown) => void): unknown };
}
interface DocLike {
  numPages: number;
  getPage(n: number): Promise<PageLike>;
  destroy(): Promise<void>;
}
interface RawItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
}

/** The parts of the pdf.js module used here. */
export interface Pdfjs {
  getDocument(src: { data: Uint8Array; isEvalSupported: boolean; verbosity: number; isOffscreenCanvasSupported: boolean }): { promise: Promise<DocLike>; destroy?(): Promise<void> };
  OPS: PathOps;
  GlobalWorkerOptions: { workerSrc: string };
}

/**
 * Limits for reading a statement in the host thread (course statements have
 * fewer than 20 pages and read in ~10–90 ms). Past either one nothing is
 * loaded (`SampleReadLimitError`): a hostile or huge PDF can't keep the
 * extension host busy. The time is checked between pages, and the wait for
 * one page stops when the budget is used up.
 */
export const SAMPLE_READ = {
  maxPages: 100,
  timeBudgetMs: 10_000,
} as const;

/** The statement has more pages than `SAMPLE_READ.maxPages`, or reading it took longer than the time budget. */
export class SampleReadLimitError extends Error {}

/** File names of pdf.js's legacy build (node_modules/pdfjs-dist/legacy/build): the library in dist/pdfjs, the worker in media/dist/pdfjs. */
export const PDFJS_FILES = { lib: 'pdf.min.mjs', worker: 'pdf.worker.min.mjs' } as const;

/**
 * Loads pdf.js on the first call (later calls share it; a failed load is tried
 * again next time): the library from `dir`, the worker module from `workerDir`.
 */
export function pdfjsLoader(dir: string, workerDir = dir): () => Promise<Pdfjs> {
  let loading: Promise<Pdfjs> | null = null;
  return () =>
    (loading ??= (async () => {
      const lib = (await import(pathToFileURL(join(dir, PDFJS_FILES.lib)).href)) as Pdfjs;
      lib.GlobalWorkerOptions.workerSrc = pathToFileURL(join(workerDir, PDFJS_FILES.worker)).href;
      return lib;
    })().catch((err: unknown) => {
      loading = null;
      throw err;
    }));
}

/** A font's real name (pdf.js has it after the page's operator list); the id when it doesn't arrive. */
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

/**
 * The sample tables of a PDF (per page: operator list → grids; text only on
 * pages with grids). Throws SampleReadLimitError past `limits`.
 */
export async function readSampleTables(
  bytes: Uint8Array,
  pdfjs: Pdfjs,
  limits: { maxPages: number; timeBudgetMs: number; now?: () => number } = SAMPLE_READ,
): Promise<SampleTable[]> {
  const now = limits.now ?? (() => Date.now());
  const deadline = now() + limits.timeBudgetMs;
  /** `p`, unless the budget runs out first. */
  const inTime = async <T>(p: Promise<T>): Promise<T> => {
    const left = deadline - now();
    if (left <= 0) throw new SampleReadLimitError(S.samples.tooLong);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SampleReadLimitError(S.samples.tooLong)), left);
    });
    try {
      return await Promise.race([p, late]);
    } finally {
      clearTimeout(timer);
    }
  };
  // A copy: pdf.js may detach the buffer it is given.
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0, isOffscreenCanvasSupported: false });
  let doc: DocLike;
  try {
    doc = await inTime(task.promise);
  } catch (err) {
    void task.destroy?.().catch(() => {});
    throw err;
  }
  try {
    if (doc.numPages > limits.maxPages) throw new SampleReadLimitError(S.samples.tooLong);
    const tables: Table[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await inTime(doc.getPage(p));
      const [, , pw, ph] = page.view;
      const opList = await inTime(page.getOperatorList()); // also loads the page's fonts into commonObjs
      const grids = gridsOf(pathSegments(opList.fnArray, opList.argsArray, pdfjs.OPS), pw, ph);
      if (!grids.length) continue;
      const raw = ((await inTime(page.getTextContent())).items as RawItem[]).filter((i) => i.str && i.transform);
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
  } finally {
    await doc.destroy();
  }
}
