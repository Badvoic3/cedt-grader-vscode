/*
 * CEDT Grader sidebar webview. Plain DOM, no framework.
 *
 * Security: every string that may come from the grader is inserted with
 * textContent / attributes only, never innerHTML. The webview has no network
 * access (CSP default-src 'none'); all actions are postMessage'd to the host.
 */
import type { FromWebview, ProblemView, ToWebview, VerdictView, ViewState } from '../src/shared/messages';

interface VsCodeApi {
  postMessage(m: FromWebview): void;
  getState(): UiState | undefined;
  setState(s: UiState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

/** UI-only state persisted by VS Code for this view. Never holds credentials. */
interface UiState {
  collapsed: Record<string, boolean>;
  filter: string;
}

const vscode = acquireVsCodeApi();
const ui: UiState = { collapsed: {}, filter: '', ...(vscode.getState() ?? {}) };
const saveUi = () => vscode.setState({ collapsed: ui.collapsed, filter: ui.filter });
const send = (m: FromWebview) => vscode.postMessage(m);

// ------------------------------------------------------------------ helpers

type Child = Node | string | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') e.className = String(v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  appendChildren(e, children);
  return e;
}

function appendChildren(parent: Node & ParentNode, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(parent, c);
    else parent.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

const icon = (name: string, extra = '') => el('span', { class: `codicon codicon-${name} ${extra}`.trim(), 'aria-hidden': 'true' });

function iconButton(name: string, title: string, onclick: () => void, extra: Attrs = {}): HTMLButtonElement {
  return el('button', { class: 'icon-btn', title, 'aria-label': title, type: 'button', onclick, ...extra }, icon(name));
}

function button(label: Child, onclick: () => void, opts: { kind?: 'primary' | 'secondary' | 'big'; disabled?: boolean; title?: string } = {}) {
  return el(
    'button',
    { class: `btn ${opts.kind ?? 'secondary'}`, type: 'button', disabled: opts.disabled, title: opts.title, onclick },
    label,
  );
}

function scoreClass(score: number | null): string {
  if (score === null) return 'score-none';
  if (score >= 100) return 'score-full';
  if (score <= 0) return 'score-zero';
  return 'score-partial';
}

function scorePill(score: number | null): HTMLElement {
  return el('span', { class: `pill ${scoreClass(score)}`, title: score === null ? 'No score' : `Best score ${score}` }, score === null ? '–' : String(score));
}

const contestBadge = () => el('span', { class: 'badge contest', title: 'Contest/exam detected' }, icon('warning'), 'contest');

function fmtScore(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// -------------------------------------------------------------- skeleton

const app = document.getElementById('app')!;

function section(id: string, title: string, actions: HTMLElement[] = []) {
  const body = el('div', { class: 'section-body' });
  const details = el(
    'details',
    { class: 'section', id: `sec-${id}`, open: !ui.collapsed[id] },
    el('summary', {}, icon('chevron-right', 'chev'), el('span', { class: 'section-title' }, title), el('span', { class: 'section-actions' }, ...actions)),
    body,
  );
  details.addEventListener('toggle', () => {
    ui.collapsed[id] = !details.open;
    saveUi();
  });
  // Clicking an action button must not toggle the section.
  for (const a of actions) a.addEventListener('click', (e) => e.preventDefault());
  return { details, body };
}

// Persistent inputs (kept across renders so typing is never interrupted).
const loginUser = el('input', { type: 'text', id: 'login-user', autocomplete: 'username', spellcheck: 'false', placeholder: 'Username' });
const loginPass = el('input', { type: 'password', id: 'login-pass', autocomplete: 'current-password', placeholder: 'Password' });
const loginForm = el(
  'form',
  { class: 'login-form', onsubmit: (e: Event) => {
    e.preventDefault();
    const password = loginPass.value;
    loginPass.value = ''; // never kept in the webview
    send({ type: 'login', username: loginUser.value, password });
  } },
  el('label', { for: 'login-user' }, 'Username'),
  loginUser,
  el('label', { for: 'login-pass' }, 'Password'),
  loginPass,
  el('button', { class: 'btn primary', type: 'submit' }, icon('sign-in'), ' Log in'),
);
let showLoginForm = false;

const pickerSearch = el('input', { type: 'search', class: 'picker-search', placeholder: 'Search problems…', 'aria-label': 'Search problems', spellcheck: 'false' });
const pickerList = el('div', { class: 'picker-list', role: 'listbox' });
let pickerOpen = false;

const problemFilter = el('input', { type: 'search', placeholder: 'Filter problems…', 'aria-label': 'Filter problems', spellcheck: 'false', value: ui.filter });

const sAccount = section('account', 'Account');
const sCurrent = section('current', 'Current problem');
const sResult = section('result', 'Result');
const sHistory = section('history', 'History');
const sProblems = section('problems', 'Problems', [
  iconButton('refresh', 'Reload problem list', () => send({ type: 'refreshProblems' })),
]);
app.append(sAccount.details, sCurrent.details, sResult.details, sHistory.details, sProblems.details);

let state: ViewState | null = null;

// -------------------------------------------------------------- sections

function renderAccount(s: ViewState): void {
  const b = sAccount.body;
  b.replaceChildren();
  const a = s.account;
  const host = (() => {
    try {
      return new URL(s.baseUrl).host;
    } catch {
      return s.baseUrl;
    }
  })();
  if (a.status === 'logged-in') {
    b.append(
      el('div', { class: 'row account' },
        el('span', { class: 'dot ok', 'aria-hidden': 'true' }),
        el('span', { class: 'grow ellipsis', title: `${a.username} on ${host}` }, el('strong', {}, a.username), el('span', { class: 'muted' }, ` · ${host}`)),
        button([icon('sign-out'), ' Log out'], () => send({ type: 'logout' })),
      ),
    );
    return;
  }
  if (a.status === 'logging-in') {
    b.append(el('div', { class: 'row muted' }, icon('loading', 'codicon-modifier-spin'), ` Logging in to ${host}…`));
    return;
  }
  if (a.hasSavedPassword && a.username && !showLoginForm) {
    b.append(
      el('div', { class: 'row' },
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('span', { class: 'grow ellipsis' }, 'Saved login: ', el('strong', {}, a.username)),
      ),
      el('div', { class: 'row gap' },
        button([icon('sign-in'), ' Log in'], () => send({ type: 'loginSaved' }), { kind: 'primary' }),
        el('button', { class: 'link', type: 'button', onclick: () => { showLoginForm = true; render(); } }, 'Use another account'),
      ),
    );
  } else {
    if (!loginUser.value && a.username) loginUser.value = a.username;
    b.append(loginForm);
  }
  if (a.error) b.append(el('div', { class: 'error', role: 'alert' }, icon('error'), ' ', a.error));
  b.append(
    el('p', { class: 'hint' },
      icon('lock'), ' Your password is kept in the OS keychain (VS Code SecretStorage). ',
      el('strong', {}, 'Do not log in from VS Code during an exam.'),
    ),
  );
}

function renderPicker(s: ViewState): HTMLElement {
  const items = s.problems.items;
  const q = pickerSearch.value.trim().toLowerCase();
  const hits = q ? items.filter((p) => p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)) : items;
  pickerList.replaceChildren();
  if (!s.problems.loaded) {
    appendChildren(pickerList, [
      el('div', { class: 'muted pad' }, s.problems.loading ? 'Loading problems…' : 'Problem list not loaded. '),
      !s.problems.loading && button('Load problems', () => send({ type: 'refreshProblems' })),
    ]);
  } else if (hits.length === 0) {
    pickerList.append(el('div', { class: 'muted pad' }, 'No matching problems.'));
  } else {
    for (const p of hits.slice(0, 50)) pickerList.append(problemRow(p, s, 'picker'));
    if (hits.length > 50) pickerList.append(el('div', { class: 'muted pad' }, `${hits.length - 50} more. Refine the search.`));
  }
  return el('div', { class: 'picker' }, pickerSearch, pickerList);
}

function renderCurrent(s: ViewState): void {
  const b = sCurrent.body;
  b.replaceChildren();
  if (!s.file) {
    b.append(el('p', { class: 'muted' }, icon('file'), ' Open a source file to submit it.'));
    return;
  }
  b.append(
    el('div', { class: 'row file', title: s.file.path },
      icon(s.file.supported ? 'file-code' : 'file'),
      el('span', { class: 'grow ellipsis' }, s.file.name),
      s.file.languageGuess ? el('span', { class: 'muted small' }, s.file.languageGuess) : el('span', { class: 'muted small' }, 'unknown type'),
    ),
  );

  // Problem.
  const p = s.problem;
  const current = el(
    'button',
    { class: 'combo', type: 'button', 'aria-expanded': String(pickerOpen), title: p ? `${p.name} — ${p.fullName}` : 'Choose problem', onclick: () => {
      pickerOpen = !pickerOpen;
      if (pickerOpen && !s.problems.loaded && !s.problems.loading) send({ type: 'refreshProblems' });
      render();
      if (pickerOpen) pickerSearch.focus();
    } },
    p
      ? el('span', { class: 'grow ellipsis' }, el('strong', {}, p.name), p.fullName && p.fullName !== p.name ? el('span', { class: 'muted' }, ` ${p.fullName}`) : null)
      : el('span', { class: 'grow muted' }, 'Choose problem…'),
    icon(pickerOpen ? 'chevron-up' : 'chevron-down'),
  );
  b.append(
    el('div', { class: 'field' },
      el('div', { class: 'field-label' }, 'Problem',
        p && p.source === 'cph' ? el('span', { class: 'badge', title: 'Matched from the CPH problem file. Pick it again to save the mapping.' }, 'from CPH') : null,
        s.contest?.blocked && p ? contestBadge() : null,
        p ? scorePill(p.bestScore) : null,
        el('span', { class: 'grow' }),
        p ? iconButton('link-external', 'Open problem statement', () => send({ type: 'openStatement', problemId: p.id })) : null,
        p ? iconButton('close', 'Forget the problem for this file', () => send({ type: 'unmapProblem' })) : null,
      ),
      current,
      pickerOpen ? renderPicker(s) : null,
    ),
  );

  // Language.
  if (p) {
    const L = s.languages;
    const select = el('select', { id: 'lang', disabled: L.loading || L.forced || L.items.length === 0, onchange: (e: Event) => {
      send({ type: 'selectLanguage', languageId: Number((e.target as HTMLSelectElement).value) });
    } });
    if (L.items.length === 0) select.append(el('option', {}, L.loading ? 'Loading…' : '—'));
    if (L.selectedId === null && L.items.length) select.append(el('option', { value: '', selected: true, disabled: true }, 'Choose language…'));
    for (const l of L.items) select.append(el('option', { value: l.id, selected: l.id === L.selectedId }, l.name));
    b.append(
      el('div', { class: 'field' },
        el('label', { class: 'field-label', for: 'lang' }, 'Language', L.forced ? el('span', { class: 'muted small' }, ' (set by the problem)') : null),
        select,
      ),
    );
  }

  // Contest notice.
  if (p && s.contest?.blocked) {
    b.append(
      el('div', { class: 'notice warn', role: 'alert' },
        el('div', { class: 'row' }, contestBadge(), el('strong', { class: 'grow' }, s.contest.contestName ?? 'Contest / exam')),
        el('p', {}, 'This problem is part of an active contest/exam. Submit through the website.'),
        !s.contest.certain ? el('p', { class: 'small muted' }, 'Detection was uncertain, so it is treated as a contest.') : null,
        s.contest.allowSetting ? el('p', { class: 'small' }, 'Contest submissions are enabled in settings. You will be asked to confirm instructor permission every time.') : null,
        el('div', { class: 'row gap' },
          button([icon('globe'), ' Open in browser'], () => send({ type: 'openProblemInBrowser', problemId: p.id })),
          button([icon('refresh'), ' Recheck'], () => send({ type: 'recheckProblem' })),
        ),
      ),
    );
  }

  // Submit.
  const sub = s.submit;
  b.append(
    el('button', { class: 'btn big', type: 'button', id: 'submit-btn', disabled: !sub.enabled, onclick: () => send({ type: 'submit' }), 'aria-describedby': sub.reason ? 'submit-reason' : undefined },
      sub.busy ? icon('loading', 'codicon-modifier-spin') : icon('cloud-upload'),
      ` ${sub.busy ? 'Grading…' : sub.label}`,
    ),
  );
  if (sub.reason && !(p && s.contest?.blocked && !s.contest.allowSetting)) {
    b.append(el('p', { class: 'hint', id: 'submit-reason' }, icon('info'), ' ', sub.reason));
  }
  if (s.languages.error && p) b.append(el('div', { class: 'error' }, icon('error'), ' ', s.languages.error));
}

const VERDICT_LETTER: Record<string, string> = {
  correct: 'P', wrong: '-', partial: 's', time_limit: 'T', memory_limit: 'M', crash: 'x', unknown_error: 'E', grader_error: '!', waiting: '?',
};

function verdictTile(v: VerdictView): HTMLElement {
  const known = v.kind in VERDICT_LETTER;
  return el('span', { class: `tile v-${known ? v.kind : 'unknown'}`, title: v.label, role: 'img', 'aria-label': v.label }, VERDICT_LETTER[v.kind] ?? '?');
}

function verdictStrip(verdicts: VerdictView[]): HTMLElement {
  const strip = el('div', { class: 'strip', role: 'group', 'aria-label': 'Verdict per test' });
  let group: HTMLElement | null = null;
  let groupNo: number | undefined;
  for (const v of verdicts) {
    if (v.group !== undefined) {
      if (!group || groupNo !== v.group) {
        group = el('span', { class: 'tile-group', title: `Group ${v.group}: scored together (lowest score counts)` });
        groupNo = v.group;
        strip.append(group);
      }
      group.append(verdictTile(v));
    } else {
      group = null;
      groupNo = undefined;
      strip.append(verdictTile(v));
    }
  }
  return strip;
}

function renderResult(s: ViewState): void {
  const b = sResult.body;
  b.replaceChildren();
  const r = s.result;
  if (!r) {
    b.append(el('p', { class: 'muted' }, 'No submission yet in this session.'));
    return;
  }
  const head = el('div', { class: 'row result-head' },
    el('span', { class: 'ellipsis' }, el('strong', {}, r.problemName)),
    r.contest ? contestBadge() : null,
    el('span', { class: 'grow' }),
    r.submissionId
      ? el('button', { class: 'link', type: 'button', title: 'Open the submission in the browser', onclick: () => send({ type: 'openSubmission', submissionId: r.submissionId! }) }, `#${r.submissionId}`, icon('link-external'))
      : null,
  );
  b.append(head);

  if (r.phase === 'submitting' || r.phase === 'grading') {
    b.append(el('div', { class: 'row status' }, icon('loading', 'codicon-modifier-spin'), ' ', r.message ?? 'Grading…'));
  }
  if (r.phase === 'done' || ((r.phase === 'timeout' || r.phase === 'error') && r.verdicts.length)) {
    const scoreText = r.compileError ? 'Compilation error' : r.score !== null ? `${fmtScore(r.score)} / 100` : r.scoreHidden ? 'Graded (score hidden by the server)' : r.message ?? '';
    b.append(
      el('div', { class: 'row score-row' },
        el('span', { class: `score ${r.compileError ? 'score-zero' : scoreClass(r.score)}` }, scoreText),
        el('span', { class: 'grow' }),
        r.tries !== null ? el('span', { class: 'muted small' }, `try ${r.tries}`) : null,
        r.time ? el('span', { class: 'muted small' }, ` · ${r.time}`) : null,
      ),
    );
    if (r.verdicts.length) b.append(verdictStrip(r.verdicts));
    else if (r.comment && !r.compileError) b.append(el('code', { class: 'comment' }, r.comment));
    const failed = r.verdicts.filter((v) => !v.ok);
    if (failed.length && failed.length <= 6) {
      b.append(el('ul', { class: 'failed' }, ...failed.map((v) => el('li', {}, v.label))));
    }
  }
  if (r.compileError) {
    b.append(
      el('details', { class: 'compiler', open: true },
        el('summary', {}, 'Compiler message'),
        r.compilerMessage !== null ? el('pre', {}, r.compilerMessage || '(empty)') : el('p', { class: 'muted' }, 'Loading…'),
        button([icon('go-to-file'), ' Open in editor'], () => send({ type: 'showCompilerMessage' })),
      ),
    );
  }
  if (r.phase === 'timeout' || r.phase === 'error') {
    b.append(el('div', { class: r.phase === 'error' ? 'error' : 'notice' }, icon(r.phase === 'error' ? 'error' : 'clock'), ' ', r.message ?? ''));
  }
  if (r.phase !== 'submitting' && r.phase !== 'grading') {
    b.append(el('div', { class: 'row gap' }, button([icon('debug-restart'), ' Resubmit'], () => send({ type: 'resubmit' }), { disabled: !s.submit.enabled, title: s.submit.reason ?? 'Submit the current file again' })));
  }
}

function renderHistory(s: ViewState): void {
  const b = sHistory.body;
  b.replaceChildren();
  if (!s.problem) {
    b.append(el('p', { class: 'muted' }, 'Choose a problem to see its history.'));
    return;
  }
  if (!s.history.length) {
    b.append(el('p', { class: 'muted' }, 'No submissions from VS Code yet for this problem.'));
    return;
  }
  const list = el('div', { class: 'history' });
  for (const h of s.history) {
    list.append(
      el('button', { class: 'history-row', type: 'button', title: `Open submission #${h.submissionId}`, onclick: () => send({ type: 'openSubmission', submissionId: h.submissionId }) },
        el('span', { class: 'mono muted' }, `#${h.submissionId}`),
        el('span', { class: `pill ${h.compileError ? 'score-zero' : scoreClass(h.score)}` }, h.compileError ? 'CE' : h.score === null ? '–' : fmtScore(h.score)),
        el('span', { class: 'mono grow ellipsis small' }, h.comment ?? ''),
        el('span', { class: 'muted small' }, h.time),
      ),
    );
  }
  b.append(list);
}

function problemRow(p: ProblemView, s: ViewState, where: 'picker' | 'list'): HTMLElement {
  const mapped = s.problem?.id === p.id;
  const row = el('div', { class: `problem-row${mapped ? ' mapped' : ''}`, role: where === 'picker' ? 'option' : undefined, 'aria-selected': where === 'picker' ? String(mapped) : undefined },
    el('button', { class: 'problem-main', type: 'button', disabled: !s.file, title: s.file ? `Use ${p.name} for ${s.file.name}` : 'Open a source file to map a problem', onclick: () => {
      pickerOpen = false;
      send({ type: 'mapProblem', problemId: p.id });
    } },
      el('span', { class: 'problem-name ellipsis' }, mapped ? icon('check') : null, p.name),
      p.fullName && p.fullName !== p.name ? el('span', { class: 'problem-full ellipsis muted' }, p.fullName) : null,
    ),
    scorePill(p.bestScore),
    iconButton('link-external', `Open the statement of ${p.name}`, () => send({ type: 'openStatement', problemId: p.id })),
  );
  return row;
}

function renderProblems(s: ViewState): void {
  const b = sProblems.body;
  b.replaceChildren();
  const P = s.problems;
  if (!P.loaded) {
    if (P.loading) b.append(el('p', { class: 'muted' }, icon('loading', 'codicon-modifier-spin'), ' Loading problems…'));
    else if (s.account.status !== 'logged-in' && !s.account.hasSavedPassword) b.append(el('p', { class: 'muted' }, 'Log in to see your problems.'));
    else b.append(button([icon('refresh'), ' Load problems'], () => send({ type: 'refreshProblems' })));
    if (P.error) b.append(el('div', { class: 'error' }, icon('error'), ' ', P.error));
    return;
  }
  if (P.contest) b.append(el('div', { class: 'notice warn small' }, contestBadge(), ' The grader is in contest/exam mode. Submit through the website.'));
  b.append(problemFilter);
  const q = problemFilter.value.trim().toLowerCase();
  const hits = q ? P.items.filter((p) => p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q)) : P.items;
  const list = el('div', { class: 'problem-list' });
  for (const p of hits.slice(0, 150)) list.append(problemRow(p, s, 'list'));
  b.append(list);
  b.append(el('p', { class: 'muted small' }, hits.length > 150 ? `Showing 150 of ${hits.length}. Refine the filter.` : `${hits.length} of ${P.items.length} problems`));
  if (P.loading) b.append(el('p', { class: 'muted small' }, icon('loading', 'codicon-modifier-spin'), ' Refreshing…'));
  if (P.error) b.append(el('div', { class: 'error' }, icon('error'), ' ', P.error));
}

// ---------------------------------------------------------------- wiring

function render(): void {
  if (!state) {
    sAccount.body.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
    return;
  }
  const active = document.activeElement;
  renderAccount(state);
  renderCurrent(state);
  renderResult(state);
  renderHistory(state);
  renderProblems(state);
  // Persistent inputs survive re-render; restore focus if it was on one of them.
  if (active instanceof HTMLInputElement && document.body.contains(active)) active.focus();
}

pickerSearch.addEventListener('input', () => state && renderPicker(state));
pickerSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    pickerOpen = false;
    render();
  } else if (e.key === 'Enter') {
    const first = pickerList.querySelector<HTMLButtonElement>('.problem-main:not([disabled])');
    first?.click();
  }
});
problemFilter.addEventListener('input', () => {
  ui.filter = problemFilter.value;
  saveUi();
  if (state) {
    renderProblems(state);
    problemFilter.focus();
  }
});

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'state') {
    if (state && state.account.status !== 'logged-in' && m.state.account.status === 'logged-in') showLoginForm = false;
    state = m.state;
    render();
  } else if (m.type === 'focus') {
    if (m.target === 'login') {
      showLoginForm = true;
      ui.collapsed.account = false;
      sAccount.details.open = true;
      render();
      (loginUser.value ? loginPass : loginUser).focus();
    } else if (m.target === 'problem-search') {
      pickerOpen = true;
      render();
      pickerSearch.focus();
    } else {
      document.getElementById('submit-btn')?.focus();
    }
  }
});

render();
send({ type: 'ready' });
