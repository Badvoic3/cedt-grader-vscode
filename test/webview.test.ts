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

function boot(lang: 'en' | 'th' = 'en') {
  const dom = new JSDOM(`<!DOCTYPE html><html lang="${lang}"><body><div id="app"></div></body></html>`, { runScripts: 'outside-only' });
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
  counted, best: counted, latest: counted, attempts: counted === null ? 0 : 1, penaltyLabel: null, rawSum: false, outOf: 100, source: 'problem-list', latestBelowCounted: false, ...extra,
});

const base: ViewState = {
  baseUrl: 'https://cedt-grader.nattee.net',
  layout: { sections: ['account', 'current', 'result', 'history', 'problems'], compact: false },
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
  samples: { busy: false, available: true },
  folder: null,
  folderMode: null,
  attachment: { busy: null },
  runTests: null,
  cph: { installed: true },
  languages: { loading: false, items: [], selectedId: null, mismatch: null },
  connection: null,
  submit: { enabled: false, busy: false, reason: 'Open a source file to submit it.', label: 'Submit to Grader' },
  result: null,
  gradingElsewhere: null,
  history: { loading: false, stale: false, error: null, items: [], expanded: null },
  problems: { loading: false, loaded: false, stale: false, items: [], error: null, penaltyNote: null, filter: { status: 'all', topic: null }, topics: [], tags: [] },
};

const loggedIn: ViewState = {
  ...base,
  account: { status: 'logged-in', username: 'student', fullName: null, hasSavedPassword: true, rememberPassword: true, error: null },
  file: { path: 'grader/00 11 intro.cpp', name: '00 11 intro.cpp', languageGuess: 'C++', supported: true, renameTo: null },
  problem: { id: 1360, name: '00_Intro_11', fullName: '<img src=x onerror=alert(1)>', score: score(70, { latest: 40, attempts: 3, latestBelowCounted: true, penaltyLabel: '-10 AI assist' }), source: 'saved', sourceLabel: 'saved', unavailable: false, hasFile: true, hasTestcase: true, hasAttachment: false, status: 'solved', tags: ['ComProg'], lastSubmissionTime: null, lastOpened: null },
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
  problems: { loading: false, loaded: true, items: [{ id: 1360, name: '00_Intro_11', fullName: 'Hello', score: score(100), hasFile: true, hasTestcase: true, hasAttachment: false, status: 'solved', tags: ['ComProg'], lastSubmissionTime: '2026-11-01T10:00:00Z', lastOpened: 5 }, { id: 1271, name: '01_Expr_11', fullName: 'An Expression', score: score(null), hasFile: false, hasTestcase: false, hasAttachment: false, status: 'untried', tags: [], lastSubmissionTime: null, lastOpened: null }], error: null, penaltyNote: null, stale: false, filter: { status: 'all', topic: null }, topics: [], tags: [] },
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
/** `loggedIn` with an attachment on the current problem and on row 1. */
const withAttachment = (extra: Partial<ViewState> = {}): ViewState => ({
  ...loggedIn,
  problem: { ...loggedIn.problem!, hasAttachment: true },
  problems: { ...loggedIn.problems, items: loggedIn.problems.items.map((p, i) => (i === 1 ? { ...p, hasAttachment: true } : p)) },
  folderMode: { on: false, disabledReason: null },
  ...extra,
});
const row = (doc: Document, i: number) => doc.querySelectorAll('#sec-problems .problem-row:not([hidden])')[i];
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
    expect(doc.querySelector('#sec-result .score')!.textContent).toBe('70 / 100');
    expect(doc.querySelector('#sec-current .score')!.textContent).toBe('70 / 100');
    expect(doc.querySelector('#sec-current')!.textContent).toContain('Latest: 40. Your best, 70, still counts.');
    expect(doc.querySelector('#sec-current .penalty')!.textContent).toBe('-10 AI assist');
    expect(doc.querySelector('#sec-result')!.textContent).toContain('Counted score improved: 40 → 70.');
    expect(doc.querySelectorAll('.history-row')).toHaveLength(2);
    expect(doc.querySelectorAll('#sec-problems .problem-row:not([hidden])')).toHaveLength(2);
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
    post({ ...loggedIn, file: { path: 'b.cpp', name: 'b.cpp', languageGuess: 'C++', supported: true, renameTo: null }, result: null, gradingElsewhere: '00_Intro_11' });
    expect(doc.querySelector('#sec-result .score')).toBeNull();
    expect(doc.querySelector('#sec-result')!.textContent).toContain('Nothing submitted from this file yet');
    expect(doc.querySelector('#sec-current')!.textContent).toContain('Grading 00_Intro_11 for another file');
  });

  it('history: counted marker, mini strip, expand sends toggle, details and actions', () => {
    const { doc, sent, post } = boot();
    post(loggedIn);
    const rows = doc.querySelectorAll<HTMLButtonElement>('#sec-history .history-row');
    expect(rows[0].querySelector('.badge.counted')).not.toBeNull();
    expect(rows[1].querySelector('.badge.counted')).toBeNull();
    // The star has the colour of the problem's counted score (70 → partial), not always green.
    expect(rows[0].querySelector('.badge.counted')!.classList.contains('score-partial')).toBe(true);
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
    expect(detail.querySelector('.evals td.verdict')!.textContent).toBe(' Correct'); // the cell that may wrap
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
    expect(doc.querySelector('#sec-problems .problem-row:not([hidden])')).not.toBeNull(); // cached data still shown
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
      'Open statement', 'Copy problem name', 'Open on the grader website', "Save the grader's test cases as .in / .out files", 'Auto-detect the problem for this file again', "Unlink this file (removes your choice; auto-detect won't link it again)",
    ]);
    expect([...cur.querySelectorAll('button')].some((b) => b.textContent === 'Change')).toBe(false); // removed: same as the dropdown
    expect(cur.querySelector('[aria-label^="More actions"]')).toBeNull(); // no "…" menu
    header(doc).querySelector<HTMLButtonElement>('[aria-label="Copy problem name"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'copyName', problemId: 1360 });
    // Right-click on the header: the same actions.
    expect(rightClick(doc, header(doc))).toEqual(['Open statement', 'Copy problem name', 'Open on the grader website', "Save the grader's test cases as .in / .out files", 'Auto-detect the problem for this file again', 'Unlink this file']);
    doc.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).KeyboardEvent('keydown', { key: 'Escape' }));
    header(doc).querySelector<HTMLButtonElement>(`[aria-label="Save the grader's test cases as .in / .out files"]`)!.click();
    expect(sent.at(-1)).toEqual({ type: 'loadTestcases', asFiles: true });
    doc.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).KeyboardEvent('keydown', { key: 'Escape' }));
    expect(doc.querySelector('.context-menu')).toBeNull();
    [...cur.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Load test cases'))!.click();
    expect(sent.at(-1)).toEqual({ type: 'loadTestcases' });
    doc.querySelector<HTMLButtonElement>('#sec-current .combo')!.click();
    expect(doc.activeElement).toBe(doc.querySelector('.picker-search'));
    // Row icons as before the "…" menu (same icons, order, tooltips).
    const icons = (r: Element) => [...r.querySelectorAll('.row-actions button')].map((b) => b.getAttribute('aria-label'));
    expect(icons(row(doc, 0))).toEqual(['Copy problem name', 'Go to linked file', 'New file for this problem', 'Open statement']); // has a mapped file
    expect(icons(row(doc, 1))).toEqual(['Copy problem name', 'Find a matching file', 'New file for this problem', 'Open statement']);
    row(doc, 1).querySelector<HTMLButtonElement>('[aria-label="New file for this problem"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'newFile', problemId: 1271 });
    // Right-click: the same actions plus linking the open file and the website.
    expect(rightClick(doc, row(doc, 1))).toEqual([
      'Link to 00 11 intro.cpp', 'Copy problem name', 'Find a matching file', 'New file for this problem', 'Open statement', 'Open on the grader website',
    ]);
    menuPick(doc, row(doc, 1), 'Open on the grader website');
    expect(sent.at(-1)).toEqual({ type: 'openProblemInBrowser', problemId: 1271 });
    expect(doc.querySelector('.context-menu')).toBeNull(); // closes after choosing
    // Row tooltip: just the names.
    const main = doc.querySelectorAll<HTMLElement>('#sec-problems .problem-main')[1];
    expect(main.dataset.tipTitle).toBe('01_Expr_11 #1271');
    expect(main.dataset.tip).toBe('An Expression');
  });

  it('suggested match: labelled as a guess, works like a link (score, history, test cases, statement), picker lists suggestions first', () => {
    const { doc, sent, post } = boot();
    const sug = { id: 1271, name: '01_Expr_11', fullName: 'An Expression', score: score(null), hasFile: false, hasTestcase: true, hasAttachment: false, status: 'untried' as const, tags: [], lastSubmissionTime: null, lastOpened: null };
    post({ ...loggedIn, problem: { ...sug, source: 'suggested', sourceLabel: 'Suggested — click to confirm', unavailable: false }, matching: { suggestions: [sug], ambiguous: null, note: null } });
    expect(doc.querySelector('#sec-current .source-line.source-suggested')!.textContent).toContain('Suggested');
    expect(doc.querySelector('#sec-current')!.textContent).toContain('Suggested from the file name');
    expect(doc.querySelector('#sec-current .source-line.source-suggested')!.textContent).toContain('Suggested from the file name·Use this');
    const confirm = [...doc.querySelectorAll<HTMLButtonElement>('#sec-current button')].find((b) => b.textContent === 'Use this')!;
    confirm.click();
    expect(sent.at(-1)).toEqual({ type: 'confirmProblem', problemId: 1271 });
    // Read-only features as for a link; write actions ask in the extension (one question, then confirmed).
    expect([...doc.querySelectorAll('#sec-current button')].some((b) => b.textContent?.includes('Load test cases'))).toBe(true);
    expect(doc.querySelector('#sec-current .score-card, #sec-current .score')).not.toBeNull();
    expect(doc.querySelector('#sec-current [aria-label="Open statement"]')).not.toBeNull();
    post({ ...loggedIn, problem: { ...sug, source: 'suggested', sourceLabel: 'Suggested — click to confirm', unavailable: false }, matching: { suggestions: [sug], ambiguous: null, note: null } });
    expect(doc.querySelectorAll('#sec-history .history-row').length).toBeGreaterThan(0); // history shown for the suggestion
    doc.querySelector<HTMLButtonElement>('#sec-current .combo')!.click();
    expect(doc.querySelector('.picker-group')!.textContent).toBe('Suggested for this file');
  });

  it('Phase 3: ambiguous match shows the note and the candidates', () => {
    const { doc, post } = boot();
    const a = { id: 1, name: 'dup', fullName: 'Dup A', score: score(null), hasFile: false, hasTestcase: false, hasAttachment: false, status: 'untried' as const, tags: [], lastSubmissionTime: null, lastOpened: null };
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
    expect(doc.querySelectorAll('#sec-problems .problem-row:not([hidden])')).toHaveLength(2);
    // "CPH" only appears where it is actually used (tooltips), not as visible UI text.
    expect(doc.body.textContent).not.toMatch(/CPH/);
  });

  it('Load samples: on one row with Load test cases, for every problem (also without grader test cases), the note in the tooltip', () => {
    const { doc, sent, post } = boot();
    const row = () => [...doc.querySelectorAll('#sec-current .test-buttons button.btn')].map((b) => b.textContent?.trim());
    post(loggedIn);
    expect(row()).toEqual(['Load test cases', 'Load samples']);
    const tip = 'Load the sample cases from the example table in the problem statement (PDF), also for problems without grader test cases. An unusual layout may be read wrong, so check the cases.';
    const btn = () => doc.querySelectorAll<HTMLButtonElement>('#sec-current .test-buttons button.btn')[row().length - 1];
    expect(btn().dataset.tip).toBe(tip);
    expect(btn().hasAttribute('title')).toBe(false);
    btn().click();
    expect(sent.at(-1)).toEqual({ type: 'loadSampleCases' });
    post({ ...loggedIn, problem: { ...loggedIn.problem!, hasTestcase: false } });
    expect(row()).toEqual(['Load samples']);
    post({ ...loggedIn, samples: { busy: true, available: true } });
    expect(btn().disabled).toBe(true);
    expect(btn().textContent?.trim()).toBe('Reading…');
    expect(btn().dataset.tip).toBe('Reading the example table in the statement…');
    // The cached statement is not a PDF: no samples button; the grader's button alone (full width).
    post({ ...loggedIn, samples: { busy: false, available: false } });
    expect(row()).toEqual(['Load test cases']);
    // Neither: no row at all (the rest moves up).
    post({ ...loggedIn, problem: { ...loggedIn.problem!, hasTestcase: false }, samples: { busy: false, available: false } });
    expect(doc.querySelector('#sec-current .test-buttons')).toBeNull();
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
      // Attachment + folder mode: download icon (also busy), folder toggle (also disabled), submit-file select.
      withAttachment({ folderMode: { on: false, disabledReason: 'This file is at the top of the workspace folder.' }, attachment: { busy: 1360 } }),
      withAttachment({ folder: { path: 'pkg/', matched: false, submitFile: 'student.h', submitWhy: 'the included file named student.*', submitChosen: false, runFile: 'main.cpp', runWhy: 'the only file with main()', runChosen: false, candidates: ['main.cpp', 'student.h', 'vector.h'], runCandidates: ['main.cpp'] }, folderMode: { on: true, disabledReason: null }, runTests: { disabledReason: 'load the test cases first' } }),
      withAttachment({ folder: { ...({ path: 'pkg/', matched: false, submitFile: 'student.h', submitWhy: 'the included file named student.*', submitChosen: false, runFile: 'main.cpp', runWhy: 'the only file with main()', runChosen: false, candidates: ['main.cpp', 'student.h', 'vector.h'], runCandidates: ['main.cpp'] }), submitFile: null, submitWhy: null, runFile: null, runWhy: null }, folderMode: { on: true, disabledReason: null }, runTests: { disabledReason: null } }),
      {
        ...loggedIn,
        history: {
          ...loggedIn.history,
          expanded: { submissionId: 2460977, loading: false, error: null, detail: { submissionId: 2460977, url: 'u', status: 'done', compilerMessage: 'm', maxRuntimeMs: 1, peakMemoryKb: 1, hasSource: false, sourceFilename: null, evaluations: [] } },
        },
      },
    ];
    const problems: string[] = [];
    for (const st of states.flatMap((s) => [['en', s], ['th', s]] as const)) {
      const { doc, post } = boot(st[0]);
      post(st[1]);
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

  it('attachment: a download icon (header, row, right-click) only for problems that have one', () => {
    const { doc, sent, post } = boot();
    post({ ...loggedIn, folderMode: { on: false, disabledReason: null } });
    expect(header(doc).querySelector('[aria-label="Download attachment"]')).toBeNull();
    expect(row(doc, 1).querySelector('[aria-label="Download attachment"]')).toBeNull();
    expect(rightClick(doc, row(doc, 1))).not.toContain('Download attachment');
    post(withAttachment());
    header(doc).querySelector<HTMLButtonElement>('[aria-label="Download attachment"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'downloadAttachment', problemId: 1360 });
    const icons = [...row(doc, 1).querySelectorAll('.row-actions button')].map((b) => b.getAttribute('aria-label'));
    // Download first: the icons are right-aligned, so the other four keep their columns on every row.
    expect(icons).toEqual(['Download attachment', 'Copy problem name', 'Find a matching file', 'New file for this problem', 'Open statement']);
    expect(row(doc, 0).querySelector('[aria-label="Download attachment"]')).toBeNull();
    menuPick(doc, row(doc, 1), 'Download attachment');
    expect(sent.at(-1)).toEqual({ type: 'downloadAttachment', problemId: 1271 });
    expect(rightClick(doc, header(doc))).toContain('Download attachment');
    // While it downloads: disabled, and the tooltip says why.
    post(withAttachment({ attachment: { busy: 1360 } }));
    const busy = header(doc).querySelector<HTMLButtonElement>('[aria-label^="Download attachment"]')!;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-label')).toBe('Download attachment (Downloading…)');
  });

  it('folder mode: visible toggle + header menu, folder line, submit-file dropdown, ✕ unlinks the folder', () => {
    const { doc, sent, post } = boot();
    post(withAttachment());
    header(doc).querySelector<HTMLButtonElement>('[aria-label="Link the whole folder"]')!.click();
    expect(sent.at(-1)).toEqual({ type: 'toggleFolderMode' });
    expect(rightClick(doc, header(doc))).toContain('Link the whole folder');
    // At the top of the workspace: disabled with the reason.
    post(withAttachment({ folderMode: { on: false, disabledReason: 'This file is at the top of the workspace folder.' } }));
    const off = header(doc).querySelector<HTMLButtonElement>('[aria-label^="Link the whole folder"]')!;
    expect(off.disabled).toBe(true);
    expect(off.dataset.tip).toContain('top of the workspace folder');
    // In folder mode.
    post(withAttachment({ folder: { path: 'pkg/', matched: false, submitFile: 'student.h', submitWhy: 'the included file named student.*', submitChosen: false, runFile: 'main.cpp', runWhy: 'the only file with main()', runChosen: false, candidates: ['main.cpp', 'student.h', 'vector.h'], runCandidates: ['main.cpp'] }, folderMode: { on: true, disabledReason: null }, runTests: { disabledReason: null } }));
    const cur = doc.querySelector('#sec-current')!;
    expect(cur.querySelector('.source-line.source-folder')!.textContent).toBe('Folder linked by you: pkg/');
    expect(header(doc).querySelector('[aria-label="Link only this file"]')).not.toBeNull();
    expect(header(doc).querySelector('[aria-label^="Unlink this folder"]')).not.toBeNull();
    expect(rightClick(doc, header(doc))).toEqual(expect.arrayContaining(['Link only this file', 'Unlink this folder']));
    doc.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).KeyboardEvent('keydown', { key: 'Escape' }));
    // Submits / Runs: detected files first ("Automatic: …", why in the tooltip); picking one is remembered.
    const pick = cur.querySelector<HTMLSelectElement>('#submit-file')!;
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Automatic: student.h', 'main.cpp', 'student.h', 'vector.h']);
    expect(pick.dataset.tip).toContain('the included file named student.*');
    expect(pick.dataset.tip).toContain('only this file is sent. Found automatically'); // one period, not two
    const runs = cur.querySelector<HTMLSelectElement>('#run-file')!;
    expect([...runs.options].map((o) => o.textContent)).toEqual(['Automatic: main.cpp', 'main.cpp']);
    expect(cur.textContent).toContain('The grader takes one file per submission: only this file is sent.');
    const W = doc.defaultView as unknown as typeof globalThis;
    pick.value = 'vector.h';
    pick.dispatchEvent(new W.Event('change'));
    expect(sent.at(-1)).toEqual({ type: 'setFolderRole', role: 'submit', file: 'vector.h' });
    pick.value = '';
    pick.dispatchEvent(new W.Event('change'));
    expect(sent.at(-1)).toEqual({ type: 'setFolderRole', role: 'submit', file: '' }); // back to automatic
    // Run tests (CPH installed): runs the driver; disabled until test cases are loaded.
    [...cur.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Run tests'))!.click();
    expect(sent.at(-1)).toEqual({ type: 'runTests' });
    post(withAttachment({ folder: { path: 'pkg/', matched: false, submitFile: 'student.h', submitWhy: 'the included file named student.*', submitChosen: false, runFile: 'main.cpp', runWhy: 'the only file with main()', runChosen: false, candidates: ['main.cpp', 'student.h', 'vector.h'], runCandidates: ['main.cpp'] }, folderMode: { on: true, disabledReason: null }, runTests: { disabledReason: 'load the test cases first' } }));
    const run = [...cur.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Run tests'))!;
    expect(run.disabled).toBe(true);
    expect(run.classList.contains('wide')).toBe(true); // full width like Submit, outside the test-case row
    expect(run.dataset.tip).toContain('load the test cases first');
    post({ ...withAttachment(), runTests: null });
    expect([...cur.querySelectorAll('button')].some((b) => b.textContent?.includes('Run tests'))).toBe(false); // no CPH: no button
    // Matched by the folder's name (no folder link): "Don't match this folder".
    post({ ...withAttachment(), problem: { ...withAttachment().problem!, source: 'folder', sourceLabel: 'Matched by folder name' } });
    expect(cur.querySelector('.source-line.source-folder')!.textContent).toBe('Matched by folder name');
    expect(header(doc).querySelector('[aria-label^="Don\'t match this folder"]')).not.toBeNull();
    // ...and its files are detected like a linked folder's (nothing saved until a choice): Submits / Runs shown,
    // the match line stays "Matched by folder name", the folder icon still offers to link it.
    post({
      ...withAttachment({ folder: { path: 'pkg/', matched: true, submitFile: 'student.h', submitWhy: 'the included file named student.*', submitChosen: false, runFile: 'main.cpp', runWhy: 'the only file with main()', runChosen: false, candidates: ['main.cpp', 'student.h'], runCandidates: ['main.cpp'] }, folderMode: { on: false, disabledReason: null } }),
      problem: { ...withAttachment().problem!, source: 'folder', sourceLabel: 'Matched by folder name' },
    });
    expect(cur.querySelector('.source-line.source-folder')!.textContent).toBe('Matched by folder name');
    expect([...cur.querySelector<HTMLSelectElement>('#submit-file')!.options].map((o) => o.textContent)).toEqual(['Automatic: student.h', 'main.cpp', 'student.h']);
    expect(header(doc).querySelector('[aria-label^="Don\'t match this folder"]')).not.toBeNull();
    expect(header(doc).querySelector('[aria-label^="Link the whole folder"]')).not.toBeNull();
  });

  it('troubleshooting link in the connection banner and under a login error; Result revealed after grading', () => {
    const { doc, sent, post, dom } = boot();
    post({ ...loggedIn, connection: { kind: 'offline', title: 'No internet connection', message: 'x', action: 'retry' } });
    const link = [...doc.querySelectorAll<HTMLButtonElement>('.banner button')].find((b) => b.textContent?.includes('Troubleshooting'))!;
    expect(link.getAttribute('data-tip')).toBe('Open the troubleshooting guide on GitHub');
    link.click();
    expect(sent).toContainEqual({ type: 'openTroubleshooting' });
    post({ ...base, account: { ...base.account, error: 'Wrong username or password.' } });
    expect(doc.querySelector('#sec-account')!.textContent).toContain('Troubleshooting');
    // Collapsed Result section: the host's "result" focus opens it.
    post(loggedIn);
    const result = doc.querySelector<HTMLDetailsElement>('#sec-result')!;
    result.open = false;
    result.dispatchEvent(new dom.window.Event('toggle'));
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'focus', target: 'result' } }));
    expect(result.open).toBe(true);
  });

  it('layout: sections hidden and reordered by the setting; Account back while logged out; compact class', () => {
    const { doc, post } = boot();
    const order = () => [...doc.querySelectorAll<HTMLElement>('#app > details.section')].filter((d) => !d.hidden).map((d) => d.id);
    post(loggedIn);
    expect(order()).toEqual(['sec-account', 'sec-current', 'sec-result', 'sec-history', 'sec-problems']);
    post({ ...loggedIn, layout: { sections: ['current', 'problems', 'result'], compact: false } });
    expect(order()).toEqual(['sec-current', 'sec-problems', 'sec-result']);
    expect(doc.querySelector<HTMLElement>('#sec-history')!.hidden).toBe(true);
    post({ ...base, layout: { sections: ['current', 'problems'], compact: false } });
    expect(order()).toEqual(['sec-account', 'sec-current', 'sec-problems']);
    expect(doc.body.classList.contains('compact')).toBe(false);
    post({ ...loggedIn, layout: { sections: ['account', 'current', 'result', 'history', 'problems'], compact: true } });
    expect(doc.body.classList.contains('compact')).toBe(true);
    expect(order()).toHaveLength(5);
    // Hidden Result: the "result" focus after grading does nothing.
    post({ ...loggedIn, layout: { sections: ['current'], compact: false } });
    doc.defaultView!.dispatchEvent(new doc.defaultView!.MessageEvent('message', { data: { type: 'focus', target: 'result' } }));
    expect(doc.querySelector<HTMLElement>('#sec-result')!.hidden).toBe(true);
  });

  it('layout: only the first visible section has no line above it (the hidden banner comes first in the DOM)', () => {
    const { doc, post } = boot();
    const firsts = () => [...doc.querySelectorAll<HTMLElement>('#app > details.section.first-visible')].map((d) => d.id);
    post(loggedIn);
    expect(doc.querySelector('#app > .banner')!.nextElementSibling).not.toBeNull(); // banner (hidden) before the sections
    expect(firsts()).toEqual(['sec-account']);
    post({ ...loggedIn, layout: { sections: ['history', 'current'], compact: false } });
    expect(firsts()).toEqual(['sec-history']);
    post({ ...loggedIn, layout: { sections: ['problems'], compact: true } });
    expect(firsts()).toEqual(['sec-problems']);
    post({ ...base, layout: { sections: ['problems'], compact: false } }); // logged out: Account comes back first
    expect(firsts()).toEqual(['sec-account']);
    const css = readFileSync(resolve(__dirname, '../webview/style.css'), 'utf8');
    expect(css).toMatch(/\.section\.first-visible\s*\{\s*border-top:\s*none/);
    expect(css).not.toMatch(/\.section:first-child/);
  });

  it('Thai: the panel is built in the language of <html lang> (texts from strings.th.ts)', () => {
    const out = boot('th');
    out.post(base);
    const doc = out.doc;
    expect([...doc.querySelectorAll('summary, .section-title, h2')].map((e) => e.textContent).join(' ')).toContain('บัญชี');
    expect(doc.querySelector<HTMLInputElement>('#login-user')!.placeholder).toBe('ชื่อผู้ใช้');
    expect(doc.body.textContent).toContain('เข้าสู่ระบบ');
    expect(doc.body.textContent).toContain('จำรหัสผ่านไว้ในเครื่องนี้');
    out.post(loggedIn);
    expect(doc.querySelector('#sec-current')!.textContent).toContain('คะแนนที่นับ');
    // Grader content stays as it is.
    expect(doc.querySelector('#sec-current')!.textContent).toContain('00_Intro_11');
    // The same bundle in English.
    const en = boot('en');
    en.post(base);
    expect(en.doc.body.textContent).toContain('Remember password on this computer');
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

  it('never submitted: grey "–" pill and "–" counted score on the card', () => {
    const { doc, post } = boot();
    post({ ...loggedIn, problem: { ...loggedIn.problem!, score: score(null, { attempts: 0, latest: null, latestBelowCounted: false, penaltyLabel: null }), status: 'untried' } });
    const pill = doc.querySelectorAll('#sec-problems .score-pill')[1];
    expect(pill.textContent).toBe('–');
    expect(pill.classList.contains('score-none')).toBe(true);
    const big = doc.querySelector('#sec-current .score')!;
    expect(big.textContent).toBe('–');
    expect(big.classList.contains('score-none')).toBe(true);
    expect(big.getAttribute('data-tip')).toBe('Not attempted yet');
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
    expect(doc.querySelectorAll('#sec-problems .problem-row:not([hidden])')).toHaveLength(1); // the untried one
    expect(doc.querySelector('#sec-problems')!.textContent).toContain('1 of 2 problems');
    // Topic pill, three states (default order): not chosen → show only → hide → not chosen.
    const pill = () => doc.querySelector<HTMLButtonElement>('#sec-problems .topic')!;
    expect(pill().className).toBe('topic');
    expect(pill().getAttribute('aria-label')).toBe('ComProg: click to show only ComProg problems');
    pill().click();
    expect(sent.at(-1)).toEqual({ type: 'setFilter', filter: { status: 'unsolved', topic: null, topicsIn: ['ComProg'], topicsOut: [] } });
    post({ ...st, problems: { ...st.problems, filter: { status: 'all', topic: null, topicsIn: ['ComProg'], topicsOut: [] } } });
    expect(pill().classList.contains('active')).toBe(true);
    expect(pill().querySelector('.codicon-check')).not.toBeNull();
    expect(pill().getAttribute('aria-label')).toBe('Showing only ComProg problems. Click to hide ComProg problems');
    expect(doc.querySelectorAll('#sec-problems .problem-row:not([hidden])')).toHaveLength(1); // only the ComProg one
    pill().click();
    expect(sent.at(-1)).toEqual({ type: 'setFilter', filter: { status: 'all', topic: null, topicsIn: [], topicsOut: ['ComProg'] } });
    post({ ...st, problems: { ...st.problems, filter: { status: 'all', topic: null, topicsIn: [], topicsOut: ['ComProg'] } } });
    expect(pill().classList.contains('excluded')).toBe(true);
    expect(pill().querySelector('.codicon-circle-slash')).not.toBeNull();
    expect(pill().getAttribute('aria-label')).toBe('Hiding ComProg problems. Click to stop filtering by ComProg');
    expect(doc.querySelectorAll('#sec-problems .problem-row:not([hidden])')).toHaveLength(1); // the ComProg one is hidden
    pill().click();
    expect(sent.at(-1)).toEqual({ type: 'setFilter', filter: { status: 'all', topic: null, topicsIn: [], topicsOut: [] } });
    // Setting "hide first": the first click hides.
    post({ ...st, problems: { ...st.problems, filter: { status: 'all', topic: null }, topicClickOrder: 'hideFirst' } });
    expect(pill().getAttribute('aria-label')).toBe('ComProg: click to hide ComProg problems');
    pill().click();
    expect(sent.at(-1)).toEqual({ type: 'setFilter', filter: { status: 'all', topic: null, topicsIn: [], topicsOut: ['ComProg'] } });
    // An older saved filter (one topic) shows as "show only".
    post({ ...st, problems: { ...st.problems, filter: { status: 'all', topic: 'ComProg' } } });
    expect(pill().classList.contains('active')).toBe(true);
    expect(doc.querySelector('#sec-problems')!.textContent).not.toMatch(/Random/);
  });

  it('problem rows show their tags; the Tags dropdown filters by several other tags with Any / All', () => {
    const { doc, sent, post } = boot();
    const items = loggedIn.problems.items.map((p, i) => ({ ...p, tags: i === 0 ? ['ComProg', 'Graph', 'DFS'] : ['BFS'] }));
    const st = { ...loggedIn, problems: { ...loggedIn.problems, items, topics: [{ name: 'ComProg', description: null }], tags: ['BFS', 'DFS', 'Graph'] } };
    post(st);
    const firstRow = doc.querySelector('#sec-problems .problem-row:not([hidden])')!;
    expect([...firstRow.querySelectorAll('.problem-tags .tag')].map((t) => t.textContent)).toEqual(['ComProg', 'Graph', 'DFS']);
    expect(firstRow.querySelector('.problem-main')!.getAttribute('aria-label')).toContain('tags: ComProg, Graph, DFS');
    // closed: one toggle; open it
    const toggle = doc.querySelector<HTMLButtonElement>('#sec-problems .tag-toggle')!;
    expect(toggle.textContent).toContain('Tags');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    const boxes = [...doc.querySelectorAll<HTMLInputElement>('#sec-problems .tag-option input[type=checkbox]')];
    expect(boxes.map((b) => b.parentElement!.textContent)).toEqual(['BFS', 'DFS', 'Graph']);
    boxes[2].click();
    expect(sent.at(-1)).toEqual({ type: 'setFilter', filter: { status: 'all', topic: null, tags: ['Graph'], tagMode: 'or' } });
    post({ ...st, problems: { ...st.problems, filter: { status: 'all', topic: null, tags: ['Graph', 'DFS'], tagMode: 'or' } } });
    expect(doc.querySelectorAll('#sec-problems .problem-row:not([hidden])')).toHaveLength(1);
    expect(doc.querySelector('#sec-problems .tag-toggle')!.textContent).toContain('Graph / DFS');
    // Any / All
    const all = [...doc.querySelectorAll<HTMLButtonElement>('#sec-problems .tag-menu .seg')].find((b) => b.textContent === 'All (AND)')!;
    all.click();
    expect(sent.at(-1)).toEqual({ type: 'setFilter', filter: { status: 'all', topic: null, tags: ['Graph', 'DFS'], tagMode: 'and' } });
    // Clear
    [...doc.querySelectorAll<HTMLButtonElement>('#sec-problems .tag-menu button')].find((b) => b.textContent === 'Clear')!.click();
    expect(sent.at(-1)).toEqual({ type: 'setFilter', filter: { status: 'all', topic: null, tags: [], tagMode: 'or' } });
  });

  it('no other tags: no Tags dropdown', () => {
    const { doc, post } = boot();
    post(loggedIn);
    expect(doc.querySelector('#sec-problems .tag-toggle')).toBeNull();
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
    const dismiss = [...n.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Dismiss')!;
    expect(dismiss.dataset.tip).toBe('Hide this notice until the files for this problem change');
    dismiss.click();
    expect(sent.at(-1)).toEqual({ type: 'dismissLinkedNotice' });
    [...doc.querySelectorAll<HTMLButtonElement>('#sec-current .notice.linked button')].find((b) => b.textContent === 'Unlink the other files')!.click();
    expect(sent.at(-1)).toEqual({ type: 'keepOnlyThisFile' });
  });

  it('account shows the full name (Thai) with the login ID below', () => {
    const { doc, post } = boot();
    post({ ...loggedIn, account: { ...loggedIn.account, username: '1234567890', fullName: 'สมชาย ใจดี' } });
    const acc = doc.querySelector('#sec-account .account-name')!;
    expect(acc.querySelector('strong')!.textContent).toBe('สมชาย ใจดี');
    expect(acc.textContent).toContain('1234567890');
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

  it('problem list: all 300 problems in normal flow (no positions or heights set), plain count, no 150 limit', () => {
    const { doc, post } = boot();
    const many = Array.from({ length: 300 }, (_, i) => ({ ...loggedIn.problems.items[1], id: 5000 + i, name: `p_${String(i).padStart(3, '0')}`, fullName: `Problem ${i}` }));
    post({ ...loggedIn, problem: null, problems: { ...loggedIn.problems, items: many } });
    const vp = doc.querySelector<HTMLElement>('#sec-problems .problem-list')!;
    const rows = [...vp.children] as HTMLElement[];
    expect(rows).toHaveLength(300);
    expect(rows.map((r) => r.dataset.key)).toEqual(many.map((p) => String(p.id)));
    // The browser lays the rows out: nothing positions them or fixes their height (that made rows overlap).
    expect(rows.filter((r) => r.style.top || r.style.height || r.style.position)).toEqual([]);
    expect(doc.querySelector('#sec-problems .list-count')!.textContent).toBe('300 problems');
    expect(doc.querySelector('#sec-problems')!.textContent).not.toContain('Refine the filter');
    // filtered count; the remaining rows are the same elements, in order
    const input = doc.querySelector<HTMLInputElement>('#sec-problems input[type=search]')!;
    input.value = 'p_1';
    input.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('input'));
    expect(doc.querySelector('#sec-problems .list-count')!.textContent).toBe('100 of 300 problems');
    const left = [...doc.querySelectorAll('#sec-problems .problem-list > :not([hidden])')];
    expect(left).toHaveLength(100);
    expect(left.every((r) => rows.includes(r as HTMLElement))).toBe(true);
    // cleared: the same 300 elements, in order, none hidden
    input.value = '';
    input.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('input'));
    expect([...vp.children]).toEqual(rows);
    expect(rows.filter((r) => r.hidden)).toEqual([]);
  });

  it('panel CSS: selected row outline inside the row; score facts and verdicts never cut or scroll sideways', () => {
    const css = readFileSync(resolve(__dirname, '../webview/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (sel: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === sel)?.[2] ?? '';
    // The scrolling list clips anything outside a row: the selected row's outline is drawn inside it.
    expect(rule('.problem-row.mapped')).toMatch(/outline-offset:\s*-1px/);
    // "Best 60", "-10 AI assist", …: each item stays on one line; whole items wrap.
    expect(rule('.score-facts > :not(.mono)')).toMatch(/white-space:\s*nowrap/);
    // History details: the verdict cell wraps, so the table fits a narrow panel.
    expect(rule('.evals td.verdict')).toMatch(/white-space:\s*normal/);
  });

  it('problem list CSS: rows stay in normal flow (never absolute, never a fixed height)', () => {
    const css = readFileSync(resolve(__dirname, '../webview/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
    const rowRules = rules.filter((r) => /problem-(row|list)/.test(r.sel) && !/row-actions/.test(r.sel));
    expect(rowRules.length).toBeGreaterThan(3);
    for (const r of rowRules) {
      expect(r.body, r.sel).not.toMatch(/position:\s*(absolute|fixed)/);
      expect(r.body, r.sel).not.toMatch(/(^|[;\s])height:/);
    }
  });

  it('problem list: one Tab stop (roving), ↑ / ↓ / Home / End move between rows, filtering moves the Tab stop', () => {
    const { doc, post } = boot();
    const many = Array.from({ length: 5 }, (_, i) => ({ ...loggedIn.problems.items[1], id: 5000 + i, name: `p_${i}`, fullName: `Problem ${i}` }));
    post({ ...loggedIn, problem: null, problems: { ...loggedIn.problems, items: many } });
    const vp = doc.querySelector<HTMLElement>('#sec-problems .problem-list')!;
    const tabbable = () => [...vp.querySelectorAll<HTMLElement>('button')].filter((b) => b.tabIndex >= 0).map((b) => `${b.closest<HTMLElement>('.problem-row')!.dataset.key}:${b.getAttribute('aria-label')?.split(',')[0]}`);
    expect(tabbable()).toEqual(['5000:p_0 #5000', '5000:Copy problem name', '5000:Find a matching file', '5000:New file for this problem', '5000:Open statement']);
    const key = (k: string) => (doc.activeElement as HTMLElement).dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).KeyboardEvent('keydown', { key: k, bubbles: true }));
    vp.querySelector<HTMLElement>('.problem-main')!.focus();
    key('ArrowDown');
    expect(doc.activeElement!.getAttribute('aria-label')).toMatch(/^p_1 #5001/);
    expect(tabbable()[0]).toBe('5001:p_1 #5001');
    expect(tabbable().filter((t) => t.startsWith('5000:'))).toEqual([]);
    key('End');
    expect(doc.activeElement!.getAttribute('aria-label')).toMatch(/^p_4 #5004/);
    key('ArrowDown'); // last row: stays
    expect(doc.activeElement!.getAttribute('aria-label')).toMatch(/^p_4 #5004/);
    key('Home');
    key('ArrowUp'); // first row: stays
    expect(doc.activeElement!.getAttribute('aria-label')).toMatch(/^p_0 #5000/);
    // A click (focus) on another row moves the Tab stop there.
    vp.querySelectorAll<HTMLElement>('.problem-main')[3].focus();
    expect(tabbable()[0]).toBe('5003:p_3 #5003');
    // The current row filtered out: the first remaining row gets the Tab stop.
    const input = doc.querySelector<HTMLInputElement>('#sec-problems input[type=search]')!;
    input.value = 'p_2';
    input.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('input'));
    expect(tabbable()[0]).toBe('5002:p_2 #5002');
  });

  it('problem list: a filter keystroke over 292 problems is fast (cached rows are moved, not rebuilt)', () => {
    const { doc, post } = boot();
    const many = Array.from({ length: 292 }, (_, i) => ({ ...loggedIn.problems.items[1], id: 5000 + i, name: `p_${String(i).padStart(3, '0')}`, fullName: `Problem ${i}: a longer full name`, tags: ['DataAlgo', 'Graph', 'S-Path'].slice(0, i % 4) }));
    post({ ...loggedIn, problem: null, problems: { ...loggedIn.problems, items: many } });
    const input = doc.querySelector<HTMLInputElement>('#sec-problems input[type=search]')!;
    const type = (v: string) => {
      input.value = v;
      input.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('input'));
    };
    type('p'); // warm up
    type('');
    const times: number[] = [];
    for (const v of ['p_1', 'p_', 'p_2', 'p', '', 'p_0', '']) {
      const t = performance.now();
      type(v);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(10); // median keystroke, ms
    expect(doc.querySelectorAll('#sec-problems .problem-list > :not([hidden])')).toHaveLength(292);
  });

  it('click a row near the bottom: after the file opens the scroll position is unchanged and the row shows ✓', () => {
    const { doc, sent, post } = boot();
    const many = Array.from({ length: 300 }, (_, i) => ({ ...loggedIn.problems.items[1], id: 5000 + i, name: `p_${String(i).padStart(3, '0')}`, fullName: `Problem ${i}` }));
    const st = { ...loggedIn, problem: null, problems: { ...loggedIn.problems, items: many } };
    post(st);
    const vp = doc.querySelector<HTMLElement>('#sec-problems .problem-list')!;
    let top = 0; // jsdom has no layout: back scrollTop with a value and send the scroll event
    Object.defineProperty(vp, 'scrollTop', { get: () => top, set: (v: number) => { top = v; }, configurable: true });
    top = 280 * 38;
    vp.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('scroll'));
    const rowEl = [...vp.querySelectorAll<HTMLElement>('.problem-row')].find((r) => r.textContent?.includes('p_285'))!;
    const before = [...vp.querySelectorAll('.problem-row')];
    rowEl.querySelector<HTMLButtonElement>('.problem-main')!.click();
    expect(sent.at(-1)).toEqual({ type: 'problemRowClick', problemId: 5285 });
    // the extension opens the file → the active problem changes
    post({ ...st, problem: { ...many[285], source: 'filename', sourceLabel: 'Matched by file name', unavailable: false } });
    expect(top).toBe(280 * 38); // unchanged
    expect(doc.querySelector('#sec-problems .problem-list')).toBe(vp); // same element, not re-created
    const now = [...vp.querySelectorAll<HTMLElement>('.problem-row')];
    const marked = now.find((r) => r.textContent?.includes('p_285'))!;
    expect(marked.classList.contains('mapped')).toBe(true);
    expect(marked.querySelector('.codicon-check')).not.toBeNull();
    // only the changed row was rebuilt; the others are the same elements
    expect(now.filter((r) => !before.includes(r))).toEqual([marked]);
  });

  it('active file changed by the user (not a row click): minimal scroll to the row; scroll kept in webview state', () => {
    const { doc, post, saved } = boot();
    const many = Array.from({ length: 300 }, (_, i) => ({ ...loggedIn.problems.items[1], id: 5000 + i, name: `p_${String(i).padStart(3, '0')}`, fullName: `Problem ${i}` }));
    const st = { ...loggedIn, problem: null, problems: { ...loggedIn.problems, items: many } };
    post(st);
    const vp = doc.querySelector<HTMLElement>('#sec-problems .problem-list')!;
    let top = 0;
    Object.defineProperty(vp, 'scrollTop', { get: () => top, set: (v: number) => { top = v; }, configurable: true });
    Object.defineProperty(vp, 'clientHeight', { get: () => 420, configurable: true });
    // jsdom has no layout: rows 38 px tall, in order (the browser lays them out in normal flow).
    const proto = (doc.defaultView as unknown as typeof globalThis).HTMLElement.prototype;
    Object.defineProperty(proto, 'offsetTop', { configurable: true, get(this: HTMLElement) { return this.parentElement === vp ? [...vp.children].indexOf(this) * 38 : 0; } });
    Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => 38 });
    post({ ...st, problem: { ...many[5], source: 'filename', sourceLabel: 'Matched by file name', unavailable: false } });
    expect(top).toBe(0); // already visible: no scroll
    post({ ...st, problem: { ...many[200], source: 'filename', sourceLabel: 'Matched by file name', unavailable: false } });
    expect(top).toBe(201 * 38 - 420); // just enough to show it at the bottom ("nearest"), not to the top
    vp.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('scroll'));
    return new Promise<void>((r) => setTimeout(() => {
      expect((saved() as { listScroll: number }).listScroll).toBe(201 * 38 - 420);
      r();
    }, 200));
  });

  it('score rule everywhere: "x / 100", raw-sum problems show the raw number with a tooltip', () => {
    const { doc, post } = boot();
    post(loggedIn);
    expect(doc.querySelector('#sec-current .score')!.textContent).toBe('70 / 100');
    expect(doc.querySelector('#sec-result .score')!.textContent).toBe('70 / 100');
    expect(doc.querySelector('#sec-history .history-row .pill')!.getAttribute('data-tip')).toBe('70 / 100');
    const raw = score(37, { rawSum: true, outOf: null });
    post({ ...loggedIn, problem: { ...loggedIn.problem!, score: raw }, problems: { ...loggedIn.problems, items: [{ ...loggedIn.problems.items[0], score: raw }] } });
    const card = doc.querySelector<HTMLElement>('#sec-current .score')!;
    expect(card.textContent).toBe('37');
    expect(card.dataset.tip).toMatch(/raw-sum scoring/);
    expect(doc.querySelector('#sec-result .score')!.textContent).toBe('70'); // the result's raw points, no "/ 100"
    expect(doc.querySelector('#sec-history .history-row .pill')!.getAttribute('data-tip')).toMatch(/^70\. .*raw-sum/);
    expect(doc.querySelector('#sec-problems .score-pill')!.getAttribute('data-tip')).toMatch(/raw-sum scoring/);
  });

  it('"Rename file to match the problem" only when the name does not match', () => {
    const { doc, sent, post } = boot();
    post(loggedIn); // renameTo: null → hidden
    expect(doc.querySelector('#sec-current')!.textContent).not.toContain('Rename file to match the problem');
    post({ ...loggedIn, file: { ...loggedIn.file!, name: 'sol.cpp', renameTo: '00_Intro_11.cpp' } });
    const link = [...doc.querySelectorAll<HTMLButtonElement>('#sec-current button')].find((b) => b.textContent === 'Rename file to match the problem')!;
    expect(link.dataset.tip).toBe('Rename sol.cpp to 00_Intro_11.cpp (you can edit the name first)');
    link.click();
    expect(sent.at(-1)).toEqual({ type: 'renameFileToProblem' });
    expect(rightClick(doc, header(doc))).toContain('Rename file to match the problem');
  });

  it('inline prompt (no modal): text, detail and plain buttons answer by id', () => {
    const { doc, sent, post } = boot();
    post({ ...loggedIn, prompt: { id: 7, text: 'Auto-detect found 104_exam67_1_P2 (from CPH data).', detail: null, tone: 'info', buttons: [{ id: 'switch', label: 'Switch to it', primary: true }, { id: 'keep', label: 'Keep current' }], near: null } });
    const bar = doc.querySelector<HTMLElement>('.prompt')!;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('Auto-detect found 104_exam67_1_P2 (from CPH data).');
    [...bar.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Keep current')!.click();
    expect(sent.at(-1)).toEqual({ type: 'promptAnswer', id: 7, button: 'keep' });
    post({ ...loggedIn, prompt: null });
    expect(doc.querySelector<HTMLElement>('.prompt')!.hidden).toBe(true);
  });

  it('a question about submitting is shown right above the Submit button (at the top only when Current problem is hidden)', () => {
    const { doc, sent, post } = boot();
    const q = {
      id: 9,
      text: 'Which file do you submit to 00_Intro_11 (#1360)?',
      detail: 'The grader takes one file per submission.',
      tone: 'info' as const,
      buttons: [{ id: 'target', label: 'Submit student.h', primary: true }, { id: 'open', label: 'Submit main.cpp (open file)' }, { id: 'cancel', label: 'Cancel' }],
      near: 'submit' as const,
    };
    post({ ...loggedIn, prompt: q });
    expect(doc.querySelector<HTMLElement>('.prompt:not(#submit-prompt)')!.hidden).toBe(true);
    const box = doc.querySelector<HTMLElement>('#sec-current #submit-prompt')!;
    expect(box.textContent).toContain('Which file do you submit');
    expect(box.nextElementSibling?.id).toBe('submit-btn');
    [...box.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Submit main.cpp (open file)')!.click();
    expect(sent.at(-1)).toEqual({ type: 'promptAnswer', id: 9, button: 'open' });
    post({ ...loggedIn, prompt: null });
    expect(doc.querySelector('#submit-prompt')).toBeNull();
    // Current problem hidden by the layout: the question goes to the top.
    post({ ...loggedIn, layout: { sections: ['account', 'result', 'history', 'problems'], compact: false }, prompt: q });
    expect(doc.querySelector('#submit-prompt')).toBeNull();
    const bar = doc.querySelector<HTMLElement>('.prompt')!;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('Which file do you submit');
  });

  it('Result has no Resubmit button (Submit to Grader is the one way to submit)', () => {
    const { doc, post } = boot();
    post(loggedIn);
    const sec = doc.querySelector('#sec-result')!;
    expect(sec.querySelector('.score')).not.toBeNull(); // a finished result is shown
    expect(sec.textContent).not.toMatch(/Resubmit/);
    expect(sec.querySelector('.codicon-debug-restart')).toBeNull();
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

  it('✕ in every state: "Unlink this file" for a chosen link, "Don\'t match this file" for name / CPH matches and suggestions', () => {
    const { doc, sent, post } = boot();
    const x = () => header(doc).querySelector<HTMLButtonElement>('.codicon-close')!.closest('button')!;
    for (const [source, label] of [
      ['saved', "Unlink this file (removes your choice; auto-detect won't link it again)"],
      ['filename', "Don't match this file (auto-detect won't link it to a problem again)"],
      ['cph', "Don't match this file (auto-detect won't link it to a problem again)"],
      ['suggested', "Don't match this file (auto-detect won't link it to a problem again)"],
    ] as const) {
      post({ ...loggedIn, problem: { ...loggedIn.problem!, source, sourceLabel: source } });
      expect(x().getAttribute('aria-label'), source).toBe(label);
      expect(x().getAttribute('data-tip'), source).toBe(label);
      x().click();
      expect(sent.at(-1)).toEqual({ type: 'unmapProblem' });
    }
    // right-click offers the same, with the short label
    post({ ...loggedIn, problem: { ...loggedIn.problem!, source: 'suggested', sourceLabel: 'suggested' } });
    expect(rightClick(doc, header(doc)).at(-1)).toBe("Don't match this file");
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
    expect(doc.querySelectorAll('#sec-problems .problem-row:not([hidden])')).toHaveLength(1);
    expect(saved()).toMatchObject({ filter: 'expr' });
  });

  it('compile error shows the compiler message as text', () => {
    const { doc, post } = boot();
    post({ ...loggedIn, result: { ...loggedIn.result!, points: 0, verdicts: [], compileError: true, compilerMessage: 'a.cpp:1: error: <script>' } });
    expect(doc.querySelector('.compiler pre')!.textContent).toBe('a.cpp:1: error: <script>');
    expect(doc.querySelector('script')).toBeNull();
  });
});
