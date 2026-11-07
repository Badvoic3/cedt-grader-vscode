// @vitest-environment node
/** The bundled Test view in jsdom: what it shows, and that typing survives updates. */
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CaseRun } from '../src/runner/types';
import type { FromTests, TestCaseView, TestsHead, ToTests } from '../src/shared/messages';

let bundle = '';

// Its own small build, in memory: `esbuild.mjs` is already being run by the sidebar's tests.
beforeAll(() => {
  const out = buildSync({ entryPoints: [resolve(__dirname, '../webview/tests.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022' });
  bundle = out.outputFiles[0].text;
}, 60_000);

function boot(lang: 'en' | 'th' = 'en') {
  const dom = new JSDOM(`<!DOCTYPE html><html lang="${lang}"><body><div id="app"></div></body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const sent: FromTests[] = [];
  Object.assign(dom.window, { acquireVsCodeApi: () => ({ postMessage: (m: FromTests) => sent.push(m) }) });
  Object.assign(dom.window.HTMLElement.prototype, { scrollIntoView: () => {} });
  dom.window.eval(bundle);
  let order: string[] = [];
  const post = (m: Partial<ToTests> & { head: TestsHead }) => {
    order = m.order ?? order; // the host always sends the order
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'state', fresh: false, cases: [], runs: {}, ...m, order } }));
  };
  const doc = dom.window.document;
  const button = (t: string) => [...doc.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(t));
  const label = (l: string, root: ParentNode = doc) => root.querySelector<HTMLButtonElement>(`[aria-label="${l}"]`)!;
  return { dom, doc, sent, post, button, label };
}

const head = (extra: Partial<TestsHead> = {}): TestsHead => ({
  title: '01_Expr_11', problemId: 2, limits: { timeMs: 1000, memoryMB: 256, source: 'grader' }, summary: { kind: 'not-run' }, running: false, failure: null, leftOut: [], load: { testcases: { busy: false }, samples: { busy: false } }, sampleTip: false, ...extra,
});
const text = (t: string) => ({ text: t, truncated: false });
const kase = (id: string, extra: Partial<TestCaseView> = {}): TestCaseView => ({ id, source: 'grader', input: text('1 2\n'), expected: text('3\n'), ...extra });
const done = (caseId: string, verdict: CaseRun['verdict'], extra: Partial<CaseRun> = {}): CaseRun => ({ caseId, state: 'done', verdict, timeMs: 14, memoryKB: 3277, exitCode: 0, signal: null, actual: text('4\n'), stderr: text(''), ...extra });

describe('Test view', () => {
  it('says hello on load and shows the head: title, id, limit, Load buttons', () => {
    const { doc, sent, post, button } = boot();
    expect(sent[0]).toEqual({ type: 'ready' });
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')] });
    expect(doc.querySelector('.th')!.textContent).toContain('01_Expr_11#2');
    expect(doc.querySelector('.limit')!.textContent).toBe('Limit 1 s · 256 MB, from grader');
    button('Load test cases')!.click();
    expect(sent.at(-1)).toEqual({ type: 'loadTestcases' });
    button('Load samples')!.click();
    expect(sent.at(-1)).toEqual({ type: 'loadSamples' });
  });

  it('no file: only says so', () => {
    const { doc, post, button } = boot();
    post({ fresh: true, head: head({ title: null, problemId: null, load: null }) });
    expect(doc.body.textContent).toContain('Open a source file to run tests.');
    expect(button('Run all')).toBeUndefined();
  });

  it('not linked: file name, no Load row, default limit, one line saying so', () => {
    const { doc, post, button } = boot();
    post({ fresh: true, head: head({ title: 'scratch.cpp', problemId: null, load: null, limits: { timeMs: 10_000, memoryMB: 1024, source: 'default' } }) });
    expect(doc.querySelector('.th')!.textContent).toBe('scratch.cpp');
    expect(button('Load test cases')).toBeUndefined();
    expect(button('Load samples')).toBeUndefined();
    const lines = [...doc.querySelectorAll('.limit')].map((l) => l.textContent?.trim());
    expect(lines).toEqual(['Limit 10 s · 1 GB, default', 'Not linked to a problem']);
    expect(doc.body.textContent).toContain('No cases yet. Add your own to start.');
  });

  it('no cases: Run all is disabled and says why; the text points at Load', () => {
    const { doc, post, button } = boot();
    post({ fresh: true, head: head({ summary: { kind: 'no-cases' } }) });
    expect(button('Run all')!.disabled).toBe(true);
    expect(button('Run all')!.dataset.tip).toBe('Add a case first');
    expect(doc.body.textContent).toContain('No cases yet. Load them above, or add your own.');
  });

  it('a Load button that doesn\'t apply is left out, and a busy one spins', () => {
    const { post, button } = boot();
    post({ fresh: true, head: head({ load: { testcases: null, samples: { busy: true } } }) });
    expect(button('Load test cases')).toBeUndefined();
    expect(button('Reading…')!.disabled).toBe(true);
  });

  it('a running list shows Stop and locks what would change the cases', () => {
    const { doc, sent, post, button, label } = boot();
    post({ fresh: true, head: head({ running: true, summary: { kind: 'running', done: 1, total: 2 } }), order: ['a', 'b'], cases: [kase('a'), kase('b')], runs: { a: done('a', 'AC'), b: { caseId: 'b', state: 'running' } } });
    expect(doc.querySelector('.run-pill')!.textContent).toBe('Running 1/2…');
    button('Stop')!.click();
    expect(sent.at(-1)).toEqual({ type: 'stop' });
    expect(button('Add case')!.disabled).toBe(true);
    expect(label('Delete this case').disabled).toBe(true);
    expect(doc.querySelector('.card.running .vp.running')).not.toBeNull();
    expect(doc.querySelector('.tc')!.getAttribute('draggable')).toBeNull();
  });

  it('a compile error shows the text and a copy button, and says nothing ran', () => {
    const { doc, sent, post, label } = boot();
    post({ fresh: true, head: head({ summary: { kind: 'compile-error' }, failure: { message: "main.cpp:7:3: error: expected ';'", file: 'main.cpp', line: 7 } }), order: ['a'], cases: [kase('a')] });
    expect(doc.querySelector('.err-text')!.textContent).toContain("expected ';'");
    expect(doc.body.textContent).toContain('Nothing was run.');
    label('Copy the error').click();
    expect(sent.at(-1)).toEqual({ type: 'copyFailure' });
  });

  it('names the files left out of a folder compile', () => {
    const { doc, post } = boot();
    post({ fresh: true, head: head({ leftOut: ['old.cpp', 'try.cpp'] }), order: ['a'], cases: [kase('a')] });
    expect(doc.body.textContent).toContain('Left out, each has its own main(): old.cpp, try.cpp');
  });

  it('passing cases stay closed, failing ones open with Expected and Actual; grader text is never HTML', () => {
    const { doc, post } = boot();
    post({
      fresh: true, head: head({ summary: { kind: 'done', passed: 1, total: 2 } }), order: ['a', 'b'],
      cases: [kase('a'), kase('b', { source: 'sample', expected: text('<img src=x onerror=alert(1)>\n') })],
      runs: { a: done('a', 'AC'), b: done('b', 'WA') },
    });
    const [a, b] = [...doc.querySelectorAll('.card')];
    expect(a.classList.contains('AC')).toBe(true);
    expect(a.querySelector('.det')).toBeNull();
    expect(a.querySelector('.tc')!.textContent).toContain('Case 1');
    expect(a.querySelector('.tcm')!.textContent).toContain('14 ms');
    expect(b.classList.contains('WA')).toBe(true);
    expect(b.querySelector('.badge')!.textContent).toBe('PDF sample');
    expect(b.querySelector('.det')!.textContent).toContain('Expected');
    expect(b.querySelector('.det')!.textContent).toContain('Actual');
    expect(b.querySelector('.det')!.textContent).toContain('≈ 3.2 MB');
    expect(doc.querySelector('img')).toBeNull();
  });

  it('only the first failed case opens by itself', () => {
    const { doc, post } = boot();
    post({ fresh: true, head: head(), order: ['a', 'b', 'c'], cases: [kase('a'), kase('b'), kase('c')], runs: { a: done('a', 'AC'), b: done('b', 'WA'), c: done('c', 'TLE') } });
    expect([...doc.querySelectorAll('.card')].map((c) => !!c.querySelector('.det'))).toEqual([false, true, false]);
  });

  it('memory shows "—" when there is no figure, and a crash its exit code', () => {
    const { doc, post } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')], runs: { a: done('a', 'RE', { memoryKB: null, exitCode: 3, stderr: text('boom\n') }) } });
    expect(doc.querySelector('.tcm .mem')!.textContent).toBe('—');
    expect(doc.querySelector('.det')!.textContent).toContain('Exit code 3');
    expect(doc.querySelector('.det')!.textContent).not.toContain('boom');
  });

  it('Stderr opens on click and has its own copy', () => {
    const { doc, sent, post, button, label } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')], runs: { a: done('a', 'WA', { stderr: text('warn\n') }) } });
    button('Stderr')!.click();
    expect(doc.querySelector('.det')!.textContent).toContain('warn');
    label('Copy stderr').click();
    expect(sent.at(-1)).toEqual({ type: 'copy', caseId: 'a', what: 'stderr' });
  });

  it('a user\'s open or close wins until the next run', () => {
    const { doc, post, label } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')], runs: { a: done('a', 'WA') } });
    label('Hide this case').click();
    expect(doc.querySelector('.det')).toBeNull();
    post({ head: head() });
    expect(doc.querySelector('.det')).toBeNull();
    post({ head: head(), runs: { a: { caseId: 'a', state: 'pending' } } });
    post({ head: head(), runs: { a: done('a', 'WA') } });
    expect(doc.querySelector('.det')).not.toBeNull();
  });

  it('Add case is always under the last case, and gone with no file', () => {
    const { doc, post, button } = boot();
    post({ fresh: true, head: head({ summary: { kind: 'no-cases' } }) });
    expect(button('Add case')!.hidden).toBe(false);
    post({ head: head(), order: ['a', 'b'], cases: [kase('a'), kase('b')] });
    expect(button('Add case')!.previousElementSibling).toBe(doc.querySelector('.cards'));
    expect(doc.querySelector('.tools')!.textContent).not.toContain('Add case');
    post({ fresh: true, head: head({ title: null, problemId: null, load: null }), order: [] });
    expect(button('Add case')!.hidden).toBe(true);
  });

  it('Add case opens the new case and puts the cursor in it', () => {
    const { doc, sent, post, button } = boot();
    post({ fresh: true, head: head({ summary: { kind: 'no-cases' } }) });
    button('Add case')!.click();
    expect(sent.at(-1)).toEqual({ type: 'add' });
    post({ head: head(), order: ['n'], cases: [kase('n', { source: 'custom', input: text(''), expected: text('') })] });
    expect(doc.activeElement).toBe(doc.querySelector('textarea'));
    expect(doc.querySelectorAll('textarea')).toHaveLength(2);
  });

  it('typing is sent after a pause, keeps its element through updates, and goes out before a run', () => {
    vi.useFakeTimers();
    try {
      const { dom, doc, sent, post, button, label } = boot();
      post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')] });
      label('Show this case').click();
      const box = doc.querySelector<HTMLTextAreaElement>('textarea')!;
      box.focus();
      box.value = '9 9\n';
      box.dispatchEvent(new dom.window.Event('input'));
      // A save or a run's progress must not touch the text being typed.
      post({ head: head({ summary: { kind: 'not-run' } }), cases: [kase('a', { source: 'custom', input: text('old\n') })], order: ['a'] });
      expect(doc.querySelector('textarea')).toBe(box);
      expect(box.value).toBe('9 9\n');
      expect(doc.activeElement).toBe(box);
      button('Run all')!.click();
      expect(sent.slice(-2)).toEqual([{ type: 'edit', caseId: 'a', input: '9 9\n' }, { type: 'run' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a result still shows when the cursor stayed in a text box, as after Run tests in the main panel', () => {
    const { doc, post, label } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')] });
    label('Show this case').click();
    doc.querySelector('textarea')!.focus();
    post({ head: head({ running: true }), runs: { a: { caseId: 'a', state: 'running' } } });
    post({ head: head(), runs: { a: done('a', 'WA') } });
    expect(doc.querySelector('.det')!.textContent).toContain('Actual');
  });

  it('an edit clearing the result doesn\'t take the cursor out of the box', () => {
    const { doc, post, label } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')], runs: { a: done('a', 'AC') } });
    label('Show this case').click();
    doc.querySelector('.fold')!.dispatchEvent(new doc.defaultView!.MouseEvent('click', { bubbles: true }));
    const box = doc.querySelector('textarea')!;
    box.focus();
    post({ head: head(), cases: [kase('a', { source: 'custom', input: text('9\n') })], runs: { a: null } });
    expect(doc.activeElement).toBe(box);
  });

  it('any case deletes at once, with no question', () => {
    const { sent, post, label } = boot();
    post({ fresh: true, head: head(), order: ['c'], cases: [kase('c', { source: 'custom' })] });
    label('Delete this case').click();
    expect(sent.at(-1)).toEqual({ type: 'remove', caseId: 'c' });
  });

  it('clicking the card opens and closes it; its buttons do their own thing, and Enter works too', () => {
    const { dom, doc, sent, post, label } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')] });
    const bar = () => doc.querySelector<HTMLElement>('.tc')!;
    bar().querySelector('strong')!.click();
    expect(doc.querySelector('.det')).not.toBeNull();
    bar().click();
    expect(doc.querySelector('.det')).toBeNull();
    label('Run this case').click();
    expect(sent.at(-1)).toEqual({ type: 'run', caseId: 'a' });
    expect(doc.querySelector('.det')).toBeNull();
    bar().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(doc.querySelector('.det')).not.toBeNull();
    expect(bar().getAttribute('aria-expanded')).toBe('true');
  });

  it('Alt+Up and Alt+Down move a case and renumber', () => {
    const { dom, doc, sent, post } = boot();
    post({ fresh: true, head: head(), order: ['a', 'b'], cases: [kase('a'), kase('b')] });
    const first = doc.querySelector<HTMLElement>('.tc')!;
    first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: 'reorder', ids: ['b', 'a'] });
    expect(doc.querySelector('.card strong')!.textContent).toBe('Case 1');
    expect(doc.querySelectorAll('.card')[1].querySelector('.tc')!.getAttribute('aria-label')).toBe('Case 2');
    // Already last: nothing is sent.
    sent.length = 0;
    doc.querySelectorAll<HTMLElement>('.tc')[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
    expect(sent).toEqual([]);
  });

  it('Run on a card runs that case; Set Actual as Expected, and a cut output refuses it', () => {
    const { sent, post, label } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')], runs: { a: done('a', 'WA') } });
    label('Run this case').click();
    expect(sent.at(-1)).toEqual({ type: 'run', caseId: 'a' });
    label('Set Actual as Expected').click();
    expect(sent.at(-1)).toEqual({ type: 'setExpected', caseId: 'a' });
    post({ head: head(), runs: { a: done('a', 'WA', { actual: { text: 'x', truncated: true } }) } });
    expect(label("Set Actual as Expected (The output was cut, so it can't be used as the expected output)").disabled).toBe(true);
  });

  it('a cut case text can\'t be edited, and says so', () => {
    const { doc, post, label } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a', { input: { text: 'x', truncated: true } })] });
    label('Show this case').click();
    expect(doc.querySelector('textarea')!.readOnly).toBe(true);
    expect(doc.body.textContent).toContain("Too long to show whole, so it can't be edited here.");
  });

  it('a fresh message forgets the last list', () => {
    const { doc, post } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')], runs: { a: done('a', 'WA') } });
    post({ fresh: true, head: head({ title: 'other' }), order: ['b'], cases: [kase('b')] });
    expect(doc.querySelectorAll('.card')).toHaveLength(1);
    expect(doc.querySelector('.det')).toBeNull();
  });

  it('accessibility: every icon-only button has a tooltip and the same aria-label', () => {
    const { doc, post } = boot();
    post({ fresh: true, head: head({ failure: { message: 'x', file: null, line: null } }), order: ['a'], cases: [kase('a')], runs: { a: done('a', 'WA', { stderr: text('e') }) } });
    const buttons = [...doc.querySelectorAll<HTMLButtonElement>('.icon-btn')];
    expect(buttons.length).toBeGreaterThan(5);
    for (const b of buttons) {
      expect(b.dataset.tip).toBeTruthy();
      expect(b.getAttribute('aria-label')).toBe(b.dataset.tip);
      expect(b.hasAttribute('title')).toBe(false);
    }
  });

  it('marks what differs: the word on a changed line, a whole extra line, spaces at the end as marks', () => {
    const { doc, post } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a', { expected: text('1 2 3\n7 8 9\n') })], runs: { a: done('a', 'WA', { actual: text('1 2 3 \n7 6 9\nextra\n') }) } });
    const [expected, actual] = [...doc.querySelectorAll('.dt')];
    expect(expected.querySelector('.dl.del del')!.textContent).toBe('8');
    expect([...actual.querySelectorAll('ins')].map((i) => i.textContent)).toEqual(['6', 'extra']);
    expect(actual.querySelectorAll('.dl.add')).toHaveLength(2);
    expect(actual.querySelector('.ws')!.textContent).toBe('·');
    expect(doc.body.textContent).toContain("Spaces at line ends don't count.");
  });

  it('no end spaces: no hint; a cut output marks nothing, since the cut would look like a difference', () => {
    const { doc, post } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a', { expected: text('1\n2\n') })], runs: { a: done('a', 'WA', { actual: { text: '1\n', truncated: true } }) } });
    expect(doc.querySelector('.dl.del, .dl.add')).toBeNull();
    expect(doc.body.textContent).not.toContain("Spaces at line ends don't count.");
    expect(doc.body.textContent).toContain('Output was cut for showing.');
  });

  it('a difference past the drawn lines is still in view', () => {
    const { doc, post } = boot();
    const lines = Array.from({ length: 3000 }, (_, i) => `${i}\n`);
    const changed = [...lines];
    changed[2000] = 'x\n';
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a', { expected: text(lines.join('')) })], runs: { a: done('a', 'WA', { actual: text(changed.join('')) }) } });
    expect(doc.querySelector('.dl.add ins')!.textContent).toBe('x');
    expect(doc.querySelector('.dt .dl .n')!.textContent).toBe('1998');
  });

  it('a button pressed right after typing still gets its click: nothing is rebuilt while the mouse is down', () => {
    vi.useFakeTimers();
    try {
      const { dom, doc, post, button, label } = boot();
      post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')] });
      label('Show this case').click();
      const box = doc.querySelector('textarea')!;
      box.focus();
      const run = button('Run all')!;
      const mouse = (type: string) => run.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true }));
      mouse('mousedown');
      box.blur();
      post({ head: head({ summary: { kind: 'not-run' } }) });
      expect(button('Run all')).toBe(run);
      mouse('mouseup');
      vi.runAllTimers();
      expect(button('Run all')).not.toBe(run); // caught up after the click
    } finally {
      vi.useRealTimers();
    }
  });

  it('the keyboard stays on Stop while a run updates the view', () => {
    const { doc, post, button } = boot();
    const running = (done: number) => head({ running: true, summary: { kind: 'running', done, total: 2 } });
    post({ fresh: true, head: running(0), order: ['a'], cases: [kase('a')] });
    button('Stop')!.focus();
    post({ head: running(1) });
    expect(doc.activeElement).toBe(button('Stop'));
  });

  it('Close saves what was typed, then closes the tab; it is there with no file too', () => {
    const { dom, doc, sent, post, label } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')] });
    label('Show this case').click();
    const box = doc.querySelector('textarea')!;
    box.value = 'x';
    box.dispatchEvent(new dom.window.Event('input'));
    label('Close tests').click();
    expect(sent.slice(-2)).toEqual([{ type: 'edit', caseId: 'a', input: 'x' }, { type: 'close' }]);
    post({ fresh: true, head: head({ title: null, problemId: null, load: null }) });
    expect(label('Close tests')).not.toBeNull();
  });

  it('Compare in VS Code asks the host, with the case', () => {
    const { sent, post, button } = boot();
    post({ fresh: true, head: head(), order: ['a'], cases: [kase('a')], runs: { a: done('a', 'WA') } });
    button('Compare in VS Code')!.click();
    expect(sent.at(-1)).toEqual({ type: 'compare', caseId: 'a' });
  });

  it('the sample tip offers the statement and can be dismissed', () => {
    const { doc, sent, post, button } = boot();
    post({ fresh: true, head: head({ sampleTip: true }), order: ['a'], cases: [kase('a', { source: 'sample' })] });
    expect(doc.querySelector('.notice')!.textContent).toContain('PDF samples can be misread.');
    button('Open statement')!.click();
    expect(sent.at(-1)).toEqual({ type: 'openStatement' });
    button('Dismiss')!.click();
    expect(sent.at(-1)).toEqual({ type: 'dismissTip' });
    post({ head: head() });
    expect(doc.querySelector('.notice')).toBeNull();
  });

  it('Thai: the page reads the language from <html lang>', () => {
    const { doc, post } = boot('th');
    post({ fresh: true, head: head({ summary: { kind: 'done', passed: 3, total: 6 } }), order: ['a'], cases: [kase('a')] });
    expect(doc.querySelector('.run-pill')!.textContent).toBe('ผ่าน 3 / 6');
    expect(doc.querySelector('.limit')!.textContent).toBe('จำกัด 1 วินาที · 256 MB จากเกรดเดอร์');
  });
});
