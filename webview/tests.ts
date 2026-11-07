/*
 * The Test view. Plain DOM, no framework; text goes in through text nodes and
 * attributes only. All work happens in the host: this page shows the cases and
 * posts what the user does. Cards are kept per case, so a run or a save never
 * disturbs the text being typed.
 */
import './lang'; // first: sets the display language before anything below builds elements
import { type Child, el, icon } from './dom';
import { summaryPill } from './runSummary';
import { installTooltips } from './tooltip';
import { diffOutputs, type DiffLine, plainLines } from '../src/runner/diff';
import type { CaseRun, Captured } from '../src/runner/types';
import type { FromTests, TestCaseView, TestsHead, ToTests } from '../src/shared/messages';
import { W } from '../src/shared/strings';

interface VsCodeApi {
  postMessage(m: FromTests): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const send = (m: FromTests) => vscode.postMessage(m);

const stackOf = (err: unknown) => String((err as { stack?: unknown } | null)?.stack ?? '');
window.addEventListener('error', (e) => send({ type: 'webviewError', message: e.message, stack: stackOf(e.error) }));
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason as { message?: unknown } | null;
  send({ type: 'webviewError', message: String(err?.message ?? err), stack: stackOf(err) });
});

const EDIT_DELAY_MS = 300;
/** Lines drawn in one block; more only slows the page. Copy gives the whole text. */
const MAX_LINES = 1000;
const MAX_ROWS = 12;
const CONTEXT_LINES = 3;

type Field = 'input' | 'expected';

let head: TestsHead | null = null;
let order: string[] = [];
const cases = new Map<string, TestCaseView>();
const runs = new Map<string, CaseRun>();

// What the user opened or closed; without an entry only the first failed case is open.
const opened = new Map<string, boolean>();
const inputOpen = new Map<string, boolean>();
const stderrOpen = new Set<string>();
const editingExpected = new Set<string>();
let addPending = false;
let dragging: string | null = null;

// Unsaved typing, per case and field. Sent after a pause, and always before a run.
const pending = new Map<string, { id: string; field: Field; text: string }>();
let editTimer: ReturnType<typeof setTimeout> | undefined;

function flushEdits(): void {
  clearTimeout(editTimer);
  editTimer = undefined;
  for (const { id, field, text } of pending.values()) send({ type: 'edit', caseId: id, [field]: text });
  pending.clear();
}

function typed(id: string, field: Field, text: string): void {
  pending.set(`${id}:${field}`, { id, field, text });
  clearTimeout(editTimer);
  editTimer = setTimeout(flushEdits, EDIT_DELAY_MS);
}

const run = (caseId?: string) => {
  flushEdits();
  send({ type: 'run', ...(caseId ? { caseId } : {}) });
};

function iconButton(name: string, label: string, onclick: () => void, opts: { cls?: string; disabledReason?: string | null; disabled?: boolean } = {}): HTMLButtonElement {
  const text = opts.disabledReason ? `${label} (${opts.disabledReason})` : label;
  return el('button', { class: `icon-btn ${opts.cls ?? ''}`.trim(), title: text, 'aria-label': text, type: 'button', disabled: !!opts.disabledReason || opts.disabled, onclick }, icon(name));
}

function button(label: Child, onclick: () => void, opts: { kind?: 'primary' | 'secondary'; cls?: string; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  return el('button', { class: `btn ${opts.kind ?? 'secondary'} ${opts.cls ?? ''}`.trim(), type: 'button', disabled: opts.disabled, title: opts.title, onclick }, label);
}

const sizeOf = (mb: number) => (mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`);
const memoryOf = (kb: number | null | undefined) => (kb === null || kb === undefined ? '—' : `≈ ${(kb / 1024).toFixed(1)} MB`);
const SOURCE = { grader: () => W.sourceGrader, sample: () => W.sourceSample, custom: () => W.sourceCustom };

// ------------------------------------------------------------------ the top

const app = document.getElementById('app')!;
const top = el('div', { class: 'tv-top' });
// Kept out of `top`, which is rebuilt: moving the list would take the cursor out of the text being typed.
const list = el('div', { class: 'cards' });
// Always under the last case, so each new case pushes it down.
const addCase = button([icon('add'), ` ${W.addCase}`], () => { addPending = true; send({ type: 'add' }); }, { cls: 'add-case', title: W.addCaseTip });
app.append(el('div', { class: 'tv' }, top, list, addCase));

/** Rebuild `root`, with the keyboard staying on the same button. */
function keepingFocus(root: HTMLElement, rebuild: () => HTMLElement | void): void {
  const buttons = (r: ParentNode) => [...r.querySelectorAll('button')];
  const at = buttons(root).indexOf(document.activeElement as HTMLButtonElement);
  const after = rebuild() ?? root;
  if (at >= 0) buttons(after)[at]?.focus();
}

function renderTop(h: TestsHead): void {
  top.replaceChildren();
  list.hidden = h.title === null || !order.length;
  addCase.hidden = h.title === null;
  addCase.disabled = h.running;
  const close = () => iconButton('close', W.closeTests, () => { flushEdits(); send({ type: 'close' }); });
  if (h.title === null) {
    top.append(el('div', { class: 'th' }, el('p', { class: 'muted small grow' }, W.testsNoFile), close()));
    return;
  }
  const pill = summaryPill(h.summary);
  const empty = !order.length;
  top.append(
    el('div', { class: 'th' },
      el('strong', { class: 'name' }, h.title),
      h.problemId !== null ? el('span', { class: 'muted' }, `#${h.problemId}`) : null,
      el('span', { class: 'sp' }),
      empty ? null : el('span', { class: `pill run-pill ${pill.tone}` }, pill.text),
      close(),
    ),
  );
  const load = h.load;
  top.append(
    el('div', { class: 'tools' },
      h.running
        ? button([icon('debug-stop'), ` ${W.stopTests}`], () => send({ type: 'stop' }), { cls: 'run-all', title: W.stopTestsTip })
        : button([icon('play'), ` ${W.runAll}`], () => run(), { kind: 'primary', cls: 'run-all', disabled: empty, title: empty ? W.runAllNoCases : W.runAllTip }),
      load?.testcases
        ? button(load.testcases.busy ? [icon('loading', 'codicon-modifier-spin'), ` ${W.loadingTestCases}`] : [icon('beaker'), ` ${W.loadTestCases}`], () => send({ type: 'loadTestcases' }), { disabled: load.testcases.busy || h.running, title: load.testcases.busy ? W.downloadingTestCases : W.loadTestCasesTip })
        : null,
      load?.samples
        ? button(load.samples.busy ? [icon('loading', 'codicon-modifier-spin'), ` ${W.readingSampleCases}`] : [icon('table'), ` ${W.loadSampleCases}`], () => send({ type: 'loadSamples' }), { disabled: load.samples.busy || h.running, title: load.samples.busy ? W.readingStatementTip : W.loadSampleCasesTip })
        : null,
      el('span', { class: 'limit' }, W.testsLimit(h.limits.timeMs / 1000, sizeOf(h.limits.memoryMB), h.limits.source === 'grader')),
    ),
  );
  if (h.problemId === null) top.append(el('div', { class: 'limit' }, icon('debug-disconnect'), ' ', W.notLinkedToAProblem));
  if (h.leftOut.length) top.append(el('div', { class: 'limit' }, W.leftOut(h.leftOut.join(', '))));
  if (h.failure) {
    top.append(
      el('div', { class: 'one-case', role: 'alert' },
        el('div', { class: 'oc-h' },
          el('strong', {}, W.runCompileError),
          el('span', { class: 'sp' }),
          iconButton('copy', W.copyError, () => send({ type: 'copyFailure' })),
        ),
        el('pre', { class: 'err-text' }, h.failure.message),
      ),
      el('p', { class: 'muted small' }, W.nothingRun),
    );
  }
  if (h.sampleTip) {
    top.append(
      el('div', { class: 'notice', role: 'note' },
        el('div', { class: 'row' }, icon('lightbulb'), el('span', { class: 'grow small' }, W.sampleTip)),
        el('div', { class: 'row gap' },
          button(W.openStatement, () => send({ type: 'openStatement' }), { kind: 'primary' }),
          el('button', { class: 'link small', type: 'button', onclick: () => send({ type: 'dismissTip' }) }, W.dismiss),
        ),
      ),
    );
  }
  if (empty) top.append(el('p', { class: 'muted small' }, load ? W.noCasesLoad : W.noCasesAdd));
}

// ------------------------------------------------------------------ one case

function verdictPill(r: CaseRun | undefined): Child {
  if (!r) return null;
  if (r.state === 'running') return el('span', { class: 'vp running' }, icon('loading', 'codicon-modifier-spin'));
  if (r.state === 'pending') return el('span', { class: 'vp pending' }, '…');
  if (r.state === 'stopped') return el('span', { class: 'vp stopped', title: W.caseStopped }, '—');
  return el('span', { class: `vp ${r.verdict}` }, r.verdict ?? '');
}

/** Line-numbered text, marks and all. A long block starts near its first difference. */
function block(lines: readonly DiffLine[], side: 'del' | 'add' = 'del'): HTMLElement {
  const first = lines.findIndex((l) => l.changed);
  const from = first >= MAX_LINES ? first - CONTEXT_LINES : 0;
  const d = el('div', { class: 'dt', tabindex: 0 });
  for (const l of lines.slice(from, from + MAX_LINES)) {
    d.append(
      el('div', { class: `dl ${l.changed ? side : ''}`.trim() },
        el('span', { class: 'n' }, String(l.n)),
        el('span', {}, l.parts.map((p) => (p.changed ? el(side === 'del' ? 'del' : 'ins', {}, p.text) : p.text)), l.trail ? el('span', { class: 'ws' }, l.trail) : null),
      ),
    );
  }
  return d;
}

function editor(c: TestCaseView, field: Field, label: string): Child {
  const value = pending.get(`${c.id}:${field}`)?.text ?? c[field].text;
  const box = el('textarea', {
    class: 'case-text',
    'aria-label': label,
    spellcheck: 'false',
    rows: Math.min(MAX_ROWS, Math.max(2, value.split('\n').length)),
    readonly: !!head?.running || c[field].truncated,
    oninput: (e: Event) => typed(c.id, field, (e.target as HTMLTextAreaElement).value),
    onblur: () => {
      flushEdits();
      render();
    },
  });
  box.value = value;
  return [box, c[field].truncated ? el('div', { class: 'hint' }, icon('info'), ' ', W.textCut) : null];
}

function fold(label: string, open: boolean, toggle: () => void, ...after: Child[]): HTMLElement {
  return el('div', { class: 'blk-h' },
    el('button', { class: 'fold', type: 'button', 'aria-expanded': String(open), onclick: toggle }, icon(open ? 'chevron-down' : 'chevron-right'), ` ${label}`),
    el('span', { class: 'sp' }),
    after,
  );
}

function body(c: TestCaseView, r: CaseRun | undefined): HTMLElement {
  const done = r?.state === 'done';
  const inOpen = inputOpen.get(c.id) ?? !done;
  const editExpected = !done || editingExpected.has(c.id);
  const actual: Captured | undefined = r?.actual;
  const copy = (what: 'input' | 'expected' | 'actual' | 'stderr', label: string) => iconButton('copy', label, () => send({ type: 'copy', caseId: c.id, what }));
  const code = r?.signal ? W.exitSignal(r.signal) : r?.exitCode ? W.exitCode(r.exitCode) : null;
  // Cut text would differ at the cut: it shows as it is, with nothing marked.
  const whole = actual && !actual.truncated && !c.expected.truncated;
  const diff = actual && whole ? diffOutputs(c.expected.text, actual.text) : { expected: plainLines(c.expected.text), actual: plainLines(actual?.text ?? '') };
  const spaces = !!actual && [...diff.expected, ...diff.actual].some((l) => l.trail);
  return el('div', { class: 'det' },
    done ? el('div', { class: 'mem-line', title: W.memoryEstimate }, memoryOf(r.memoryKB)) : null,
    code ? el('div', { class: 'limit' }, code) : null,
    fold(W.caseInput, inOpen, () => { inputOpen.set(c.id, !inOpen); render(); }, copy('input', W.copyInput)),
    inOpen ? editor(c, 'input', W.caseInput) : null,
    el('div', { class: 'cols' },
      el('div', {},
        el('div', { class: 'blk-h' }, W.caseExpected, el('span', { class: 'sp' }),
          done && !c.expected.truncated && !head?.running
            ? iconButton('edit', W.editExpected, () => { editingExpected.add(c.id); render(); })
            : null,
          copy('expected', W.copyExpected),
        ),
        editExpected ? editor(c, 'expected', W.caseExpected) : block(diff.expected, 'del'),
      ),
      actual ? el('div', {}, el('div', { class: 'blk-h' }, W.caseActual), block(diff.actual, 'add')) : null,
    ),
    spaces ? el('div', { class: 'hint' }, icon('info'), ' ', W.spacesDontCount) : null,
    actual?.truncated ? el('div', { class: 'hint' }, icon('info'), ' ', W.outputCut) : null,
    actual
      ? el('div', { class: 'acts' },
          button([icon('diff'), ` ${W.compareInCode}`], () => send({ type: 'compare', caseId: c.id }), { title: W.compareInCodeTip }),
          copy('actual', W.copyActual),
          iconButton('check-all', W.setExpected, () => send({ type: 'setExpected', caseId: c.id }), { disabledReason: actual.truncated ? W.setExpectedCut : null, disabled: !!head?.running }),
        )
      : null,
    r?.stderr?.text
      ? [
          fold(W.caseStderr, stderrOpen.has(c.id), () => {
            if (!stderrOpen.delete(c.id)) stderrOpen.add(c.id);
            render();
          }, copy('stderr', W.copyStderr)),
          stderrOpen.has(c.id) ? block(plainLines(r.stderr.text)) : null,
        ]
      : null,
  );
}

const failed = (id: string) => runs.get(id)?.state === 'done' && runs.get(id)?.verdict !== 'AC';
/** The first failed case opens by itself: more would fill the small split. */
const isOpen = (id: string) => opened.get(id) ?? (failed(id) && order.find(failed) === id);

function move(id: string, to: number): void {
  const from = order.indexOf(id);
  if (from < 0 || to < 0 || to >= order.length || from === to) return;
  order.splice(from, 1);
  order.splice(to, 0, id);
  flushEdits();
  send({ type: 'reorder', ids: order });
  render();
}

function header(c: TestCaseView, r: CaseRun | undefined, n: number): HTMLElement {
  const busy = !!head?.running;
  const open = isOpen(c.id);
  const done = r?.state === 'done';
  const toggle = () => {
    opened.set(c.id, !open);
    render();
  };
  return el('div', {
    class: 'tc',
    draggable: busy ? undefined : 'true',
    tabindex: 0,
    role: 'group',
    'aria-label': W.caseN(n),
    'aria-expanded': String(open),
    onclick: (e: Event) => {
      if (!(e.target as Element).closest('button')) toggle();
    },
    onkeydown: (e: Event) => {
      const k = e as KeyboardEvent;
      if (e.target === e.currentTarget && (k.key === 'Enter' || k.key === ' ')) {
        e.preventDefault();
        toggle();
        return;
      }
      if (busy || !k.altKey || (k.key !== 'ArrowUp' && k.key !== 'ArrowDown')) return;
      e.preventDefault();
      move(c.id, order.indexOf(c.id) + (k.key === 'ArrowUp' ? -1 : 1));
      cards.get(c.id)?.dom.querySelector<HTMLElement>('.tc')?.focus();
    },
    ondragstart: () => { dragging = c.id; },
    ondragend: () => { dragging = null; clearDrop(); },
  },
    el('strong', { title: W.moveCaseTip }, W.caseN(n)),
    verdictPill(r),
    el('span', { class: 'badge' }, SOURCE[c.source]()),
    done ? el('span', { class: 'tcm' }, el('span', {}, `${r.timeMs} ms`), el('span', { class: 'mem', title: W.memoryEstimate }, memoryOf(r.memoryKB))) : null,
    el('span', { class: 'sp' }),
    iconButton('play', W.runCase, () => run(c.id), { cls: 'act-run', disabled: busy }),
    iconButton('trash', W.deleteCase, () => send({ type: 'remove', caseId: c.id }), { cls: 'act-del', disabled: busy }),
    iconButton(open ? 'chevron-up' : 'chevron-down', open ? W.closeCase : W.openCase, toggle),
  );
}

// ------------------------------------------------------------------ the list

const cards = new Map<string, { dom: HTMLElement; key: string; run?: CaseRun }>();

function clearDrop(): void {
  for (const { dom } of cards.values()) dom.classList.remove('drop-before', 'drop-after');
}

function dropTarget(dom: HTMLElement, e: DragEvent): 'before' | 'after' {
  const box = dom.getBoundingClientRect();
  return e.clientY < box.top + box.height / 2 ? 'before' : 'after';
}

function newCard(id: string): HTMLElement {
  const dom = el('div', {
    class: 'card',
    ondragover: (ev: Event) => {
      if (!dragging || dragging === id) return;
      ev.preventDefault();
      clearDrop();
      dom.classList.add(`drop-${dropTarget(dom, ev as DragEvent)}`);
    },
    ondrop: (ev: Event) => {
      if (!dragging || dragging === id) return;
      ev.preventDefault();
      const from = order.indexOf(dragging);
      const at = order.indexOf(id) + (dropTarget(dom, ev as DragEvent) === 'after' ? 1 : 0);
      move(dragging, from < at ? at - 1 : at);
      clearDrop();
    },
  });
  return dom;
}

function renderCards(): void {
  for (const [id, card] of cards) {
    if (!cases.has(id)) {
      card.dom.remove();
      cards.delete(id);
    }
  }
  for (const [i, id] of order.entries()) {
    const c = cases.get(id);
    if (!c) continue;
    let card = cards.get(id);
    if (!card) {
      card = { dom: newCard(id), key: '' };
      cards.set(id, card);
    }
    if (list.children[i] !== card.dom) list.insertBefore(card.dom, list.children[i] ?? null);
    const r = runs.get(id);
    card.dom.className = `card ${r?.state === 'done' ? r.verdict : r?.state === 'running' ? 'running' : ''}`.trim();
    const typing = card.dom.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA';
    const open = isOpen(id);
    const key = JSON.stringify([i, c, r, open, !!head?.running, inputOpen.get(id), stderrOpen.has(id), editingExpected.has(id)]);
    if (key === card.key) continue;
    const old = card.dom.querySelector<HTMLElement>(':scope > .tc');
    if (old) {
      keepingFocus(old, () => {
        const next = header(c, r, i + 1);
        old.replaceWith(next);
        return next;
      });
    } else card.dom.prepend(header(c, r, i + 1));
    // The text being typed stays as it is, and the card catches up on blur. A new result can't wait
    // for that: the cursor stays in the box when the run was started from the main panel.
    if (typing && (!r || r === card.run)) continue;
    card.key = key;
    card.run = r;
    card.dom.querySelector(':scope > .det')?.remove();
    if (open) card.dom.append(body(c, r));
  }
}

// A button rebuilt between mouse down and up gets no click, so nothing is rebuilt while the mouse is down.
let pressed = false;
let renderLater = false;
const released = () => {
  pressed = false;
  if (renderLater) setTimeout(render); // after the click
  renderLater = false;
};
window.addEventListener('mousedown', () => { pressed = true; }, true);
window.addEventListener('mouseup', released, true);
window.addEventListener('dragend', released, true);

function render(): void {
  if (!head) return;
  if (pressed) {
    renderLater = true;
    return;
  }
  const h = head;
  keepingFocus(top, () => renderTop(h));
  renderCards();
  tooltips.refresh();
}

function onState(m: ToTests): void {
  if (m.fresh) {
    for (const map of [cases, runs, opened, inputOpen]) map.clear();
    stderrOpen.clear();
    editingExpected.clear();
    pending.clear();
    addPending = false;
  }
  const known = new Set(cases.keys());
  head = m.head;
  order = m.order;
  for (const c of m.cases) cases.set(c.id, c);
  for (const id of cases.keys()) if (!m.order.includes(id)) cases.delete(id);
  for (const [id, r] of Object.entries(m.runs)) {
    if (r) {
      // A new run decides again what is open.
      if (r.state === 'pending') {
        opened.delete(id);
        editingExpected.delete(id);
      }
      runs.set(id, r);
    } else {
      runs.delete(id);
    }
  }
  const added = addPending ? m.cases.find((c) => !known.has(c.id)) : undefined;
  if (added) {
    addPending = false;
    opened.set(added.id, true);
  }
  render();
  if (added) {
    const dom = cards.get(added.id)?.dom;
    dom?.scrollIntoView({ block: 'nearest' });
    dom?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }
}

const tooltips = installTooltips();
window.addEventListener('blur', () => {
  flushEdits();
  released();
});
window.addEventListener('pagehide', flushEdits);
window.addEventListener('message', (e: MessageEvent<ToTests>) => {
  if (e.data?.type === 'state') onState(e.data);
});
send({ type: 'ready' });
