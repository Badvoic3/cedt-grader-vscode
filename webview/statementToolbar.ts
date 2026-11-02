/** Statement viewer toolbar (plain DOM; separate so it is tested without pdf.js). */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

const icon = (n: string) => el('span', { class: `codicon codicon-${n}`, 'aria-hidden': 'true' });

/** Icon-only toolbar button: tooltip (custom component, `data-tip`) and the same aria-label. */
export function btn(name: string, label: string, onclick: () => void): HTMLButtonElement {
  const b = el('button', { class: 'tb', type: 'button', 'data-tip': label, 'aria-label': label }, icon(name));
  b.addEventListener('click', onclick);
  return b;
}

export interface ToolbarHandlers {
  zoomOut(): void;
  zoomIn(): void;
  fitWidth(): void;
  prevPage(): void;
  nextPage(): void;
  prevMatch(): void;
  nextMatch(): void;
  refresh(): void;
  openInBrowser(): void;
}

export function buildToolbar(h: ToolbarHandlers) {
  const pageInput = el('input', { class: 'page', type: 'number', min: '1', value: '1', 'aria-label': W.pageNumber, 'data-tip': W.pageNumber });
  const pageCount = el('span', { class: 'muted' }, '/ –');
  const zoomLabel = el('span', { class: 'muted zoom', 'data-tip': W.zoomLevel }, '');
  const search = el('input', { class: 'search', type: 'search', placeholder: W.findInStatement, 'aria-label': W.findInStatement, 'data-tip': W.findInStatementCmdCtrl });
  const matches = el('span', { class: 'muted matches' }, '');
  const titleEl = el('span', { class: 'title' }, '');
  const pdfTools = el('div', { class: 'group pdf-only' },
    btn('zoom-out', W.zoomOutCmdCtrl, h.zoomOut),
    zoomLabel,
    btn('zoom-in', W.zoomInCmdCtrl, h.zoomIn),
    btn('screen-full', W.fitWidthCmdCtrl0, h.fitWidth),
    el('span', { class: 'sep' }),
    btn('chevron-up', W.previousPage, h.prevPage),
    pageInput,
    pageCount,
    btn('chevron-down', W.nextPage, h.nextPage),
    el('span', { class: 'sep' }),
    search,
    btn('arrow-up', W.previousMatchShiftEnter, h.prevMatch),
    btn('arrow-down', W.nextMatchEnter, h.nextMatch),
    matches,
  );
  const toolbar = el('div', { class: 'toolbar', role: 'toolbar', 'aria-label': W.statement },
    titleEl,
    pdfTools,
    el('span', { class: 'grow' }),
    btn('refresh', W.refreshDownloadAgain, h.refresh),
    btn('globe', W.openInBrowser, h.openInBrowser),
  );
  return { toolbar, pageInput, pageCount, zoomLabel, search, matches, titleEl };
}import { W } from '../src/shared/strings';

