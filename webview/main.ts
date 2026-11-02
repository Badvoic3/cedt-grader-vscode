/*
 * CEDT Grader sidebar webview. Plain DOM, no framework.
 *
 * Security: every string that may come from the grader is inserted with
 * textContent / attributes only, never innerHTML. The webview has no network
 * access (CSP default-src 'none'); all actions are postMessage'd to the host.
 */
import type { FromWebview, HistoryEntry, ProblemView, ScoreView, SubmissionDetailView, ToWebview, VerdictView, ViewState } from '../src/shared/messages';

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

function iconButton(name: string, title: string, onclick: () => void): HTMLButtonElement {
  return el('button', { class: 'icon-btn', title, 'aria-label': title, type: 'button', onclick }, icon(name));
}

function button(label: Child, onclick: () => void, opts: { kind?: 'primary' | 'secondary'; disabled?: boolean; title?: string } = {}) {
  return el('button', { class: `btn ${opts.kind ?? 'secondary'}`, type: 'button', disabled: opts.disabled, title: opts.title, onclick }, label);
}

function fmt(n: number | null): string {
  if (n === null) return '–';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function scoreClass(score: number | null, rawSum = false): string {
  if (score === null) return 'score-none';
  if (rawSum) return 'score-partial';
  if (score >= 100) return 'score-full';
  if (score <= 0) return 'score-zero';
  return 'score-partial';
}

function scorePill(s: ScoreView): HTMLElement {
  const title = s.counted === null ? 'Not attempted' : `Counted score ${fmt(s.counted)}${s.penaltyLabel ? ` (${s.penaltyLabel})` : ''}`;
  return el('span', { class: `pill ${scoreClass(s.counted, s.rawSum)}`, title }, fmt(s.counted));
}

/** Relative time ("3 min ago", "2 days ago"). */
function relative(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Exact local time for tooltips. */
function exact(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const seconds = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(ms < 10_000 ? 3 : 2)} s`);
const megabytes = (kb: number | null) => (kb === null ? '–' : `${(kb / 1024).toFixed(2)} MB`);

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
  for (const a of actions) a.addEventListener('click', (e) => e.preventDefault());
  return { details, body };
}

// Persistent inputs (kept across renders so typing is never interrupted).
const loginUser = el('input', { type: 'text', id: 'login-user', name: 'username', autocomplete: 'username', spellcheck: 'false', placeholder: 'Username' });
const loginPass = el('input', { type: 'password', id: 'login-pass', name: 'password', autocomplete: 'current-password', placeholder: 'Password' });
const loginRemember = el('input', { type: 'checkbox', id: 'login-remember', checked: true });
let rememberInitialised = false;
const loginForm = el(
  'form',
  {
    class: 'login-form',
    onsubmit: (e: Event) => {
      e.preventDefault();
      const password = loginPass.value;
      loginPass.value = ''; // never kept in the webview
      send({ type: 'login', username: loginUser.value, password, remember: loginRemember.checked });
    },
  },
  el('label', { for: 'login-user' }, 'Username'),
  loginUser,
  el('label', { for: 'login-pass' }, 'Password'),
  loginPass,
  el('p', { class: 'hint' }, 'Tip: copy it from the Passwords app once; it will be remembered securely in your Keychain.'),
  el('label', { class: 'check', for: 'login-remember' }, loginRemember, ' Remember password on this computer'),
  el('button', { class: 'btn primary', type: 'submit' }, icon('sign-in'), ' Log in'),
);
let showLoginForm = false;

const pickerSearch = el('input', { type: 'search', class: 'picker-search', placeholder: 'Search by name or id…', 'aria-label': 'Search problems', spellcheck: 'false' });
const pickerList = el('div', { class: 'picker-list', role: 'listbox' });
// One persistent container: typing only re-renders the list, never moves the search box.
const pickerBox = el('div', { class: 'picker' }, pickerSearch, pickerList);
let pickerOpen = false;

const problemFilter = el('input', { type: 'search', placeholder: 'Filter by name or id…', 'aria-label': 'Filter problems', spellcheck: 'false', value: ui.filter });

const sAccount = section('account', 'Account');
const sCurrent = section('current', 'Current problem');
const sResult = section('result', 'Result');
const sHistory = section('history', 'History', [iconButton('refresh', 'Reload submission history', () => send({ type: 'refreshHistory' }))]);
const sProblems = section('problems', 'Problems', [iconButton('refresh', 'Reload problem list', () => send({ type: 'refreshProblems' }))]);
app.append(sAccount.details, sCurrent.details, sResult.details, sHistory.details, sProblems.details);

let state: ViewState | null = null;

function matches(p: ProblemView, q: string): boolean {
  return !q || p.name.toLowerCase().includes(q) || p.fullName.toLowerCase().includes(q) || String(p.id) === q || `#${p.id}` === q;
}

// -------------------------------------------------------------- sections

function renderAccount(s: ViewState): void {
  const b = sAccount.body;
  b.replaceChildren();
  const a = s.account;
  let host = s.baseUrl;
  try {
    host = new URL(s.baseUrl).host;
  } catch {
    /* keep */
  }
  if (a.status === 'logged-in') {
    b.append(
      el('div', { class: 'row account' },
        el('span', { class: 'dot ok', 'aria-hidden': 'true' }),
        el('span', { class: 'grow ellipsis', title: `${a.username} on ${host}` }, el('strong', {}, a.username), el('span', { class: 'muted' }, ` · ${host}`)),
        button([icon('sign-out'), ' Log out'], () => send({ type: 'logout' }), { title: 'Log out and forget the saved password' }),
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
      el('div', { class: 'row' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { class: 'grow ellipsis' }, 'Saved login: ', el('strong', {}, a.username))),
      el('div', { class: 'row gap' },
        button([icon('sign-in'), ' Log in'], () => send({ type: 'loginSaved' }), { kind: 'primary' }),
        el('button', { class: 'link', type: 'button', onclick: () => { showLoginForm = true; render(); } }, 'Use another account'),
      ),
    );
  } else {
    if (!loginUser.value && a.username) loginUser.value = a.username;
    if (!rememberInitialised) {
      loginRemember.checked = a.rememberPassword;
      rememberInitialised = true;
    }
    b.append(loginForm);
  }
  if (a.error) b.append(el('div', { class: 'error', role: 'alert' }, icon('error'), ' ', a.error));
}

function renderPickerList(s: ViewState): void {
  const q = pickerSearch.value.trim().toLowerCase();
  const hits = s.problems.items.filter((p) => matches(p, q));
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
}

function scoreCard(sc: ScoreView): HTMLElement {
  const card = el('div', { class: 'score-card' },
    el('div', { class: 'row score-row' },
      el('span', { class: 'muted small' }, 'Counted score'),
      el('span', { class: 'grow' }),
      sc.source === 'problem-list' ? el('span', { class: 'muted small', title: 'Hint/AI-assist penalties read from the problem list page' }, 'from problem list') : null,
    ),
    el('div', { class: `score ${scoreClass(sc.counted, sc.rawSum)}` }, sc.counted === null ? 'Not attempted' : sc.rawSum ? fmt(sc.counted) : `${fmt(sc.counted)} / 100`),
    el('div', { class: 'score-facts small' },
      el('span', {}, 'Best ', el('strong', {}, fmt(sc.best))),
      el('span', {}, 'Latest ', el('strong', {}, fmt(sc.latest))),
      el('span', {}, 'Attempts ', el('strong', {}, String(sc.attempts))),
      sc.penaltyLabel ? el('span', { class: 'penalty' }, sc.penaltyLabel) : null,
      sc.rawSum ? el('span', { class: 'muted' }, 'raw-sum scoring') : null,
    ),
  );
  if (sc.latestBelowCounted && sc.latest !== null && sc.counted !== null) {
    card.append(el('p', { class: 'hint' }, icon('info'), ` Latest: ${fmt(sc.latest)} — your best ${fmt(sc.counted)} still counts.`));
  }
  return card;
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
      el('span', { class: 'muted small' }, s.file.languageGuess ?? 'unknown type'),
    ),
  );

  const p = s.problem;
  const combo = el(
    'button',
    {
      class: 'combo',
      type: 'button',
      'aria-expanded': String(pickerOpen),
      title: p ? `${p.name} — ${p.fullName} (#${p.id})` : 'Choose problem',
      onclick: () => {
        pickerOpen = !pickerOpen;
        if (pickerOpen && !s.problems.loaded && !s.problems.loading) send({ type: 'refreshProblems' });
        render();
        if (pickerOpen) pickerSearch.focus();
      },
    },
    p
      ? el('span', { class: 'grow ellipsis' }, el('strong', {}, p.name), el('span', { class: 'muted' }, ` #${p.id}`), p.fullName && p.fullName !== p.name ? el('span', { class: 'muted' }, ` ${p.fullName}`) : null)
      : el('span', { class: 'grow muted' }, 'Choose problem…'),
    icon(pickerOpen ? 'chevron-up' : 'chevron-down'),
  );
  b.append(
    el('div', { class: 'field' },
      el('div', { class: 'field-label' }, 'Problem',
        p && p.source === 'cph' ? el('span', { class: 'badge', title: 'Matched from the CPH problem file. Pick it again to save the mapping.' }, 'from CPH') : null,
        el('span', { class: 'grow' }),
        p ? iconButton('link-external', 'Open problem statement', () => send({ type: 'openStatement', problemId: p.id })) : null,
        p ? iconButton('close', 'Forget the problem for this file', () => send({ type: 'unmapProblem' })) : null,
      ),
      combo,
      pickerOpen ? (renderPickerList(s), pickerBox) : null,
    ),
  );

  if (p) {
    b.append(scoreCard(p.score));
    const L = s.languages;
    const select = el('select', {
      id: 'lang',
      disabled: L.loading || L.items.length <= 1,
      onchange: (e: Event) => send({ type: 'selectLanguage', languageId: Number((e.target as HTMLSelectElement).value) }),
    });
    if (L.items.length === 0) select.append(el('option', {}, L.loading ? 'Loading…' : '—'));
    if (L.selectedId === null && L.items.length) select.append(el('option', { value: '', selected: true, disabled: true }, 'Choose language…'));
    for (const l of L.items) select.append(el('option', { value: l.id, selected: l.id === L.selectedId }, l.name));
    b.append(el('div', { class: 'field' }, el('label', { class: 'field-label', for: 'lang' }, 'Language'), select));
  }

  const sub = s.submit;
  b.append(
    el('button', { class: 'btn big', type: 'button', id: 'submit-btn', disabled: !sub.enabled, onclick: () => send({ type: 'submit' }), 'aria-describedby': sub.reason ? 'submit-reason' : undefined },
      sub.busy ? icon('loading', 'codicon-modifier-spin') : icon('cloud-upload'),
      ` ${sub.busy ? 'Grading…' : sub.label}`,
    ),
  );
  if (s.gradingElsewhere) b.append(el('p', { class: 'hint' }, icon('loading', 'codicon-modifier-spin'), ` Grading ${s.gradingElsewhere} for another file…`));
  if (sub.reason) b.append(el('p', { class: 'hint', id: 'submit-reason' }, icon('info'), ' ', sub.reason));
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
    b.append(el('p', { class: 'muted' }, 'No submission yet for this file in this session.'));
    return;
  }
  b.append(
    el('div', { class: 'row result-head' },
      el('span', { class: 'ellipsis' }, el('strong', {}, r.problemName), r.number !== null ? el('span', { class: 'muted' }, ` · attempt ${r.number}`) : null),
      el('span', { class: 'grow' }),
      r.submissionId
        ? el('button', { class: 'link', type: 'button', title: 'Open the submission in the browser', onclick: () => send({ type: 'openSubmission', submissionId: r.submissionId! }) }, `#${r.submissionId}`, icon('link-external'))
        : null,
    ),
  );
  if (r.phase === 'submitting' || r.phase === 'grading') {
    b.append(el('div', { class: 'row status' }, icon('loading', 'codicon-modifier-spin'), ' ', r.message ?? 'Grading…'));
  }
  if (r.phase === 'done' || ((r.phase === 'timeout' || r.phase === 'error') && r.verdicts.length)) {
    const text = r.compileError ? 'Compilation error' : r.points !== null ? `${fmt(r.points)} points` : (r.message ?? 'Graded');
    b.append(el('div', { class: 'row score-row' }, el('span', { class: `score ${r.compileError ? 'score-zero' : scoreClass(r.points)}` }, text)));
    if (r.verdicts.length) b.append(verdictStrip(r.verdicts));
    else if (r.comment && !r.compileError) b.append(el('code', { class: 'comment' }, r.comment));
    const failed = r.verdicts.filter((v) => !v.ok);
    if (failed.length && failed.length <= 6) b.append(el('ul', { class: 'failed' }, ...failed.map((v) => el('li', {}, v.label))));
    if (r.improvement) b.append(el('p', { class: 'improvement' }, icon('graph-line'), ' ', r.improvement));
  }
  if (r.compileError) {
    b.append(
      el('details', { class: 'compiler', open: true },
        el('summary', {}, 'Compiler message'),
        el('pre', {}, r.compilerMessage || '(empty)'),
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

function miniStrip(verdicts: VerdictView[]): HTMLElement {
  const strip = el('span', { class: 'mini-strip', 'aria-hidden': 'true' });
  for (const v of verdicts.slice(0, 40)) strip.append(el('span', { class: `mini v-${v.kind in VERDICT_LETTER ? v.kind : 'unknown'}`, title: v.label }));
  if (verdicts.length > 40) strip.append(el('span', { class: 'muted small' }, `+${verdicts.length - 40}`));
  return strip;
}

function detailBox(d: SubmissionDetailView): HTMLElement {
  const box = el('div', { class: 'detail' });
  box.append(
    el('div', { class: 'score-facts small' },
      el('span', {}, 'Max time ', el('strong', {}, seconds(d.maxRuntimeMs))),
      el('span', {}, 'Peak memory ', el('strong', {}, megabytes(d.peakMemoryKb))),
      d.sourceFilename ? el('span', { class: 'mono' }, d.sourceFilename) : null,
    ),
  );
  if (d.evaluations.length) {
    const table = el('table', { class: 'evals' },
      el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Result'), el('th', {}, 'Score'), el('th', {}, 'Time'), el('th', {}, 'Memory'))),
    );
    const body = el('tbody');
    for (const e of d.evaluations) {
      body.append(
        el('tr', {},
          el('td', { class: 'num' }, String(e.index)),
          el('td', {}, el('span', { class: `mini v-${e.kind in VERDICT_LETTER ? e.kind : 'unknown'}`, 'aria-hidden': 'true' }), ' ', e.label.replace(/^Test \d+: /, '')),
          el('td', { class: 'num' }, e.score === null ? '–' : fmt(e.score)),
          el('td', { class: 'num' }, seconds(e.timeMs)),
          el('td', { class: 'num' }, megabytes(e.memoryKb)),
        ),
      );
    }
    table.append(body);
    box.append(el('div', { class: 'evals-wrap' }, table));
  }
  if (d.compilerMessage) box.append(el('details', { class: 'compiler' }, el('summary', {}, 'Compiler message'), el('pre', {}, d.compilerMessage)));
  box.append(
    el('div', { class: 'row gap' },
      button([icon('go-to-file'), ' Open this version'], () => send({ type: 'openSubmissionSource', submissionId: d.submissionId }), { disabled: !d.hasSource, title: d.hasSource ? 'Open the submitted source in a new untitled editor' : 'Source not available' }),
      button([icon('diff'), ' Compare with current file'], () => send({ type: 'compareSubmission', submissionId: d.submissionId }), { disabled: !d.hasSource }),
      el('button', { class: 'link', type: 'button', onclick: () => send({ type: 'openSubmission', submissionId: d.submissionId }) }, 'Website', icon('link-external')),
    ),
  );
  return box;
}

function historyRow(h: HistoryEntry, s: ViewState): HTMLElement {
  const ex = s.history.expanded;
  const open = ex?.submissionId === h.submissionId;
  const row = el('div', { class: `history-item${open ? ' open' : ''}${h.counted ? ' counted' : ''}` });
  row.append(
    el('button', { class: 'history-row', type: 'button', 'aria-expanded': String(open), title: `Submission #${h.submissionId} · ${exact(h.submittedAt)}`, onclick: () => send({ type: 'toggleSubmission', submissionId: h.submissionId }) },
      icon(open ? 'chevron-down' : 'chevron-right'),
      el('span', { class: 'mono muted' }, h.number !== null ? `${h.number}.` : `#${h.submissionId}`),
      el('span', { class: `pill ${h.compileError ? 'score-zero' : scoreClass(h.points)}` }, h.compileError ? 'CE' : fmt(h.points)),
      h.counted ? el('span', { class: 'badge counted', title: 'This submission holds your counted (best) score' }, icon('star-full'), 'counted') : null,
      el('span', { class: 'grow ellipsis' }, h.verdicts.length ? miniStrip(h.verdicts) : el('span', { class: 'muted small' }, h.compileError ? 'compile error' : (h.comment ?? h.status.replace(/_/g, ' ')))),
      el('span', { class: 'muted small nowrap', title: exact(h.submittedAt) }, relative(h.submittedAt)),
    ),
  );
  if (open) {
    row.append(
      el('div', { class: 'row small muted pad-left' }, h.language ?? '', h.language ? ' · ' : '', exact(h.submittedAt), ` · #${h.submissionId}`),
    );
    if (ex!.detail) row.append(detailBox(ex!.detail));
    else if (ex!.loading) row.append(el('p', { class: 'muted small pad-left' }, icon('loading', 'codicon-modifier-spin'), ' Loading details…'));
    else if (ex!.error) row.append(el('div', { class: 'error pad-left' }, icon('error'), ' ', ex!.error));
  }
  return row;
}

function renderHistory(s: ViewState): void {
  const b = sHistory.body;
  b.replaceChildren();
  if (!s.problem) {
    b.append(el('p', { class: 'muted' }, 'Choose a problem to see its submissions.'));
    return;
  }
  const H = s.history;
  if (H.stale) b.append(el('p', { class: 'hint' }, icon('warning'), ' May be out of date (could not reach the grader).'));
  if (!H.items.length) {
    b.append(el('p', { class: 'muted' }, H.loading ? 'Loading…' : H.error ? '' : 'No submissions for this problem yet.'));
  } else {
    const list = el('div', { class: 'history' });
    for (const h of H.items) list.append(historyRow(h, s));
    b.append(list, el('p', { class: 'muted small' }, `${H.items.length} submission${H.items.length === 1 ? '' : 's'}`));
  }
  if (H.loading && H.items.length) b.append(el('p', { class: 'muted small' }, icon('loading', 'codicon-modifier-spin'), ' Refreshing…'));
  if (H.error) b.append(el('div', { class: 'error' }, icon('error'), ' ', H.error));
}

function problemRow(p: ProblemView, s: ViewState, where: 'picker' | 'list'): HTMLElement {
  const mapped = s.problem?.id === p.id;
  return el('div', { class: `problem-row${mapped ? ' mapped' : ''}`, role: where === 'picker' ? 'option' : undefined, 'aria-selected': where === 'picker' ? String(mapped) : undefined },
    el('button', {
      class: 'problem-main',
      type: 'button',
      disabled: !s.file,
      title: s.file ? `Use ${p.name} (#${p.id}) for ${s.file.name}` : 'Open a source file to map a problem',
      onclick: () => {
        pickerOpen = false;
        pickerSearch.value = '';
        send({ type: 'mapProblem', problemId: p.id });
      },
    },
      el('span', { class: 'problem-name ellipsis' }, mapped ? icon('check') : null, p.name, el('span', { class: 'muted id' }, ` #${p.id}`)),
      p.fullName && p.fullName !== p.name ? el('span', { class: 'problem-full ellipsis muted' }, p.fullName) : null,
    ),
    scorePill(p.score),
    iconButton('link-external', `Open the statement of ${p.name}`, () => send({ type: 'openStatement', problemId: p.id })),
  );
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
  b.append(problemFilter);
  const q = problemFilter.value.trim().toLowerCase();
  const hits = P.items.filter((p) => matches(p, q));
  const list = el('div', { class: 'problem-list' });
  for (const p of hits.slice(0, 150)) list.append(problemRow(p, s, 'list'));
  b.append(list);
  b.append(el('p', { class: 'muted small' }, hits.length > 150 ? `Showing 150 of ${hits.length}. Refine the filter.` : `${hits.length} of ${P.items.length} problems · scores shown are counted scores`));
  if (P.penaltyNote) b.append(el('p', { class: 'hint' }, icon('info'), ' ', P.penaltyNote));
  if (P.stale) b.append(el('p', { class: 'hint' }, icon('warning'), ' May be out of date (could not reach the grader).'));
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
  if (active instanceof HTMLInputElement && document.body.contains(active) && document.activeElement !== active) active.focus();
}

pickerSearch.addEventListener('input', () => state && renderPickerList(state));
pickerSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    pickerOpen = false;
    render();
  } else if (e.key === 'Enter') {
    pickerList.querySelector<HTMLButtonElement>('.problem-main:not([disabled])')?.click();
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
