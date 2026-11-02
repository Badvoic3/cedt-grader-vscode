// @vitest-environment node
/**
 * Smoke test of the bundled sidebar script in jsdom: renders sample states,
 * never uses innerHTML for grader text, and sends typed messages.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FromWebview, ScoreView, ViewState } from '../src/shared/messages';

const bundle = resolve(__dirname, '../media/dist/webview.js');

beforeAll(() => {
  execFileSync(process.execPath, ['esbuild.mjs'], { cwd: resolve(__dirname, '..'), stdio: 'ignore' });
}, 60_000);

function boot() {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', { runScripts: 'outside-only' });
  const sent: FromWebview[] = [];
  let saved: unknown;
  Object.assign(dom.window, {
    acquireVsCodeApi: () => ({ postMessage: (m: FromWebview) => sent.push(m), getState: () => saved, setState: (s: unknown) => (saved = s) }),
  });
  dom.window.eval(readFileSync(bundle, 'utf8'));
  const post = (state: ViewState) =>
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'state', state } }));
  return { dom, doc: dom.window.document, sent, post, saved: () => saved };
}

const score = (counted: number | null, extra: Partial<ScoreView> = {}): ScoreView => ({
  counted, best: counted, latest: counted, attempts: counted === null ? 0 : 1, penaltyLabel: null, rawSum: false, fullScore: 100, source: 'problem-list', latestBelowCounted: false, ...extra,
});

const base: ViewState = {
  baseUrl: 'https://cedt-grader.nattee.net',
  account: { status: 'logged-out', username: '', fullName: null, hasSavedPassword: false, rememberPassword: true, error: null },
  file: null,
  problem: null,
  matching: { suggestions: [], ambiguous: null, note: null },
  linkedFiles: [],
  linkedNotice: null,
  cphTip: false,
  notLinked: false,
  prompt: null,
  testcases: { busy: false },
  cph: { installed: true },
  languages: { loading: false, items: [], selectedId: null, mismatch: null },
  connection: null,
  submit: { enabled: false, busy: false, reason: 'Open a source file to submit it.', label: 'Submit to Grader' },
  result: null,
  gradingElsewhere: null,
  history: { loading: false, stale: false, error: null, items: [], expanded: null },
  problems: { loading: false, loaded: false, stale: false, items: [], error: null, penaltyNote: null, filter: { status: 'all', topic: null }, topics: [] },
};

const loggedIn: ViewState = {
  ...base,
  account: { status: 'logged-in', username: 'student', fullName: null, hasSavedPassword: true, rememberPassword: true, error: null },
  file: { path: 'grader/00 11 intro.cpp', name: '00 11 intro.cpp', languageGuess: 'C++', supported: true },
  problem: { id: 1360, name: '00_Intro_11', fullName: '<img src=x onerror=alert(1)>', score: score(70, { latest: 40, attempts: 3, latestBelowCounted: true, penaltyLabel: '-10 AI assist' }), source: 'saved', sourceLabel: 'saved', unavailable: false, hasFile: true, hasTestcase: true, status: 'solved', tags: ['ComProg'], lastSubmissionTime: null, lastOpened: null },
  languages: { loading: false, items: [{ id: 1, name: 'C' }, { id: 2, name: 'C++' }], selectedId: 2, mismatch: null },
  submit: { enabled: true, busy: false, reason: null, label: 'Submit to Grader' },
  result: {
    phase: 'done', problemId: 1360, problemName: '00_Intro_11', submissionId: 2460977, submissionUrl: 'https://x/submissions/2460977', number: 3,
    points: 70, comment: 'PP-T',
    verdicts: [
      { index: 1, ok: true, kind: 'correct', label: 'Test 1 of 4: Correct' },
      { index: 2, ok: true, kind: 'correct', label: 'Test 2 of 4: Correct' },
      { index: 3, ok: false, kind: 'wrong', label: 'Test 3 of 4: Wrong Answer' },
      { index: 4, ok: false, kind: 'brand_new', label: 'Test 4 of 4: <b>Mystery</b>', group: 1 },
    ],
    compileError: false, compilerMessage: null, improvement: 'Counted score improved: 40 → 70.', message: null,
  },
  history: {
    loading: false, stale: false, error: null, expanded: null,
    items: [
      { submissionId: 2460977, number: 3, points: 70, status: 'done', comment: 'PP-T', submittedAt: '2026-11-02T12:43:48+07:00', language: 'C++', compileError: false, counted: true,
        verdicts: [{ index: 1, ok: true, kind: 'correct', label: 'Test 1 of 2: Correct' }, { index: 2, ok: false, kind: 'wrong', label: 'Test 2 of 2: Wrong Answer' }] },
      { submissionId: 2460900, number: 2, points: 0, status: 'compilation_error', comment: 'Compilation error', submittedAt: '2026-11-02T12:30:00+07:00', language: 'C++', compileError: true, counted: false, verdicts: [] },
    ],
  },
  problems: { loading: false, loaded: true, items: [{ id: 1360, name: '00_Intro_11', fullName: 'Hello', score: score(100), hasFile: true, hasTestcase: true, status: 'solved', tags: ['ComProg'], lastSubmissionTime: '2026-11-01T10:00:00Z', lastOpened: 5 }, { id: 1271, name: '01_Expr_11', fullName: 'An Expression', score: score(null), hasFile: false, hasTestcase: false, status: 'untried', tags: [], lastSubmissionTime: null, lastOpened: null }], error: null, penaltyNote: null, stale: false, filter: { status: 'all', topic: null }, topics: [] },
};

/** Open the "…" menu with this aria-label and click the item with this text. */
/** Right-click `target` and return the context-menu item labels (full labels, from aria-label). */
function rightClick(doc: Document, target: Element): string[] {
  const W = doc.defaultView as unknown as typeof globalThis;
  target.dispatchEvent(new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
  return [...doc.querySelectorAll('.context-menu .menu-item')].map((b) => b.getAttribute('aria-label') ?? '');
}
function menuPick(doc: Document, target: Element, item: string): void {
  rightClick(doc, target);
  [...doc.querySelectorAll<HTMLButtonElement>('.context-menu .menu-item')].find((b) => b.getAttribute('aria-label') === item)!.click();
}
const row = (doc: Document, i: number) => doc.querySelectorAll('#sec-problems .problem-row')[i];
const header = (doc: Document) => doc.querySelector('#sec-current .problem-field .field-label')!;

describe.runIf(existsSync(resolve(__dirname, '../esbuild.mjs')))('sidebar webview', () => {
  it('starts with "ready" and shows the login form when logged out', () => {
    const { doc, sent, post } = boot();
    expect(sent[0]).toEqual({ type: 'ready' });
    post(base);
    expect(doc.querySelector('#login-user')).not.toBeNull();
    expect(doc.querySelector<HTMLInputElement>('#login-pass')!.type).toBe('password');
  });

  it('sends the password once and clears the field', () => {
    const { dom, doc, sent, post, saved } = boot();
    post(base);
    doc.querySelector<HTMLInputElement>('#login-user')!.value = 'student';
    doc.querySelector<HTMLInputElement>('#login-pass')!.value = 's3cret';
    doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    expect(sent.at(-1)).toEqual({ type: 'login', username: 'student', password: 's3cret', remember: true });
    expect(doc.querySelector<HTMLInputElement>('#login-pass')!.value).toBe('');
    expect(JSON.stringify(saved() ?? {})).not.toContain('s3cret');
  });

  it('login form: password manager friendly, remember checkbox, Keychain tip', () => {
    const { dom, doc, sent, post } = boot();
    post({ ...base, account: { ...base.account, rememberPassword: false } });
    const pass = doc.querySelector<HTMLInputElement>('#login-pass')!;
    expect(pass.getAttribute('autocomplete')).toBe('current-password');
    expect(doc.querySelector<HTMLInputElement>('#login-user')!.getAttribute('autocomplete')).toBe('username');
    const remember = doc.querySelector<HTMLInputElement>('#login-remember')!;
    expect(remember.checked).toBe(false); // follows the saved preference
    expect(doc.body.textContent).not.toContain('Tip: copy it from the Passwords app');
    doc.querySelector<HTMLInputElement>('#login-user')!.value = 'student';
    pass.value = 'pw';
    doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    expect(sent.at(-1)).toEqual({ type: 'login', username: 'student', password: 'pw', remember: false });
  });

  it('renders problem, languages, verdict tiles and history; grader text is escaped', () => {
    const { doc, post } = boot();
    post(loggedIn);
    expect(doc.querySelector('img')).toBeNull(); // not interpreted as HTML
    expect(doc.body.textContent).toContain('<img src=x onerror=alert(1)>');
    expect([...doc.querySelectorAll('#lang option')].map((o) => o.textContent)).toEqual(['C', 'C++']);
    const tiles = [...doc.querySelectorAll('.strip .tile')];
    expect(tiles.map((t) => t.getAttribute('data-tip'))).toEqual([
      'Test 1 of 4: Correct', 'Test 2 of 4: Correct', 'Test 3 of 4: Wrong Answer', 'Test 4 of 4: <b>Mystery</b>',
    ]);
    expect(tiles[3].className).toContain('v-unknown');
    expect(doc.querySelector('.tile-group')).not.toBeNull();
    expect(doc.querySelector('#sec-result .score')!.textContent).toBe('70 points');
    expect(doc.querySelector('#sec-current .score')!.textContent).toBe('70 / 100');
    expect(doc.querySelector('#sec-current')!.textContent).toContain('Latest: 40 — your best 70 still counts.');
    expect(doc.querySelector('#sec-current .penalty')!.textContent).toBe('-10 AI assist');
    expect(doc.querySelector('#sec-result')!.textContent).toContain('Counted score improved: 40 → 70.');
    expect(doc.querySelectorAll('.history-row')).toHaveLength(2);
    expect(doc.querySelectorAll('#sec-problems .problem-row')).toHaveLength(2);
  });

  it('submit / map / language actions post typed messages', () => {
    const { dom, doc, sent, post } = boot();
    post(loggedIn);
    doc.querySelector<HTMLButtonElement>('#submit-btn')!.click();
    expect(sent.at(-1)).toEqual({ type: 'submit' });
    // Row click opens the linked file (or offers choices); it never links by itself.
    doc.querySelectorAll<HTMLButtonElement>('#sec-problems .problem-main')[1].click();
    expect(sent.at(-1)).toEqual({ type: 'problemRowClick', problemId: 1271 });
    // Linking is an explicit action in the row's right-click menu.
    menuPick(doc, row(doc, 1), 'Link to 00 11 intro.cpp');
    expect(sent.at(-1)).toEqual({ type: 'mapProblem', problemId: 1271 });
    const sel = doc.querySelector<HTMLSelectElement>('#lang')!;
    sel.value = '1';
    sel.dispatchEvent(new dom.window.Event('change'));
    expect(sent.at(-1)).toEqual({ type: 'selectLanguage', languageId: 1 });
  });

  it('problem picker: typing keeps the search box open and focused (regression)', () => {
    const { dom, doc, post } = boot();
    post(loggedIn);
    doc.querySelector<HTMLButtonElement>('#sec-current .combo')!.click();
    const search = doc.querySelector<HTMLInputElement>('.picker-search')!;
    expect(doc.activeElement).toBe(search);
    for (const ch of ['0', '1']) {
      search.value += ch;
      search.dispatchEvent(new dom.window.Event('input'));
      const again = doc.querySelector<HTMLInputElement>('.picker-search');
      expect(again).toBe(search); // still the same, attached element
      expect(doc.body.contains(search)).toBe(true);
    }
    expect(doc.querySelectorAll('.picker-list .problem-row')).toHaveLength(1); // '01' → 01_Expr_11
    post({ ...loggedIn }); // a state push while typing must not close or blur it
    expect(doc.body.contains(search)).toBe(true);
    expect(doc.activeElement).toBe(search);
  });

  it('result section only shows the active file result', () => {
    const { doc, post } = boot();
    post(loggedIn);
    expect(doc.querySelector('#sec-result .score')).not.toBeNull();
    post({ ...loggedIn, file: { path: 'b.cpp', name: 'b.cpp', languageGuess: 'C++', supported: true }, result: null, gradingElsewhere: '00_Intro_11' });
    expect(doc.querySelector('#sec-result .score')).toBeNull();
    expect(doc.querySelector('#sec-result')!.textContent).toContain('No submission yet');
    expect(doc.querySelector('#sec-current')!.textContent).toContain('Grading 00_Intro_11 for another file');
  });

  it('history: counted marker, mini strip, expand sends toggle, details and actions', () => {
    const { doc, sent, post } = boot();
    post(loggedIn);
    const rows = doc.querySelectorAll<HTMLButtonElement>('#sec-history .history-row');
    expect(rows[0].querySelector('.badge.counted')).not.toBeNull();
    expect(rows[1].querySelector('.badge.counted')).toBeNull();
    expect(doc.querySelectorAll('#sec-history .history-item')[0].querySelectorAll('.mini-strip .mini')).toHaveLength(2);
    expect(rows[1].textContent).toContain('CE');
    expect(rows[0].getAttribute('data-tip')).toContain('Submission #2460977');
    rows[0].click();
    expect(sent.at(-1)).toEqual({ type: 'toggleSubmission', submissionId: 2460977 });

    post({
      ...loggedIn,
      history: {
        ...loggedIn.history,
        expanded: {
          submissionId: 2460977, loading: false, error: null,
          detail: {
            submissionId: 2460977, url: 'https://x/submissions/2460977', status: 'done', compilerMessage: null, maxRuntimeMs: 2461, peakMemoryKb: 134016,
            hasSource: true, sourceFilename: 'sol.cpp',
            evaluations: [{ index: 1, kind: 'correct', label: 'Test 1: Correct', score: 1, timeMs: 2395, memoryKb: 127952 }],
          },
        },
      },
    });
    const detail = doc.querySelector('#sec-history .detail')!;
    expect(detail.textContent).toContain('2.461 s');
    expect(detail.textContent).toContain('130.88 MB');
    expect(detail.querySelectorAll('.evals tbody tr')).toHaveLength(1);
    const [openBtn, compareBtn] = [...detail.querySelectorAll<HTMLButtonElement>('button.btn')];
    openBtn.click();
    expect(sent.at(-1)).toEqual({ type: 'openSubmissionSource', submissionId: 2460977 });
    compareBtn.click();
    expect(sent.at(-1)).toEqual({ type: 'compareSubmission', submissionId: 2460977 });
    doc.querySelector<HTMLButtonElement>('#sec-history summary [aria-label="Refresh history"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'refreshHistory' });
  });

  it('history: "may be out of date" note when stale', () => {
    const { doc, post } = boot();
    post({ ...loggedIn, history: { ...loggedIn.history, stale: true } });
    expect(doc.querySelector('#sec-history')!.textContent).toContain('May be out of date');
  });

  it('wrong language: one notice with Change, Submit disabled with a tooltip, no duplicate message', () => {
    const { doc, post } = boot();
    post({
      ...loggedIn,
      languages: { ...loggedIn.languages, items: [{ id: 8, name: 'Digital' }], selectedId: null, mismatch: { wanted: 'C++', allowed: ['Digital'] } },
      submit: { enabled: false, busy: false, reason: "This problem doesn't accept C++.", label: 'Submit to Grader' },
    });
    const text = doc.querySelector('#sec-current')!.textContent!;
    expect(text.match(/doesn't accept C\+\+/g)).toHaveLength(1);
    const submit = doc.querySelector<HTMLButtonElement>('#submit-btn')!;
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute('data-tip')).toBe("This problem doesn't accept C++.");
    expect(doc.querySelector('#sec-current .error')).toBeNull();
    const change = [...doc.querySelectorAll<HTMLButtonElement>('#sec-current .notice button')].find((b) => b.textContent === 'Change')!;
    change.click();
    expect(doc.querySelector('.picker-search')).not.toBeNull();
    expect(doc.activeElement).toBe(doc.querySelector('.picker-search'));
  });

  it('connection banner with Retry; hidden when the problem is gone', () => {
    const { doc, sent, post } = boot();
    post({ ...loggedIn, connection: { kind: 'offline', title: 'No internet connection', message: 'Check your internet connection, then press Retry.', action: 'retry' } });
    const banner = doc.querySelector<HTMLElement>('.banner')!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('No internet connection');
    expect(banner.textContent).toContain('may be out of date');
    banner.querySelector<HTMLButtonElement>('button')!.click();
    expect(sent.at(-1)).toEqual({ type: 'retry' });
    expect(doc.querySelector('#sec-problems .problem-row')).not.toBeNull(); // cached data still shown
    post(loggedIn);
    expect(doc.querySelector<HTMLElement>('.banner')!.hidden).toBe(true);
  });

  it('session banner offers Log in', () => {
    const { doc, post } = boot();
    post({ ...base, connection: { kind: 'session', title: 'Session expired', message: 'Log in again.', action: 'login' } });
    expect(doc.querySelector('.banner button')!.textContent).toContain('Log in');
  });

  it('Phase 3: source badge, Change, copy, test-case button, row actions', () => {
    const { doc, sent, post } = boot();
    post(loggedIn);
    const cur = doc.querySelector('#sec-current')!;
    expect(cur.querySelector('.source-line.source-saved')!.textContent).toBe('Chosen by you');
    expect(cur.querySelector('.combo .source-icon')).toBeNull(); // not inside the dropdown any more
    // All header icons visible again, in the original order.
    expect([...header(doc).querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'Open statement', 'Copy problem name', 'Open on the grader website', 'Auto-detect the problem for this file again', 'Unlink this file',
    ]);
    expect([...cur.querySelectorAll('button')].some((b) => b.textContent === 'Change')).toBe(false); // removed: same as the dropdown
    expect(cur.querySelector('[aria-label^="More actions"]')).toBeNull(); // no "…" menu
    header(doc).querySelector<HTMLButtonElement>('[aria-label="Copy problem name"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'copyName', problemId: 1360 });
    // Right-click on the header: the same actions.
    expect(rightClick(doc, header(doc))).toEqual(['Open statement', 'Copy problem name', 'Open on the grader website', 'Auto-detect the problem for this file again', 'Unlink this file']);
    doc.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).KeyboardEvent('keydown', { key: 'Escape' }));
    expect(doc.querySelector('.context-menu')).toBeNull();
    [...cur.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Load test cases'))!.click();
    expect(sent.at(-1)).toEqual({ type: 'loadTestcases' });
    doc.querySelector<HTMLButtonElement>('#sec-current .combo')!.click();
    expect(doc.activeElement).toBe(doc.querySelector('.picker-search'));
    // Row icons as before the "…" menu (same icons, order, tooltips).
    const icons = (r: Element) => [...r.querySelectorAll('.row-actions button')].map((b) => b.getAttribute('aria-label'));
    expect(icons(row(doc, 0))).toEqual(['Copy problem name', 'Go to linked file', 'New file for this problem', 'Open statement']); // has a mapped file
    expect(icons(row(doc, 1))).toEqual(['Copy problem name', 'Find file by name', 'New file for this problem', 'Open statement']);
    row(doc, 1).querySelector<HTMLButtonElement>('[aria-label="New file for this problem"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'newFile', problemId: 1271 });
    // Right-click: the same actions plus linking the open file and the website.
    expect(rightClick(doc, row(doc, 1))).toEqual([
      'Link to 00 11 intro.cpp', 'Copy problem name', 'Find file by name', 'New file for this problem', 'Open statement', 'Open on the grader website',
    ]);
    menuPick(doc, row(doc, 1), 'Open on the grader website');
    expect(sent.at(-1)).toEqual({ type: 'openProblemInBrowser', problemId: 1271 });
    expect(doc.querySelector('.context-menu')).toBeNull(); // closes after choosing
    // Row tooltip: just the names.
    const main = doc.querySelectorAll<HTMLElement>('#sec-problems .problem-main')[1];
    expect(main.dataset.tipTitle).toBe('01_Expr_11 #1271');
    expect(main.dataset.tip).toBe('An Expression');
  });

  it('Phase 3: suggested match is labelled, no test-case button, picker lists suggestions first', () => {
    const { doc, sent, post } = boot();
    const sug = { id: 1271, name: '01_Expr_11', fullName: 'An Expression', score: score(null), hasFile: false, hasTestcase: true, status: 'untried' as const, tags: [], lastSubmissionTime: null, lastOpened: null };
    post({ ...loggedIn, problem: { ...sug, source: 'suggested', sourceLabel: 'Suggested — click to confirm', unavailable: false }, matching: { suggestions: [sug], ambiguous: null, note: null } });
    expect(doc.querySelector('#sec-current .source-line.source-suggested')!.textContent).toContain('Suggested');
    expect(doc.querySelector('#sec-current')!.textContent).toContain('Suggested from the file name');
    expect(doc.querySelector('#sec-current .source-line.source-suggested')!.textContent).toContain('Suggested from the file name·Use this');
    const confirm = [...doc.querySelectorAll<HTMLButtonElement>('#sec-current button')].find((b) => b.textContent === 'Use this')!;
    confirm.click();
    expect(sent.at(-1)).toEqual({ type: 'confirmProblem', problemId: 1271 });
    expect([...doc.querySelectorAll('#sec-current button')].some((b) => b.textContent?.includes('Load test cases'))).toBe(false);
    doc.querySelector<HTMLButtonElement>('#sec-current .combo')!.click();
    expect(doc.querySelector('.picker-group')!.textContent).toBe('Suggested for this file');
  });

  it('Phase 3: ambiguous match shows the note and the candidates', () => {
    const { doc, post } = boot();
    const a = { id: 1, name: 'dup', fullName: 'Dup A', score: score(null), hasFile: false, hasTestcase: false, status: 'untried' as const, tags: [], lastSubmissionTime: null, lastOpened: null };
    const b = { ...a, id: 2, fullName: 'Dup B' };
    post({ ...loggedIn, problem: null, matching: { suggestions: [], ambiguous: [a, b], note: 'Several problems match this file name. Choose one.' } });
    expect(doc.querySelector('#sec-current')!.textContent).toContain('Several problems match this file name');
    doc.querySelector<HTMLButtonElement>('#sec-current .combo')!.click();
    expect(doc.querySelector('.picker-group')!.textContent).toBe('Matches for this file');
  });

  it('CPH not installed: same UI, neutral texts, no "CPH" in the main UI', () => {
    const { doc, post } = boot();
    post({ ...loggedIn, cph: { installed: false } });
    const btn = [...doc.querySelectorAll<HTMLButtonElement>('#sec-current button')].find((b) => b.textContent?.includes('Load test cases'))!;
    expect(btn.textContent).toBe(' Load test cases');
    expect(btn.getAttribute('data-tip')).toContain("CPH isn't installed");
    expect(doc.querySelector('#submit-btn')).not.toBeNull();
    expect(doc.querySelectorAll('#sec-problems .problem-row')).toHaveLength(2);
    // "CPH" only appears where it is actually used (tooltips), not as visible UI text.
    expect(doc.body.textContent).not.toMatch(/CPH/);
  });

  it('accessibility: every icon-only button has a tooltip and the same aria-label; disabled buttons say why', () => {
    const states: ViewState[] = [
      base,
      { ...base, account: { ...base.account, hasSavedPassword: true, username: 'student' } },
      loggedIn,
      { ...loggedIn, connection: { kind: 'offline', title: 'No internet connection', message: 'x', action: 'retry' } },
      { ...loggedIn, languages: { ...loggedIn.languages, items: [{ id: 8, name: 'Digital' }], mismatch: { wanted: 'C++', allowed: ['Digital'] } }, submit: { ...loggedIn.submit, enabled: false, reason: "This problem doesn't accept C++." } },
      { ...loggedIn, problem: { ...loggedIn.problem!, source: 'suggested', sourceLabel: 'Suggested — click to confirm', unavailable: false } },
      { ...loggedIn, result: { ...loggedIn.result!, phase: 'error', message: 'x' }, submit: { ...loggedIn.submit, enabled: false, reason: 'Log in first.' } },
      { ...loggedIn, result: { ...loggedIn.result!, compileError: true, verdicts: [], compilerMessage: 'err' } },
      { ...loggedIn, testcases: { busy: true } },
      {
        ...loggedIn,
        history: {
          ...loggedIn.history,
          expanded: { submissionId: 2460977, loading: false, error: null, detail: { submissionId: 2460977, url: 'u', status: 'done', compilerMessage: 'm', maxRuntimeMs: 1, peakMemoryKb: 1, hasSource: false, sourceFilename: null, evaluations: [] } },
        },
      },
    ];
    const problems: string[] = [];
    for (const st of states) {
      const { doc, post } = boot();
      post(st);
      doc.querySelector<HTMLButtonElement>('#sec-current .combo')?.click(); // picker open too
      for (const b of doc.querySelectorAll<HTMLButtonElement>('button')) {
        const iconOnly = !(b.textContent ?? '').trim();
        const title = b.getAttribute('data-tip') ?? '';
        if (b.hasAttribute('title')) problems.push(`native title (use data-tip): ${b.outerHTML.slice(0, 120)}`);
        const aria = b.getAttribute('aria-label') ?? '';
        if (iconOnly && (!title || title !== aria)) problems.push(`icon button without matching title/aria-label: ${b.outerHTML.slice(0, 120)}`);
        if (b.disabled && !title) problems.push(`disabled button without a reason: ${b.outerHTML.slice(0, 120)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('header: no repeated name, subtitle from full name; match line under the selector; score pill tooltip', () => {
    const { doc, post } = boot();
    post({ ...loggedIn, problem: { ...loggedIn.problem!, name: '104_68_1_exam2_P1', fullName: '104_68_1_exam2_P1: Scholarship', id: 1643 } });
    const combo = doc.querySelector('#sec-current .combo')!;
    expect(combo.textContent).toContain('104_68_1_exam2_P1 #1643');
    expect(combo.textContent).toContain('Scholarship');
    expect(combo.textContent!.match(/104_68_1_exam2_P1/g)).toHaveLength(1);
    expect(doc.querySelector('#sec-current .combo + .source-line, #sec-current .source-line')!.textContent).toBe('Chosen by you');
    const pill = doc.querySelector('#sec-problems .score-pill')!;
    expect(pill.getAttribute('data-tip')).toMatch(/^Counted score: 100 \/ 100/);
    expect(doc.querySelectorAll('#sec-problems .score-pill')[1].getAttribute('data-tip')).toBe('Not attempted yet');
  });

  it('verdict groups drawn as a box with the website tooltip; plain text for non-strips; legend', () => {
    const { doc, post } = boot();
    const verdicts = [
      { index: 1, ok: true, kind: 'correct', label: 'Test 1 of 3: Correct', group: 1 },
      { index: 2, ok: false, kind: 'wrong', label: 'Test 2 of 3: Wrong Answer', group: 1 },
      { index: 3, ok: true, kind: 'correct', label: 'Test 3 of 3: Correct' },
    ];
    post({ ...loggedIn, result: { ...loggedIn.result!, verdicts } });
    const box = doc.querySelector('#sec-result .tile-group')!;
    expect(box.getAttribute('data-tip')).toBe('Group 1 of 1: 1/2 passed. Tests in a box are scored together — the box earns the lowest score inside it.');
    expect(box.querySelectorAll('.tile')).toHaveLength(2);
    expect(doc.querySelectorAll('#sec-result .strip > .tile')).toHaveLength(1);
    // legend popover
    doc.querySelector<HTMLButtonElement>('#sec-result [aria-label="Reading the results"]')!.click();
    expect(doc.querySelector('#sec-result .legend')!.textContent).toContain('Reading the results');
    expect(doc.querySelectorAll('#sec-result .legend .tile').length).toBeGreaterThanOrEqual(9);
    // plain text
    post({ ...loggedIn, result: { ...loggedIn.result!, verdicts: [], comment: 'No testcase' } });
    expect(doc.querySelector('#sec-result code.comment')!.textContent).toBe('[No testcase]');
    expect(doc.querySelector('#sec-result .tile')).toBeNull();
  });

  it('status + topic filters: segmented control, pills, counter, persisted through the host', () => {
    const { doc, sent, post } = boot();
    const st = { ...loggedIn, problems: { ...loggedIn.problems, topics: [{ name: 'ComProg', description: null }] } };
    post(st);
    const segs = [...doc.querySelectorAll<HTMLButtonElement>('#sec-problems .segmented .seg')];
    expect(segs.map((b) => b.textContent)).toEqual(['All', 'Unsolved', 'In progress', 'Solved']);
    segs[1].click();
    expect(sent.at(-1)).toEqual({ type: 'setFilter', filter: { status: 'unsolved', topic: null } });
    post({ ...st, problems: { ...st.problems, filter: { status: 'unsolved', topic: null } } });
    expect(doc.querySelectorAll('#sec-problems .problem-row')).toHaveLength(1); // the untried one
    expect(doc.querySelector('#sec-problems')!.textContent).toContain('1 of 2 problems');
    doc.querySelector<HTMLButtonElement>('#sec-problems .topic')!.click();
    expect(sent.at(-1)).toEqual({ type: 'setFilter', filter: { status: 'unsolved', topic: 'ComProg' } });
    expect(doc.querySelector('#sec-problems')!.textContent).not.toMatch(/Random/);
  });

  it('unrelated state pushes do not recreate a hovered element (tooltips stay)', () => {
    const { doc, post } = boot();
    post(loggedIn);
    const copy = doc.querySelector('#sec-problems [aria-label="Copy problem name"]');
    post({ ...loggedIn, history: { ...loggedIn.history, loading: true } }); // only History changed
    expect(doc.querySelector('#sec-problems [aria-label="Copy problem name"]')).toBe(copy);
    post({ ...loggedIn, result: { ...loggedIn.result!, message: 'x' } }); // only Result changed
    expect(doc.querySelector('#sec-problems [aria-label="Copy problem name"]')).toBe(copy);
  });

  it('verdicts with 12, 40 and 120 tests (+ groups): every tile shown, groups intact, history strips never cut', () => {
    const codes = 'PPPPPPPPP-TPPPPxPPPsPPMPPPPPPP-PPPP!PPPPE';
    const kinds: Record<string, string> = { P: 'correct', '-': 'wrong', T: 'time_limit', x: 'crash', s: 'partial', M: 'memory_limit', '!': 'grader_error', E: 'unknown_error' };
    for (const n of [12, 40, 120]) {
      const verdicts = Array.from({ length: n }, (_, i) => {
        const c = codes[i % codes.length];
        return { index: i + 1, ok: c === 'P', kind: kinds[c], label: `Test ${i + 1} of ${n}: x`, ...(i >= 3 && i < 8 ? { group: 1 } : i >= 8 && i < 11 ? { group: 2 } : {}) };
      });
      const { doc, post } = boot();
      post({
        ...loggedIn,
        result: { ...loggedIn.result!, verdicts },
        history: { ...loggedIn.history, items: [{ ...loggedIn.history.items[0], verdicts }] },
      });
      expect(doc.querySelectorAll('#sec-result .strip .tile')).toHaveLength(n);
      const groups = doc.querySelectorAll('#sec-result .strip > .tile-group');
      expect(groups).toHaveLength(2); // one element per group: never split
      expect(groups[0].querySelectorAll('.tile')).toHaveLength(5);
      expect(groups[1].querySelectorAll('.tile')).toHaveLength(3);
      expect(doc.querySelector('#sec-result .strip > .tile:nth-child(1)')!.getAttribute('data-tip')).toBe(`Test 1 of ${n}: x`);
      const mini = doc.querySelector('#sec-history .mini-strip')!;
      expect(mini.querySelectorAll('.mini')).toHaveLength(n); // no cut-off at 40
      expect(mini.querySelectorAll('.mini-group')).toHaveLength(2);
      expect(mini.textContent).not.toMatch(/\+\d/);
      expect(doc.querySelector('#sec-history .history-row')!.textContent).toContain(`/${n}`);
    }
  });

  it('problem no longer available: notice with Change problem / Remove link, Submit disabled, history kept', () => {
    const { doc, sent, post } = boot();
    post({
      ...loggedIn,
      problem: { ...loggedIn.problem!, unavailable: true },
      submit: { enabled: false, busy: false, reason: 'This problem is no longer available on the grader.', label: 'Submit to Grader' },
      history: { ...loggedIn.history, stale: true },
    });
    const cur = doc.querySelector('#sec-current')!;
    expect(cur.textContent).toContain('This problem is no longer available on the grader.');
    expect(doc.querySelector<HTMLButtonElement>('#submit-btn')!.disabled).toBe(true);
    [...cur.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Remove link')!.click();
    expect(sent.at(-1)).toEqual({ type: 'unmapProblem' });
    [...cur.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Change problem')!.click();
    expect(doc.activeElement).toBe(doc.querySelector('.picker-search'));
    expect(doc.querySelector('#sec-history')!.textContent).toContain('May be out of date');
    expect(doc.querySelectorAll('#sec-history .history-row').length).toBeGreaterThan(0);
  });

  it('duplicate links notice, jump to a file, keep only this one', () => {
    const { doc, sent, post } = boot();
    post({ ...loggedIn, linkedFiles: [{ path: 'a/sol.cpp', current: true, how: 'chosen' }, { path: 'b/sol_v2.cpp', current: false, how: 'chosen' }], linkedNotice: '2 files are linked to this problem' });
    const n = doc.querySelector('#sec-current .notice.linked')!;
    expect(n.textContent).toContain('2 files are linked to this problem');
    [...n.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Show')!.click();
    const rows = doc.querySelectorAll<HTMLElement>('#sec-current .notice.linked .linked-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('this file · chosen by you');
    // this file: actions hidden but kept in place (row height doesn't change)
    expect([...rows[0].querySelectorAll('button')].every((b) => b.classList.contains('invisible'))).toBe(true);
    [...rows[1].querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Open')!.click();
    expect(sent.at(-1)).toEqual({ type: 'openLinkedFile', index: 1 });
    [...rows[1].querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Unlink')!.click();
    expect(sent.at(-1)).toEqual({ type: 'unlinkLinkedFile', index: 1 });
    [...doc.querySelectorAll<HTMLButtonElement>('#sec-current .notice.linked button')].find((b) => b.textContent === 'Unlink the other files')!.click();
    expect(sent.at(-1)).toEqual({ type: 'keepOnlyThisFile' });
  });

  it('account shows the full name (Thai) with the login ID below', () => {
    const { doc, post } = boot();
    post({ ...loggedIn, account: { ...loggedIn.account, username: '6730000021', fullName: 'สมชาย ใจดี' } });
    const acc = doc.querySelector('#sec-account .account-name')!;
    expect(acc.querySelector('strong')!.textContent).toBe('สมชาย ใจดี');
    expect(acc.textContent).toContain('6730000021');
  });

  it('CPH tip: Install / Not now / Don\'t show again', () => {
    const { doc, sent, post } = boot();
    post({ ...loggedIn, cph: { installed: false }, cphTip: true });
    const tip = doc.querySelector('#sec-current .notice.tip')!;
    expect(tip.textContent).toContain('Install the Competitive Programming Helper (CPH) extension');
    const b = (t: string) => [...tip.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === t)!;
    b('Install').click();
    expect(sent.at(-1)).toEqual({ type: 'cphTip', action: 'install' });
    b('Not now').click();
    expect(sent.at(-1)).toEqual({ type: 'cphTip', action: 'later' });
    b("Don't show again").click();
    expect(sent.at(-1)).toEqual({ type: 'cphTip', action: 'never' });
  });

  it('open on website (problem and each submission), auto-detect, sort menu', () => {
    const { dom, doc, sent, post } = boot();
    post(loggedIn);
    header(doc).querySelector<HTMLButtonElement>('[aria-label="Open on the grader website"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'openProblemInBrowser', problemId: 1360 });
    doc.querySelector<HTMLButtonElement>('#sec-history [aria-label="Open on the grader website"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'openSubmission', submissionId: 2460977 });
    menuPick(doc, header(doc), 'Auto-detect the problem for this file again');
    expect(sent.at(-1)).toEqual({ type: 'autoDetect' });
    const sel = doc.querySelector<HTMLSelectElement>('#sec-problems select.sort')!;
    sel.value = 'score-desc';
    sel.dispatchEvent(new dom.window.Event('change'));
    expect(sent.at(-1)).toEqual({ type: 'setFilter', filter: { status: 'all', topic: null, sort: 'score-desc' } });
  });

  it('same-name notice: rows never move when the active file changes; "Don\'t match this file" for a name match', () => {
    const { doc, sent, post } = boot();
    const DA = 'data algo/da68_f2_zero_one_subset_sum.cpp';
    const I2 = 'i2cedt/da68_f2_zero_one_subset_sum.cpp';
    const view = (cur: string) => ({
      ...loggedIn,
      linkedFiles: [
        { path: DA, current: cur === DA, how: 'filename' as const },
        { path: I2, current: cur === I2, how: 'chosen' as const },
      ],
      linkedNotice: 'Another file with the same name also matches this problem.',
    });
    post(view(DA));
    const n = doc.querySelector('#sec-current .notice.linked')!;
    expect(n.textContent).toContain('Another file with the same name also matches this problem.');
    expect(n.textContent).not.toContain(`problem: ${I2}`);
    [...n.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Show')!.click();
    const paths = () => [...doc.querySelectorAll('#sec-current .linked-row .ellipsis')].map((e) => e.textContent);
    const marked = () => [...doc.querySelectorAll('#sec-current .linked-row')].findIndex((r) => r.classList.contains('current'));
    expect(paths()).toEqual([DA, I2]);
    expect(marked()).toBe(0);
    let rows = doc.querySelectorAll<HTMLElement>('#sec-current .linked-row');
    expect(rows[0].textContent).toContain('this file · matched by file name');
    expect(rows[1].textContent).toContain('chosen by you');
    expect(rows[0].querySelectorAll('button').length).toBe(rows[1].querySelectorAll('button').length); // same height
    post(view(I2)); // clicked Open on the other file
    expect(paths()).toEqual([DA, I2]); // same order
    expect(marked()).toBe(1); // the mark moved instead
    rows = doc.querySelectorAll<HTMLElement>('#sec-current .linked-row');
    const open = [...rows[1].querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Open')!;
    expect(open.classList.contains('invisible')).toBe(true);
    [...rows[0].querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === "Don't match this file")!.click();
    expect(sent.at(-1)).toEqual({ type: 'unlinkLinkedFile', index: 0 });
  });

  it('inline prompt (no modal): text, detail and plain buttons answer by id', () => {
    const { doc, sent, post } = boot();
    post({ ...loggedIn, prompt: { id: 7, text: 'Auto-detect found 104_exam67_1_P2 (from CPH data).', detail: null, tone: 'info', buttons: [{ id: 'switch', label: 'Switch to it', primary: true }, { id: 'keep', label: 'Keep current' }] } });
    const bar = doc.querySelector<HTMLElement>('.prompt')!;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('Auto-detect found 104_exam67_1_P2 (from CPH data).');
    [...bar.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Keep current')!.click();
    expect(sent.at(-1)).toEqual({ type: 'promptAnswer', id: 7, button: 'keep' });
    post({ ...loggedIn, prompt: null });
    expect(doc.querySelector<HTMLElement>('.prompt')!.hidden).toBe(true);
  });

  it('explicitly unlinked file: "Not linked to a problem" with Choose problem / Auto-detect', () => {
    const { doc, sent, post } = boot();
    post({ ...loggedIn, problem: null, notLinked: true });
    const cur = doc.querySelector('#sec-current')!;
    expect(cur.textContent).toContain('Not linked to a problem');
    [...cur.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Auto-detect')!.click();
    expect(sent.at(-1)).toEqual({ type: 'autoDetect' });
    [...cur.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Choose problem')!.click();
    expect(doc.activeElement).toBe(doc.querySelector('.picker-search'));
  });

  it('"Unlink this file" icon for any linked file (not for suggestions)', () => {
    const { doc, sent, post } = boot();
    post({ ...loggedIn, problem: { ...loggedIn.problem!, source: 'filename', sourceLabel: 'Matched by file name' } });
    header(doc).querySelector<HTMLButtonElement>('[aria-label="Unlink this file"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'unmapProblem' });
    post({ ...loggedIn, problem: { ...loggedIn.problem!, source: 'suggested', sourceLabel: 'Suggested — click to confirm' } });
    expect(header(doc).querySelector('[aria-label="Unlink this file"]')).toBeNull();
  });

  it('right-click menu: long labels cut in the middle (full label in tooltip and aria-label); text fields keep the normal menu', () => {
    const { dom, doc, post } = boot();
    Object.defineProperty(dom.window, 'innerWidth', { value: 260, configurable: true });
    const name = 'da68_f2_zero_one_subset_sum.cpp';
    post({ ...loggedIn, file: { ...loggedIn.file!, name } });
    rightClick(doc, row(doc, 1));
    const item = [...doc.querySelectorAll<HTMLElement>('.context-menu .menu-item')][0];
    const shown = item.querySelector('.menu-label')!.textContent!;
    expect(shown).toContain('…');
    expect(shown.startsWith('Link to ')).toBe(true);
    expect(shown.endsWith('.cpp')).toBe(true); // the end stays readable
    expect(item.getAttribute('aria-label')).toBe(`Link to ${name}`);
    expect(item.dataset.tip).toContain(`Link to ${name}`);
    // keyboard: arrows move, Escape closes
    const W = dom.window as unknown as typeof globalThis;
    doc.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(doc.activeElement?.getAttribute('aria-label')).toBe('Copy problem name');
    doc.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(doc.querySelector('.context-menu')).toBeNull();
    // search box: native menu (not prevented)
    doc.querySelector<HTMLButtonElement>('#sec-current .combo')!.click();
    const ev = new W.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    doc.querySelector('.picker-search')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(doc.querySelector('.context-menu')).toBeNull();
  });

  it('History tile tooltips (collapsed strip and expanded details) through the custom tooltip', async () => {
    const { dom, doc, post } = boot();
    const verdicts = [
      { index: 1, ok: true, kind: 'correct', label: 'Test 1 of 3: Correct', group: 1 },
      { index: 2, ok: false, kind: 'wrong', label: 'Test 2 of 3: Wrong Answer', group: 1 },
      { index: 3, ok: false, kind: 'time_limit', label: 'Test 3 of 3: Time Limit Exceed' },
    ];
    const st = { ...loggedIn, history: { ...loggedIn.history, items: [{ ...loggedIn.history.items[0], verdicts }] } };
    post(st);
    const hover = async (el: Element) => {
      el.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
      return doc.getElementById('cedt-tooltip')!;
    };
    const tiles = doc.querySelectorAll('#sec-history .mini-strip .mini');
    expect(tiles).toHaveLength(3);
    let tip = await hover(tiles[2]);
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toBe('Test 3 of 3: Time Limit Exceed');
    const group = doc.querySelector('#sec-history .mini-group')!;
    expect(group.getAttribute('data-tip')).toBe('Group 1 of 1: 1/2 passed. Tests in a box are scored together — the box earns the lowest score inside it.');
    // expanded entry: per-test table tiles
    post({
      ...st,
      history: {
        ...st.history,
        expanded: { submissionId: 2460977, loading: false, error: null, detail: { submissionId: 2460977, url: 'u', status: 'done', compilerMessage: null, maxRuntimeMs: 1, peakMemoryKb: 1, hasSource: true, sourceFilename: 'a.cpp', evaluations: [{ index: 1, kind: 'wrong', label: 'Test 1: Wrong Answer', score: 0, timeMs: 1, memoryKb: 1 }] } },
      },
    });
    const evalTile = doc.querySelector('#sec-history .evals .mini')!;
    tip = await hover(evalTile);
    expect(tip.textContent).toBe('Test 1: Wrong Answer');
    for (const t of doc.querySelectorAll('#sec-history .mini')) expect(t.getAttribute('data-tip')).toBeTruthy();
  });

  it('filter narrows the problem list and is remembered (UI state only)', () => {
    const { dom, doc, post, saved } = boot();
    post(loggedIn);
    const f = doc.querySelector<HTMLInputElement>('#sec-problems input[type=search]')!;
    f.value = 'expr';
    f.dispatchEvent(new dom.window.Event('input'));
    expect(doc.querySelectorAll('#sec-problems .problem-row')).toHaveLength(1);
    expect(saved()).toMatchObject({ filter: 'expr' });
  });

  it('compile error shows the compiler message as text', () => {
    const { doc, post } = boot();
    post({ ...loggedIn, result: { ...loggedIn.result!, points: 0, verdicts: [], compileError: true, compilerMessage: 'a.cpp:1: error: <script>' } });
    expect(doc.querySelector('.compiler pre')!.textContent).toBe('a.cpp:1: error: <script>');
    expect(doc.querySelector('script')).toBeNull();
  });
});
