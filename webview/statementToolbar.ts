/** Statement viewer toolbar (plain DOM; separate so it is tested without pdf.js). */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

const icon = (n: string) => el('span', { class: `codicon codicon-${n}`, 'aria-hidden': 'true' });

/** Icon-only toolbar button: tooltip and the same aria-label. */
export function btn(name: string, label: string, onclick: () => void): HTMLButtonElement {
  const b = el('button', { class: 'tb', type: 'button', title: label, 'aria-label': label }, icon(name));
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
  const pageInput = el('input', { class: 'page', type: 'number', min: '1', value: '1', 'aria-label': 'Page number', title: 'Page number' });
  const pageCount = el('span', { class: 'muted' }, '/ –');
  const zoomLabel = el('span', { class: 'muted zoom', title: 'Zoom level' }, '');
  const search = el('input', { class: 'search', type: 'search', placeholder: 'Find in statement', 'aria-label': 'Find in statement', title: 'Find in statement (Cmd/Ctrl+F)' });
  const matches = el('span', { class: 'muted matches' }, '');
  const titleEl = el('span', { class: 'title' }, '');
  const pdfTools = el('div', { class: 'group pdf-only' },
    btn('zoom-out', 'Zoom out (Cmd/Ctrl -)', h.zoomOut),
    zoomLabel,
    btn('zoom-in', 'Zoom in (Cmd/Ctrl +)', h.zoomIn),
    btn('screen-full', 'Fit width (Cmd/Ctrl 0)', h.fitWidth),
    el('span', { class: 'sep' }),
    btn('chevron-up', 'Previous page', h.prevPage),
    pageInput,
    pageCount,
    btn('chevron-down', 'Next page', h.nextPage),
    el('span', { class: 'sep' }),
    search,
    btn('arrow-up', 'Previous match (Shift+Enter)', h.prevMatch),
    btn('arrow-down', 'Next match (Enter)', h.nextMatch),
    matches,
  );
  const toolbar = el('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Statement' },
    titleEl,
    pdfTools,
    el('span', { class: 'grow' }),
    btn('refresh', 'Refresh (download again)', h.refresh),
    btn('globe', 'Open in browser', h.openInBrowser),
  );
  return { toolbar, pageInput, pageCount, zoomLabel, search, matches, titleEl };
}
