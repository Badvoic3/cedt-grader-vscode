/*
 * Experimental "Import sample cases from this statement": the preview drawer
 * of the statement viewer (plain DOM, tested in jsdom). Every PDF text goes in
 * with textContent (el() appends strings as text nodes).
 */
import { W } from '../src/shared/strings';
import type { SampleCase, SampleTable } from './sampleTables';
import { btn, el } from './statementToolbar';

export type SamplesState = { kind: 'reading' } | { kind: 'error'; why: string } | { kind: 'tables'; tables: SampleTable[] };

export interface SamplesHandlers {
  importCases(cases: SampleCase[]): void;
  close(): void;
}

export function allCases(tables: SampleTable[]): (SampleCase & { page: number })[] {
  return tables.flatMap((t) => t.cases.map((c) => ({ ...c, page: t.page })));
}

function textButton(label: string, onclick: () => void, primary = false): HTMLButtonElement {
  const b = el('button', { type: 'button', class: primary ? 'text-btn primary' : 'text-btn' }, label);
  b.addEventListener('click', onclick);
  return b;
}

function block(label: string, text: string): HTMLElement {
  return el('div', { class: 'sample-io' }, el('div', { class: 'sample-label muted' }, label), el('pre', { class: text ? 'sample-text' : 'sample-text muted' }, text || W.samplesEmpty));
}

/** The drawer's content for a state. */
export function renderSamples(state: SamplesState, h: SamplesHandlers): HTMLElement {
  const cases = state.kind === 'tables' ? allCases(state.tables) : [];
  const title = state.kind === 'tables' && cases.length ? W.samplesTitle(cases.length) : W.importSamplesTip;
  const panel = el('div', { class: 'samples', role: 'dialog', 'aria-label': title });
  panel.append(el('div', { class: 'samples-head' }, el('span', { class: 'samples-title' }, title), btn('close', W.samplesClose, h.close)));
  const bodyEl = el('div', { class: 'samples-body' });
  panel.append(bodyEl);
  if (state.kind === 'reading') {
    bodyEl.append(el('p', { class: 'muted', role: 'status' }, W.samplesReading));
    return panel;
  }
  if (state.kind === 'error') {
    bodyEl.append(el('p', { class: 'error', role: 'status' }, W.samplesError(state.why)));
    panel.append(el('div', { class: 'samples-foot' }, textButton(W.samplesClose, h.close, true)));
    return panel;
  }
  if (!cases.length) {
    bodyEl.append(el('p', { role: 'status' }, W.samplesNone), el('p', { class: 'muted' }, W.samplesNoneDetail));
    panel.append(el('div', { class: 'samples-foot' }, textButton(W.samplesClose, h.close, true)));
    return panel;
  }
  bodyEl.append(el('div', { class: 'samples-warning', role: 'note' }, W.samplesWarning));
  cases.forEach((c, i) => {
    const item = el('section', { class: c.annotated ? 'sample annotated' : 'sample' }, el('div', { class: 'sample-head' }, W.samplesCase(i + 1, c.page)));
    if (c.annotated) item.append(el('div', { class: 'sample-flag' }, W.samplesAnnotated));
    item.append(el('div', { class: 'sample-cols' }, block(W.samplesInput, c.input), block(W.samplesOutput, c.output)));
    bodyEl.append(item);
  });
  panel.append(
    el(
      'div',
      { class: 'samples-foot' },
      textButton(W.samplesImport, () => h.importCases(cases.map(({ input, output, annotated }) => ({ input, output, annotated }))), true),
      textButton(W.samplesCancel, h.close),
    ),
  );
  return panel;
}
