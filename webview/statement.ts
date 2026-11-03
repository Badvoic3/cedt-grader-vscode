import { PANEL } from '../src/shared/constants';
/*
 * Read-only statement viewer: bundled pdf.js (no CDN), worker loaded from the
 * extension's media folder via a blob URL, strict CSP. Zoom, fit width, page
 * navigation, text selection and search (Cmd/Ctrl+F).
 */
import './lang'; // first: sets the display language before anything below builds elements
import { W } from '../src/shared/strings';
import { pdfjsLib } from './pdfjs-global';
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { FromStatement, StatementViewState, ToStatement } from '../src/ui/statementPanel';
import { extractSampleTables } from './sampleExtract';
import type { SampleTable } from './sampleTables';
import { renderSamples, type SamplesState } from './samplesPreview';
import { buildToolbar, el } from './statementToolbar';
import { installTooltips } from './tooltip';
import { clampScale, handleZoomWheel, zoomKey } from './zoom';

interface Persisted extends StatementViewState {
  problemId: number;
  name: string;
}
declare function acquireVsCodeApi(): { postMessage(m: FromStatement): void; getState(): Persisted | undefined; setState(s: Persisted): void };
const vscode = acquireVsCodeApi();
/** Restored by VS Code when the tab is revived after a restart (used by the panel serializer too). */
let persisted: Persisted | undefined = vscode.getState();
const send = (m: FromStatement) => vscode.postMessage(m);

const app = document.getElementById('app')!;
const body = document.body;

const tb = buildToolbar({
  zoomOut: () => zoom(1 / 1.15),
  zoomIn: () => zoom(1.15),
  fitWidth: () => viewer && (viewer.currentScaleValue = 'page-width'),
  prevPage: () => viewer && viewer.currentPageNumber > 1 && (viewer.currentPageNumber -= 1),
  nextPage: () => viewer && viewer.currentPageNumber < viewer.pagesCount && (viewer.currentPageNumber += 1),
  prevMatch: () => find(true, true),
  nextMatch: () => find(true, false),
  refresh: () => send({ type: 'refresh' }),
  openInBrowser: () => send({ type: 'openInBrowser' }),
  importSamples: () => void toggleSamples(),
});
const { toolbar, pageInput, pageCount, zoomLabel, search, matches, titleEl } = tb;
const container = el('div', { id: 'viewerContainer', tabindex: '0' }, el('div', { id: 'viewer', class: 'pdfViewer' }));
const textView = el('div', { class: 'text-view' });
const status = el('div', { class: 'status', role: 'status' });
const noteEl = el('div', { class: 'note', role: 'status' });
noteEl.hidden = true;
const samplesEl = el('div', { class: 'samples-host' });
app.append(toolbar, noteEl, status, container, textView, samplesEl);
installTooltips(document);

// -------------------------------------------------------------------- pdf

let viewer: PDFViewer | null = null;
/** The document shown (the sample reader uses it: no second parse, no request). */
let pdfDoc: Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']> | null = null;
let eventBus: EventBus | null = null;
let linkService: PDFLinkService | null = null;
let workerReady: Promise<void> | null = null;
/** View to restore once pages are laid out (after reopen / restart). */
let restoreView: StatementViewState | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Remember page, zoom and scroll: in the webview (restart) and in the extension (tab closed and reopened). */
function saveView(): void {
  if (!viewer || !persisted) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!viewer || !persisted) return;
    const v: StatementViewState = {
      page: viewer.currentPageNumber,
      scale: String(viewer.currentScaleValue),
      scrollTop: container.scrollTop,
      scrollLeft: container.scrollLeft,
    };
    persisted = { ...persisted, ...v };
    vscode.setState(persisted);
    send({ type: 'viewState', state: v });
  }, PANEL.statementStateSaveMs);
}

/** Start the pdf.js worker from the media folder through a blob URL (CSP: worker-src blob:). */
function startWorker(): Promise<void> {
  workerReady ??= (async () => {
    const res = await fetch(body.dataset.worker!);
    const url = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(url, { type: 'module' });
  })();
  return workerReady;
}

function setupViewer(): PDFViewer {
  if (viewer) return viewer;
  eventBus = new EventBus();
  linkService = new PDFLinkService({ eventBus });
  const findController = new PDFFindController({ eventBus, linkService });
  viewer = new PDFViewer({ container, eventBus, linkService, findController });
  linkService.setViewer(viewer);
  eventBus.on('pagesinit', () => {
    const st = restoreView;
    restoreView = null;
    viewer!.currentScaleValue = st?.scale ?? 'page-width';
    if (st) {
      viewer!.currentPageNumber = Math.min(Math.max(1, st.page), viewer!.pagesCount);
      requestAnimationFrame(() => container.scrollTo(st.scrollLeft, st.scrollTop));
    }
  });
  eventBus.on('scalechanging', () => saveView());
  eventBus.on('pagechanging', () => saveView());
  eventBus.on('pagechanging', (e: { pageNumber: number }) => {
    pageInput.value = String(e.pageNumber);
  });
  eventBus.on('scalechanging', (e: { scale: number }) => {
    zoomLabel.textContent = `${Math.round(e.scale * 100)}%`;
  });
  eventBus.on('updatefindmatchescount', (e: { matchesCount: { current: number; total: number } }) => showMatches(e.matchesCount));
  eventBus.on('updatefindcontrolstate', (e: { matchesCount?: { current: number; total: number }; state: number }) => {
    if (e.matchesCount) showMatches(e.matchesCount);
    if (e.state === 1 && search.value) matches.textContent = W.noMatches;
  });
  return viewer;
}

function showMatches(c: { current: number; total: number }): void {
  matches.textContent = c.total ? W.matchOf(c.current, c.total) : search.value ? W.noMatches : '';
}

async function showPdf(data: Uint8Array): Promise<void> {
  await startWorker();
  const v = setupViewer();
  const doc = await pdfjsLib.getDocument({
    data,
    cMapUrl: body.dataset.cmaps,
    cMapPacked: true,
    standardFontDataUrl: body.dataset.fonts,
    isEvalSupported: false, // strict CSP: no eval
  }).promise;
  pdfDoc = doc;
  v.setDocument(doc);
  linkService!.setDocument(doc, null);
  pageCount.textContent = `/ ${doc.numPages}`;
  pageInput.max = String(doc.numPages);
}

function zoom(f: number, origin?: [number, number]): void {
  if (!viewer) return;
  const target = clampScale(viewer.currentScale * f);
  if (target === viewer.currentScale) return;
  // updateScale keeps the point under the cursor in place (pdf.js ≥ 4).
  viewer.updateScale({ scaleFactor: target / viewer.currentScale, origin, drawingDelay: origin ? 300 : 0 });
}

// Pinch (Ctrl+wheel) zooms around the cursor; preventDefault stops VS Code's own zoom.
container.addEventListener('wheel', (e) => handleZoomWheel(e, (f, o) => zoom(f, o)), { passive: false });
container.addEventListener('scroll', () => saveView(), { passive: true });

function find(again: boolean, previous: boolean): void {
  if (!eventBus) return;
  eventBus.dispatch('find', {
    source: null,
    type: again ? 'again' : '',
    query: search.value,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: previous,
    matchDiacritics: false,
  });
}

pageInput.addEventListener('change', () => {
  const n = Number(pageInput.value);
  if (viewer && n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n;
});
search.addEventListener('input', () => find(false, false));
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    find(true, e.shiftKey);
  } else if (e.key === 'Escape') {
    search.value = '';
    find(false, false);
    container.focus();
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && samplesOpen) {
    e.preventDefault();
    closeSamples();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && body.classList.contains('mode-pdf')) {
    e.preventDefault();
    search.focus();
    search.select();
  } else if (body.classList.contains('mode-pdf')) {
    const k = zoomKey(e);
    if (!k) return;
    e.preventDefault();
    if (k === 'in') zoom(1.15);
    else if (k === 'out') zoom(1 / 1.15);
    else if (viewer) viewer.currentScaleValue = 'page-width';
  }
});

// ------------------------------------------- sample cases (experimental)

/** Read once per document; the drawer shows the preview, Import sends the cases to the extension. */
let samples: Promise<SampleTable[]> | null = null;
let samplesOpen = false;

function showSamples(state: SamplesState | null): void {
  samplesOpen = !!state;
  samplesEl.replaceChildren(
    ...(state
      ? [
          renderSamples(state, {
            close: () => closeSamples(),
            importCases: (cases) => {
              if (persisted) send({ type: 'importSamples', problemId: persisted.problemId, cases });
              closeSamples();
            },
          }),
        ]
      : []),
  );
}

function closeSamples(): void {
  if (!samplesOpen) return;
  showSamples(null);
  tb.samplesBtn.focus();
}

async function toggleSamples(): Promise<void> {
  if (samplesOpen) return closeSamples();
  const doc = pdfDoc;
  if (!doc) return;
  showSamples({ kind: 'reading' });
  samples ??= extractSampleTables(doc, pdfjsLib.OPS);
  try {
    const tables = await samples;
    if (samplesOpen && pdfDoc === doc) showSamples({ kind: 'tables', tables });
  } catch (err) {
    samples = null;
    if (samplesOpen && pdfDoc === doc) showSamples({ kind: 'error', why: err instanceof Error ? err.message : String(err) });
  }
  samplesEl.querySelector<HTMLElement>('.samples .text-btn.primary, .samples .tb')?.focus();
}

// --------------------------------------------------------------- messages

function mode(m: 'loading' | 'pdf' | 'html' | 'message'): void {
  body.className = `mode-${m}`;
}

window.addEventListener('message', (ev: MessageEvent<ToStatement>) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'loading' || m.type === 'pdf') {
    showSamples(null); // a new document: read its tables again when asked
    samples = null;
    pdfDoc = null;
  }
  titleEl.textContent = m.title;
  noteEl.textContent = m.note ?? '';
  noteEl.hidden = !m.note;
  if (!persisted || persisted.problemId !== m.problemId) persisted = { problemId: m.problemId, name: m.name, page: 1, scale: 'page-width', scrollTop: 0, scrollLeft: 0 };
  vscode.setState(persisted);
  status.textContent = '';
  status.classList.remove('error');
  if (m.type === 'loading') {
    mode('loading');
    status.textContent = W.loadingStatement;
  } else if (m.type === 'pdf') {
    mode('pdf');
    restoreView = m.view ?? (persisted && persisted.problemId === m.problemId ? persisted : null);
    showPdf(m.data).catch((err) => {
      mode('message');
      status.classList.add('error');
      status.textContent = W.pdfError(err instanceof Error ? err.message : err);
    });
  } else if (m.type === 'html') {
    mode('html');
    // Rendered in the extension host with markdown-it (raw HTML disabled) or escaped text.
    textView.innerHTML = m.html;
  } else {
    mode('message');
    status.textContent = m.text;
    status.classList.toggle('error', m.error);
  }
});

send({ type: 'ready' });

window.addEventListener('beforeunload', () => saveView());
