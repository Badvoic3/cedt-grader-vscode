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
import type { FromWebview, ViewState } from '../src/shared/messages';

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

const base: ViewState = {
  baseUrl: 'https://cedt-grader.nattee.net',
  account: { status: 'logged-out', username: '', hasSavedPassword: false, error: null },
  file: null,
  problem: null,
  languages: { loading: false, items: [], selectedId: null, forced: false, error: null },
  gradingElsewhere: null,
  submit: { enabled: false, busy: false, reason: 'Open a source file to submit it.', label: 'Submit to Grader' },
  result: null,
  history: [],
  problems: { loading: false, loaded: false, items: [], error: null },
};

const loggedIn: ViewState = {
  ...base,
  account: { status: 'logged-in', username: 'student', hasSavedPassword: true, error: null },
  file: { path: 'grader/00 11 intro.cpp', name: '00 11 intro.cpp', languageGuess: 'C++', supported: true },
  problem: { id: 1360, name: '00_Intro_11', fullName: '<img src=x onerror=alert(1)>', bestScore: 100, source: 'mapping', statementUrl: null },
  languages: { loading: false, items: [{ id: 1, name: 'C' }, { id: 2, name: 'C++' }], selectedId: 2, forced: false, error: null },
  submit: { enabled: true, busy: false, reason: null, label: 'Submit to Grader' },
  result: {
    phase: 'done', problemId: 1360, problemName: '00_Intro_11', submissionId: 2460977, submissionUrl: 'https://x/submissions/2460977',
    score: 70, scoreHidden: false, tries: 2, time: '12:43:48', comment: 'PP-T',
    verdicts: [
      { index: 1, ok: true, kind: 'correct', label: 'Test 1 of 4: Correct' },
      { index: 2, ok: true, kind: 'correct', label: 'Test 2 of 4: Correct' },
      { index: 3, ok: false, kind: 'wrong', label: 'Test 3 of 4: Wrong Answer' },
      { index: 4, ok: false, kind: 'brand_new', label: 'Test 4 of 4: <b>Mystery</b>', group: 1 },
    ],
    compileError: false, compilerMessage: null, message: null,
  },
  history: [{ submissionId: 2460977, url: 'https://x/submissions/2460977', score: 70, comment: 'PP-T', time: '12:43:48', compileError: false }],
  problems: { loading: false, loaded: true, items: [{ id: 1360, name: '00_Intro_11', fullName: 'Hello', bestScore: 100 }, { id: 1271, name: '01_Expr_11', fullName: 'An Expression', bestScore: null }], error: null },
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
    expect(sent.at(-1)).toEqual({ type: 'login', username: 'student', password: 's3cret' });
    expect(doc.querySelector<HTMLInputElement>('#login-pass')!.value).toBe('');
    expect(JSON.stringify(saved() ?? {})).not.toContain('s3cret');
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
    expect(doc.querySelector('.score')!.textContent).toBe('70 / 100');
    expect(doc.querySelectorAll('.history-row')).toHaveLength(1);
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
    post({ ...loggedIn, result: { ...loggedIn.result!, score: 0, verdicts: [], compileError: true, compilerMessage: 'a.cpp:1: error: <script>' } });
    expect(doc.querySelector('.compiler pre')!.textContent).toBe('a.cpp:1: error: <script>');
    expect(doc.querySelector('script')).toBeNull();
  });
});
