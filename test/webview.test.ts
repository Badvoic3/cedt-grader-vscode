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
  counted, best: counted, latest: counted, attempts: counted === null ? 0 : 1, penaltyLabel: null, rawSum: false, source: 'problem-list', latestBelowCounted: false, ...extra,
});

const base: ViewState = {
  baseUrl: 'https://cedt-grader.nattee.net',
  account: { status: 'logged-out', username: '', hasSavedPassword: false, rememberPassword: true, error: null },
  file: null,
  problem: null,
  matching: { suggestions: [], ambiguous: null, note: null },
  testcases: { busy: false },
  languages: { loading: false, items: [], selectedId: null, mismatch: null },
  connection: null,
  submit: { enabled: false, busy: false, reason: 'Open a source file to submit it.', label: 'Submit to Grader' },
  result: null,
  gradingElsewhere: null,
  history: { loading: false, stale: false, error: null, items: [], expanded: null },
  problems: { loading: false, loaded: false, stale: false, items: [], error: null, penaltyNote: null },
};

const loggedIn: ViewState = {
  ...base,
  account: { status: 'logged-in', username: 'student', hasSavedPassword: true, rememberPassword: true, error: null },
  file: { path: 'grader/00 11 intro.cpp', name: '00 11 intro.cpp', languageGuess: 'C++', supported: true },
  problem: { id: 1360, name: '00_Intro_11', fullName: '<img src=x onerror=alert(1)>', score: score(70, { latest: 40, attempts: 3, latestBelowCounted: true, penaltyLabel: '-10 AI assist' }), source: 'saved', sourceLabel: 'saved', hasFile: true, hasTestcase: true },
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
  problems: { loading: false, loaded: true, items: [{ id: 1360, name: '00_Intro_11', fullName: 'Hello', score: score(100), hasFile: true, hasTestcase: true }, { id: 1271, name: '01_Expr_11', fullName: 'An Expression', score: score(null), hasFile: false, hasTestcase: false }], error: null, penaltyNote: null, stale: false },
};

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
    expect(tiles.map((t) => t.getAttribute('title'))).toEqual([
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
    doc.querySelectorAll<HTMLButtonElement>('#sec-problems .problem-main')[1].click();
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
    expect(rows[0].querySelectorAll('.mini')).toHaveLength(2);
    expect(rows[1].textContent).toContain('CE');
    expect(rows[0].getAttribute('title')).toContain('Submission #2460977');
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
    doc.querySelector<HTMLButtonElement>('#sec-history summary .icon-btn')!.click();
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
    expect(submit.getAttribute('title')).toBe("This problem doesn't accept C++.");
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
    expect(cur.querySelector('.badge.source-saved')!.textContent).toBe('saved');
    [...cur.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === 'Copy the problem name')!.click();
    expect(sent.at(-1)).toEqual({ type: 'copyName', problemId: 1360 });
    [...cur.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Load test cases into CPH'))!.click();
    expect(sent.at(-1)).toEqual({ type: 'loadTestcases' });
    [...cur.querySelectorAll<HTMLButtonElement>('button.link')].find((b) => b.textContent === 'Change')!.click();
    expect(doc.activeElement).toBe(doc.querySelector('.picker-search'));
    const rows = doc.querySelectorAll('#sec-problems .problem-row');
    const label = (r: Element) => [...r.querySelectorAll('.row-actions button')].map((b) => b.getAttribute('aria-label'));
    expect(label(rows[0])).toContain('Go to the file for 00_Intro_11'); // has a mapped file
    expect(label(rows[1])).toContain('Find a file named 01_Expr_11.*'); // no mapped file
    rows[1].querySelector<HTMLButtonElement>('[aria-label="New file for 01_Expr_11"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'newFile', problemId: 1271 });
  });

  it('Phase 3: suggested match is labelled, no test-case button, picker lists suggestions first', () => {
    const { doc, post } = boot();
    const sug = { id: 1271, name: '01_Expr_11', fullName: 'An Expression', score: score(null), hasFile: false, hasTestcase: true };
    post({ ...loggedIn, problem: { ...sug, source: 'suggested', sourceLabel: 'suggested' }, matching: { suggestions: [sug], ambiguous: null, note: null } });
    expect(doc.querySelector('#sec-current .badge.source-suggested')).not.toBeNull();
    expect(doc.querySelector('#sec-current')!.textContent).toContain('Suggested from the file name');
    expect([...doc.querySelectorAll('#sec-current button')].some((b) => b.textContent?.includes('Load test cases'))).toBe(false);
    doc.querySelector<HTMLButtonElement>('#sec-current .combo')!.click();
    expect(doc.querySelector('.picker-group')!.textContent).toBe('Suggested for this file');
  });

  it('Phase 3: ambiguous match shows the note and the candidates', () => {
    const { doc, post } = boot();
    const a = { id: 1, name: 'dup', fullName: 'Dup A', score: score(null), hasFile: false, hasTestcase: false };
    const b = { ...a, id: 2, fullName: 'Dup B' };
    post({ ...loggedIn, problem: null, matching: { suggestions: [], ambiguous: [a, b], note: 'Several problems match this file name. Choose one.' } });
    expect(doc.querySelector('#sec-current')!.textContent).toContain('Several problems match this file name');
    doc.querySelector<HTMLButtonElement>('#sec-current .combo')!.click();
    expect(doc.querySelector('.picker-group')!.textContent).toBe('Matches for this file');
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
