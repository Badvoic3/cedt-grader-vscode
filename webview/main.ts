/*
 * CEDT Grader sidebar webview. Plain DOM, no framework.
 *
 * Security: every string that may come from the grader is inserted with
 * textContent / attributes only, never innerHTML. The webview has no network
 * access (CSP default-src 'none'); all actions are postMessage'd to the host.
 */
import { groupLabel, VERDICT_LEGEND } from '../src/grader/verdicts';
import { filterProblems, matches } from './filters';
import { installTooltips } from './tooltip';
import type { FromWebview, HistoryEntry, ProblemFilter, ProblemView, ScoreView, SubmissionDetailView, ToWebview, VerdictView, ViewState } from '../src/shared/messages';

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
    // Tooltips use the custom component (native `title` tooltips vanish on re-render).
    else if (k === 'title') e.dataset.tip = String(v);
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

/**
 * Icon-only button: always a tooltip (`title`) and the same `aria-label`.
 * When disabled, the tooltip says why.
 */
function iconButton(name: string, label: string, onclick: () => void, opts: { disabledReason?: string | null } = {}): HTMLButtonElement {
  const text = opts.disabledReason ? `${label} (${opts.disabledReason})` : label;
  return el('button', { class: 'icon-btn', title: text, 'aria-label': text, type: 'button', disabled: !!opts.disabledReason, onclick }, icon(name));
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
  const tip =
    s.counted === null
      ? 'Not attempted yet'
      : `Counted score: ${fmt(s.counted)}${s.rawSum ? '' : ' / 100'} (your best submission${s.penaltyLabel ? `, ${s.penaltyLabel}` : ''}) · ${s.attempts} attempt${s.attempts === 1 ? '' : 's'}`;
  return el('span', { class: `pill score-pill ${scoreClass(s.counted, s.rawSum)}`, title: tip, 'aria-label': tip }, fmt(s.counted));
}

/** Name and subtitle without repeating the name ("104_68_1_exam2_P1: Scholarship" → subtitle "Scholarship"). */
function titleParts(p: { name: string; fullName: string }): { name: string; subtitle: string | null } {
  const full = p.fullName.trim();
  if (!full || full === p.name) return { name: p.name, subtitle: null };
  if (full.startsWith(`${p.name}:`)) {
    const rest = full.slice(p.name.length + 1).trim();
    return { name: p.name, subtitle: rest || null };
  }
  return { name: p.name, subtitle: full };
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
const sHistory = section('history', 'History', [iconButton('refresh', 'Refresh history', () => send({ type: 'refreshHistory' }))]);
const sProblems = section('problems', 'Problems', [iconButton('refresh', 'Refresh problem list', () => send({ type: 'refreshProblems' }))]);
const banner = el('div', { class: 'banner', role: 'alert', hidden: true });
app.append(banner, sAccount.details, sCurrent.details, sResult.details, sHistory.details, sProblems.details);

/** One banner for connection problems, with Retry (or Log in). Cached data stays visible below it. */
function renderBanner(s: ViewState): void {
  const c = s.connection;
  banner.hidden = !c;
  banner.replaceChildren();
  if (!c) return;
  banner.className = `banner banner-${c.kind}`;
  appendChildren(banner, [
    el('div', { class: 'row' },
      icon(c.kind === 'session' ? 'account' : c.kind === 'offline' ? 'debug-disconnect' : 'warning'),
      el('strong', { class: 'grow' }, c.title),
      button(c.action === 'login' ? [icon('sign-in'), ' Log in'] : [icon('refresh'), ' Retry'], () => send({ type: 'retry' }), { kind: 'primary' }),
    ),
    el('p', {}, c.message),
    (s.problems.loaded || s.history.items.length > 0) && el('p', { class: 'small muted' }, 'Showing saved data below; it may be out of date.'),
  ]);
}

let state: ViewState | null = null;


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

function openPicker(): void {
  pickerOpen = true;
  if (state && !state.problems.loaded && !state.problems.loading) send({ type: 'refreshProblems' });
  ui.collapsed.current = false;
  sCurrent.details.open = true;
  render();
  pickerSearch.focus();
}

function closePicker(): void {
  pickerOpen = false;
  render();
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
    const top = !q ? (s.matching.ambiguous ?? s.matching.suggestions) : [];
    if (top.length) {
      pickerList.append(el('div', { class: 'picker-group muted small' }, s.matching.ambiguous ? 'Matches for this file' : 'Suggested for this file'));
      for (const p of top) pickerList.append(problemRow(p, s, 'picker'));
      pickerList.append(el('div', { class: 'picker-group muted small' }, 'All problems'));
    }
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
      title: p ? `${p.name} (#${p.id}) — choose another problem` : 'Choose problem',
      onclick: () => (pickerOpen ? closePicker() : openPicker()),
    },
    p
      ? el('span', { class: 'grow combo-text' },
          el('span', { class: 'ellipsis' }, el('strong', {}, p.name), el('span', { class: 'muted' }, ` #${p.id}`)),
          titleParts(p).subtitle ? el('span', { class: 'ellipsis muted small' }, titleParts(p).subtitle!) : null,
        )
      : el('span', { class: 'grow muted' }, 'Choose problem…'),
    icon(pickerOpen ? 'chevron-up' : 'chevron-down'),
  );
  b.append(
    el('div', { class: 'field' },
      el('div', { class: 'field-label' }, 'Problem',
        el('span', { class: 'grow' }),
        p ? el('button', { class: 'link small', type: 'button', title: 'Choose another problem for this file', onclick: () => openPicker() }, 'Change') : null,
        p ? iconButton('copy', 'Copy problem name', () => send({ type: 'copyName', problemId: p.id })) : null,
        p ? iconButton('book', 'Open statement', () => send({ type: 'openStatement', problemId: p.id })) : null,
        p && p.source === 'saved' ? iconButton('close', 'Remove link', () => send({ type: 'unmapProblem' })) : null,
      ),
      combo,
      pickerOpen ? (renderPickerList(s), pickerBox) : null,
      p ? sourceLine(p.source, p.id, p.name) : null,
      s.matching.note ? el('p', { class: 'hint' }, icon('info'), ' ', s.matching.note) : null,
    ),
  );

  if (p) {
    b.append(scoreCard(p.score));
    const L = s.languages;
    const select = el('select', {
      id: 'lang',
      disabled: L.loading || L.items.length <= 1,
      title: L.loading ? 'Loading languages…' : L.items.length <= 1 ? 'This problem allows only one language' : 'Language for this submission',
      onchange: (e: Event) => send({ type: 'selectLanguage', languageId: Number((e.target as HTMLSelectElement).value) }),
    });
    if (L.items.length === 0) select.append(el('option', {}, L.loading ? 'Loading…' : '—'));
    if (L.selectedId === null && L.items.length) select.append(el('option', { value: '', selected: true, disabled: true }, 'Choose language…'));
    for (const l of L.items) select.append(el('option', { value: l.id, selected: l.id === L.selectedId }, l.name));
    b.append(el('div', { class: 'field' }, el('label', { class: 'field-label', for: 'lang' }, 'Language'), select));
    if (p.hasTestcase && p.source !== 'suggested') {
      b.append(
        button(
          s.testcases.busy ? [icon('loading', 'codicon-modifier-spin'), ' Loading test cases…'] : [icon('beaker'), ' Load test cases'],
          () => send({ type: 'loadTestcases' }),
          {
            disabled: s.testcases.busy,
            title: s.testcases.busy
              ? 'Downloading test cases…'
              : s.cph.installed
                ? "Download the grader's test cases into CPH"
                : "Download the grader's test cases (CPH isn't installed: save them as .in/.out files)",
          },
        ),
      );
    }
  }

  const mm = p ? s.languages.mismatch : null;
  if (mm) {
    b.append(
      el('div', { class: 'notice warn', role: 'status' },
        el('div', { class: 'row' },
          icon('warning'),
          el('span', { class: 'grow' }, `This problem doesn't accept ${mm.wanted}. Wrong problem?`),
          button('Change', () => openPicker()),
        ),
        el('p', { class: 'small muted' }, `Accepted: ${mm.allowed.join(', ')}`),
      ),
    );
  }

  const sub = s.submit;
  b.append(
    el('button', { class: 'btn big', type: 'button', id: 'submit-btn', disabled: !sub.enabled, title: sub.reason ?? undefined, onclick: () => send({ type: 'submit' }), 'aria-describedby': sub.reason ? 'submit-reason' : undefined },
      sub.busy ? icon('loading', 'codicon-modifier-spin') : icon('cloud-upload'),
      ` ${sub.busy ? 'Grading…' : sub.label}`,
    ),
  );
  if (s.gradingElsewhere) b.append(el('p', { class: 'hint' }, icon('loading', 'codicon-modifier-spin'), ` Grading ${s.gradingElsewhere} for another file…`));
  // One message: the mismatch notice already explains a disabled Submit.
  if (sub.reason && !mm) b.append(el('p', { class: 'hint', id: 'submit-reason' }, icon('info'), ' ', sub.reason));
}

const VERDICT_LETTER: Record<string, string> = {
  correct: 'P', wrong: '-', partial: 's', time_limit: 'T', memory_limit: 'M', crash: 'x', unknown_error: 'E', grader_error: '!', waiting: '?',
};

function verdictTile(v: VerdictView): HTMLElement {
  const known = v.kind in VERDICT_LETTER;
  return el('span', { class: `tile v-${known ? v.kind : 'unknown'}`, title: v.label, role: 'img', 'aria-label': v.label }, VERDICT_LETTER[v.kind] ?? '?');
}

/** One tile per test, in order; `[...]` groups drawn as a box (as on the website). */
function verdictStrip(verdicts: VerdictView[]): HTMLElement {
  const strip = el('div', { class: 'strip', role: 'group', 'aria-label': 'Verdict per test' });
  const groupCount = new Set(verdicts.filter((v) => v.group !== undefined).map((v) => v.group)).size;
  let i = 0;
  while (i < verdicts.length) {
    const v = verdicts[i];
    if (v.group === undefined) {
      strip.append(verdictTile(v));
      i++;
      continue;
    }
    const members = verdicts.filter((x) => x.group === v.group);
    const label = groupLabel(v.group, groupCount, members);
    strip.append(el('span', { class: 'tile-group', title: label, 'aria-label': label, role: 'group' }, ...members.map(verdictTile)));
    i += members.length;
  }
  return strip;
}

/** Plain text for comments that are not a verdict strip ("No testcase", odd brackets, …). */
function plainComment(comment: string): HTMLElement {
  return el('code', { class: 'comment' }, `[${comment}]`);
}

let legendOpen: string | null = null;
/** "?" button with the "Reading the results" popover (like the website's legend). */
function legendButton(where: string): HTMLElement {
  const btn = iconButton('question', 'Reading the results', () => {
    legendOpen = legendOpen === where ? null : where;
    forceRender();
  });
  btn.setAttribute('aria-expanded', String(legendOpen === where));
  return btn;
}
function legend(): HTMLElement {
  return el('div', { class: 'legend', role: 'note' },
    el('strong', {}, 'Reading the results'),
    ...VERDICT_LEGEND.map((c) => el('div', { class: 'row' }, el('span', { class: `tile v-${c.kind}`, 'aria-hidden': 'true' }, c.code), el('span', {}, c.word))),
    el('div', { class: 'row' }, el('span', { class: 'tile-group', 'aria-hidden': 'true' }, el('span', { class: 'tile v-correct' }, 'P'), el('span', { class: 'tile v-correct' }, 'P'), el('span', { class: 'tile v-wrong' }, '-')), el('span', {}, 'a box = tests scored together')),
    el('p', { class: 'small' }, 'One tile per test case, in order. A box earns the lowest score inside it: one failing tile fails the whole box.'),
    el('p', { class: 'small muted' }, 'Hover a tile or a box for details.'),
  );
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
    if (r.verdicts.length) {
      b.append(el('div', { class: 'row strip-row' }, verdictStrip(r.verdicts), el('span', { class: 'grow' }), legendButton('result')));
      if (legendOpen === 'result') b.append(legend());
    } else if (r.comment && !r.compileError) b.append(plainComment(r.comment));
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
      button([icon('go-to-file'), ' Open this version'], () => send({ type: 'openSubmissionSource', submissionId: d.submissionId }), { disabled: !d.hasSource, title: d.hasSource ? 'Open the submitted source in a new untitled editor' : 'The grader does not return the source of this submission' }),
      button([icon('diff'), ' Compare with current file'], () => send({ type: 'compareSubmission', submissionId: d.submissionId }), { disabled: !d.hasSource, title: d.hasSource ? 'Compare with current file' : 'The grader does not return the source of this submission' }),
      el('button', { class: 'link', type: 'button', title: 'Open in browser', onclick: () => send({ type: 'openSubmission', submissionId: d.submissionId }) }, 'Website', icon('link-external')),
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
      el('span', { class: 'grow ellipsis' },
        h.verdicts.length
          ? miniStrip(h.verdicts)
          : h.compileError
            ? el('span', { class: 'muted small' }, 'compile error')
            : h.comment
              ? el('span', { class: 'mono small' }, `[${h.comment}]`)
              : el('span', { class: 'muted small' }, h.status.replace(/_/g, ' ')),
      ),
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
    b.append(list, el('div', { class: 'row muted small' }, el('span', { class: 'grow' }, `${H.items.length} submission${H.items.length === 1 ? '' : 's'}`), legendButton('history')));
    if (legendOpen === 'history') b.append(legend());
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
      titleParts(p).subtitle ? el('span', { class: 'problem-full ellipsis muted' }, titleParts(p).subtitle!) : null,
    ),
    scorePill(p.score),
    el('span', { class: 'row-actions' },
      iconButton('copy', 'Copy problem name', () => send({ type: 'copyName', problemId: p.id })),
      p.hasFile
        ? iconButton('go-to-file', 'Go to linked file', () => send({ type: 'goToFile', problemId: p.id }))
        : iconButton('search', 'Find file by name', () => send({ type: 'findFile', problemId: p.id })),
      iconButton('new-file', 'New file for this problem', () => send({ type: 'newFile', problemId: p.id })),
      iconButton('book', 'Open statement', () => send({ type: 'openStatement', problemId: p.id })),
    ),
  );
}

const SOURCE_ICON: Record<string, string> = { saved: 'pinned', filename: 'file', cph: 'beaker', suggested: 'lightbulb' };
const SOURCE_TEXT: Record<string, string> = { saved: 'Chosen by you', filename: 'Matched by file name', cph: 'Matched from CPH data', suggested: 'Suggested' };

/** "How matched" line under the problem selector (text, not icon-only). Only "Suggested" stands out, with Confirm. */
function sourceLine(source: string, problemId: number, name: string): HTMLElement {
  if (source === 'suggested') {
    return el('div', { class: 'row source-line suggested' },
      icon('lightbulb'),
      el('span', { class: 'grow small' }, 'Suggested from the file name'),
      button('Confirm', () => send({ type: 'confirmProblem', problemId }), { kind: 'primary', title: `Link this file to ${name} (#${problemId})` }),
    );
  }
  return el('div', { class: `row source-line source-${source} small muted` }, icon(SOURCE_ICON[source] ?? 'info'), el('span', {}, SOURCE_TEXT[source] ?? source));
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
  b.append(statusFilter(P.filter), problemFilter);
  if (P.topics.length) b.append(topicFilter(P.filter, P.topics));
  const q = problemFilter.value.trim().toLowerCase();
  const hits = filterProblems(P.items, P.filter, q);
  const list = el('div', { class: 'problem-list' });
  for (const p of hits.slice(0, 150)) list.append(problemRow(p, s, 'list'));
  b.append(list);
  b.append(el('p', { class: 'muted small' }, hits.length > 150 ? `Showing 150 of ${hits.length}. Refine the filter.` : `${hits.length} of ${P.items.length} problems`));
  if (P.penaltyNote) b.append(el('p', { class: 'hint' }, icon('info'), ' ', P.penaltyNote));
  if (P.stale) b.append(el('p', { class: 'hint' }, icon('warning'), ' May be out of date (could not reach the grader).'));
  if (P.loading) b.append(el('p', { class: 'muted small' }, icon('loading', 'codicon-modifier-spin'), ' Refreshing…'));
  if (P.error) b.append(el('div', { class: 'error' }, icon('error'), ' ', P.error));
}

const STATUS_FILTERS: { key: ProblemFilter['status']; label: string; tip: string }[] = [
  { key: 'all', label: 'All', tip: 'All problems' },
  { key: 'unsolved', label: 'Unsolved', tip: 'Not tried yet or not 100 yet' },
  { key: 'inprogress', label: 'In progress', tip: 'Submitted, best score below 100' },
  { key: 'solved', label: 'Solved', tip: 'Best score 100 or more' },
];

function statusFilter(f: ProblemFilter): HTMLElement {
  return el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Filter problems by status' },
    ...STATUS_FILTERS.map((x) =>
      el('button', {
        class: `seg${f.status === x.key ? ' active' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(f.status === x.key), title: x.tip,
        onclick: () => send({ type: 'setFilter', filter: { ...f, status: x.key } }),
      }, x.label),
    ),
  );
}

function topicFilter(f: ProblemFilter, topics: { name: string; description: string | null }[]): HTMLElement {
  return el('div', { class: 'topics', role: 'group', 'aria-label': 'Filter problems by topic' },
    ...topics.map((t) =>
      el('button', {
        class: `topic${f.topic === t.name ? ' active' : ''}`, type: 'button', 'aria-pressed': String(f.topic === t.name),
        title: `${t.description ? `${t.description}. ` : ''}${f.topic === t.name ? 'Click again to show all topics' : `Show only ${t.name} problems`}`,
        onclick: () => send({ type: 'setFilter', filter: { ...f, topic: f.topic === t.name ? null : t.name } }),
      }, t.name),
    ),
  );
}

// ---------------------------------------------------------------- wiring

const tooltip = installTooltips(document);

/**
 * Sections re-render only when their own data changed, so the element under
 * the cursor (and its tooltip) isn't recreated by unrelated state pushes
 * (polling, history loading, …).
 */
const lastKeys = new Map<string, string>();
function sectionKeys(s: ViewState): Record<string, string> {
  const j = JSON.stringify;
  const pid = s.problem?.id ?? null;
  return {
    banner: j([s.connection, s.problems.loaded, s.history.items.length > 0]),
    account: j([s.account, s.baseUrl, showLoginForm]),
    current: j([s.file, s.problem, s.languages, s.submit, s.matching, s.testcases, s.cph, s.gradingElsewhere, pickerOpen, pickerOpen ? s.problems : s.problems.loaded]),
    result: j([s.result, s.submit.enabled, s.submit.reason, legendOpen === 'result']),
    history: j([pid, s.history, legendOpen === 'history']),
    problems: j([s.problems, !!s.file, pid, ui.filter]),
  };
}

function render(): void {
  if (!state) {
    sAccount.body.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
    return;
  }
  const active = document.activeElement;
  const keys = sectionKeys(state);
  const renderers: Record<string, (s: ViewState) => void> = {
    banner: renderBanner,
    account: renderAccount,
    current: renderCurrent,
    result: renderResult,
    history: renderHistory,
    problems: renderProblems,
  };
  for (const [name, fn] of Object.entries(renderers)) {
    if (lastKeys.get(name) === keys[name]) continue;
    lastKeys.set(name, keys[name]);
    fn(state);
  }
  // Persistent inputs survive re-render; restore focus if it was on one of them.
  if (active instanceof HTMLInputElement && document.body.contains(active) && document.activeElement !== active) active.focus();
  tooltip.refresh();
}

/** Re-render everything (local UI changes such as opening the picker or the legend). */
function forceRender(): void {
  lastKeys.clear();
  render();
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
      openPicker();
    } else {
      document.getElementById('submit-btn')?.focus();
    }
  }
});

render();
send({ type: 'ready' });
