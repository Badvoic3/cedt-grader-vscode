/*
 * CEDT Grader sidebar webview. Plain DOM, no framework.
 *
 * Security: every string that may come from the grader is inserted with
 * textContent / attributes only, never innerHTML. The webview has no network
 * access (CSP default-src 'none'); all actions are postMessage'd to the host.
 */
import './lang'; // first: sets the display language before anything below builds elements
import { G, HOW_LINKED, W, W_SOURCE } from '../src/shared/strings';
import { dateLocale } from '../src/shared/i18n';
import { type SectionId, visibleSections } from '../src/shared/layout';
import { outOfFor, scoreText } from '../src/grader/score';
import { groupLabel, verdictLegend } from '../src/grader/verdicts';
import { menuLabelMax, middleEllipsis } from './text';
import { VirtualList } from './virtualList';
import { PANEL, SERVER_SCORE_CAP } from '../src/shared/constants';
import { filterProblems, matches, sorts, sortProblems } from './filters';
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
  /** Problem list scroll position (kept across re-renders, hide/show and restarts). */
  listScroll?: number;
}

const vscode = acquireVsCodeApi();
const ui: UiState = { collapsed: {}, filter: '', ...(vscode.getState() ?? {}) };
const saveUi = () => vscode.setState({ collapsed: ui.collapsed, filter: ui.filter, listScroll: ui.listScroll });
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
/** "Troubleshooting": the README section on GitHub (connection banner, login errors). */
function troubleshootingLink(): HTMLButtonElement {
  return el('button', { class: 'link small', type: 'button', title: W.troubleshootingTip, onclick: () => send({ type: 'openTroubleshooting' }) }, icon('question'), ' ', W.troubleshooting);
}

function iconButton(name: string, label: string, onclick: () => void, opts: { disabledReason?: string | null } = {}): HTMLButtonElement {
  const text = opts.disabledReason ? `${label} (${opts.disabledReason})` : label;
  return el('button', { class: 'icon-btn', title: text, 'aria-label': text, type: 'button', disabled: !!opts.disabledReason, onclick }, icon(name));
}

function button(label: Child, onclick: () => void, opts: { kind?: 'primary' | 'secondary'; disabled?: boolean; title?: string } = {}) {
  return el('button', { class: `btn ${opts.kind ?? 'secondary'}`, type: 'button', disabled: opts.disabled, title: opts.title, onclick }, label);
}

/**
 * Buttons of a `.test-buttons` grid get one width: the widest one's natural
 * width (labels differ per language), via `--btn-w` (needs layout: measured
 * on the next frame; skipped while hidden).
 */
let lastBtnW = '';
function equalWidths(row: HTMLElement): void {
  if (lastBtnW) row.style.setProperty('--btn-w', lastBtnW); // the section is rebuilt on re-render: no flicker
  const raf = window.requestAnimationFrame?.bind(window);
  if (!raf) return;
  raf(() => {
    let w = 0;
    for (const b of row.children as HTMLCollectionOf<HTMLElement>) {
      b.style.width = 'max-content';
      w = Math.max(w, b.getBoundingClientRect().width);
      b.style.width = '';
    }
    if (!w) return;
    lastBtnW = `${Math.ceil(w)}px`;
    row.style.setProperty('--btn-w', lastBtnW);
  });
}

export interface MenuItem {
  icon: string;
  label: string;
  tip?: string;
  onclick: () => void;
  disabledReason?: string | null;
}

/**
 * Right-click menu with the same actions as the visible icons (in addition
 * to them, never instead). Opens at the pointer (or under the element for
 * the keyboard context-menu key / Shift+F10); closes on outside click,
 * Escape, Tab, scroll or after choosing. Long labels are cut in the middle;
 * the full label is in the item's tooltip and aria-label.
 */
let ctxMenu: HTMLElement | null = null;
let ctxReturnFocus: HTMLElement | null = null;

function closeContextMenu(refocus = false): void {
  if (!ctxMenu) return;
  ctxMenu.remove();
  ctxMenu = null;
  if (refocus) ctxReturnFocus?.focus();
  ctxReturnFocus = null;
}

function openContextMenu(x: number, y: number, items: MenuItem[], from: HTMLElement | null): void {
  closeContextMenu();
  const max = menuLabelMax(window.innerWidth);
  const menu = el('div', { class: 'menu context-menu', role: 'menu' },
    ...items.map((it) => {
      const shown = middleEllipsis(it.label, max);
      const tip = [shown !== it.label ? it.label : '', it.tip ?? '', it.disabledReason ? `(${it.disabledReason})` : ''].filter(Boolean).join(' — ');
      const b = el('button', {
        class: 'menu-item', type: 'button', role: 'menuitem', disabled: !!it.disabledReason,
        title: tip || undefined,
        onclick: () => {
          closeContextMenu();
          it.onclick();
        },
      }, icon(it.icon), el('span', { class: 'menu-label' }, shown));
      b.setAttribute('aria-label', it.label);
      return b;
    }),
  );
  document.body.append(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
  menu.style.top = `${y + h > window.innerHeight - 4 ? Math.max(4, y - h) : y}px`;
  ctxMenu = menu;
  ctxReturnFocus = from;
  menu.querySelector<HTMLButtonElement>('.menu-item:not([disabled])')?.focus();
}

/** Attach the right-click menu to an element; `items` is evaluated when it opens. */
function withContextMenu<T extends HTMLElement>(target: T, items: () => MenuItem[]): T {
  target.addEventListener('contextmenu', (e) => {
    // Text fields keep the normal Cut / Copy / Paste menu.
    if ((e.target as Element).closest?.('input, textarea, select')) return;
    e.preventDefault();
    e.stopPropagation();
    const r = target.getBoundingClientRect();
    const keyboard = e.clientX === 0 && e.clientY === 0;
    openContextMenu(keyboard ? r.left + 8 : e.clientX, keyboard ? r.bottom : e.clientY, items(), (document.activeElement as HTMLElement) ?? null);
  });
  return target;
}

document.addEventListener('mousedown', (e) => {
  if (ctxMenu && !(e.target as Element).closest?.('.context-menu')) closeContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (!ctxMenu) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeContextMenu(true);
  } else if (e.key === 'Tab') {
    closeContextMenu();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = [...ctxMenu.querySelectorAll<HTMLButtonElement>('.menu-item:not([disabled])')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
});
window.addEventListener('blur', () => closeContextMenu());
document.addEventListener('scroll', () => closeContextMenu(), true);

function fmt(n: number | null): string {
  if (n === null) return '–';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function scoreClass(score: number | null, rawSum = false, full: number | null = SERVER_SCORE_CAP): string {
  if (score === null) return 'score-none';
  if (rawSum) return 'score-partial';
  if (score >= (full ?? SERVER_SCORE_CAP)) return 'score-full';
  if (score <= 0) return 'score-zero';
  return 'score-partial';
}

/** "Out of": 100, or null for raw-sum problems (one rule: scoreText in src/grader/score.ts). */
function outOf(s: ScoreView): number | null {
  return outOfFor(s.rawSum);
}

/** Is the active file's problem raw-sum? (results and history use the same display rule). */
const activeRawSum = () => state?.problem?.score.rawSum ?? false;

function scorePill(s: ScoreView): HTMLElement {
  const tip =
    s.counted === null
      ? W.notAttemptedYet
      : W.scorePillTip(fmt(s.counted), outOf(s) !== null ? fmt(outOf(s)) : null, s.penaltyLabel, s.attempts);
  const full = s.counted !== null && s.rawSum ? `${tip} ${G.rawSumTip}` : tip;
  return el('span', { class: `pill score-pill ${scoreClass(s.counted, s.rawSum, outOf(s))}`, title: full, 'aria-label': full }, fmt(s.counted));
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
  if (s < 60) return W.ago.justNow;
  const m = Math.round(s / 60);
  if (m < 60) return W.ago.minAgo(m);
  const h = Math.round(m / 60);
  if (h < 24) return W.ago.hoursAgo(h);
  const d = Math.round(h / 24);
  if (d < 45) return W.ago.daysAgo(d);
  return new Date(t).toLocaleDateString(dateLocale() ?? [], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Exact local time for tooltips. */
function exact(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(dateLocale() ?? []);
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
const loginUser = el('input', { type: 'text', id: 'login-user', name: 'username', autocomplete: 'username', spellcheck: 'false', placeholder: W.username });
const loginPass = el('input', { type: 'password', id: 'login-pass', name: 'password', autocomplete: 'current-password', placeholder: W.password });
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
  el('label', { for: 'login-user' }, W.username),
  loginUser,
  el('label', { for: 'login-pass' }, W.password),
  loginPass,
  el('label', { class: 'check', for: 'login-remember' }, loginRemember, ' ', W.rememberPassword),
  el('button', { class: 'btn primary', type: 'submit' }, icon('sign-in'), ' ', W.logIn),
);
let showLoginForm = false;

const pickerSearch = el('input', { type: 'search', class: 'picker-search', placeholder: W.searchPlaceholder, 'aria-label': W.searchProblems, spellcheck: 'false' });
const pickerList = el('div', { class: 'picker-list', role: 'listbox' });
// One persistent container: typing only re-renders the list, never moves the search box.
const pickerBox = el('div', { class: 'picker' }, pickerSearch, pickerList);
let pickerOpen = false;

const problemFilter = el('input', { type: 'search', placeholder: W.filterPlaceholder, 'aria-label': W.filterProblems, spellcheck: 'false', value: ui.filter });

const sAccount = section('account', W.sectionAccount);
const sCurrent = section('current', W.sectionCurrent);
const sResult = section('result', W.sectionResult);
const sHistory = section('history', W.sectionHistory, [
  iconButton('question', W.readingTheResults, () => {
    legendOpen = legendOpen === 'history' ? null : 'history';
    forceRender();
  }),
  iconButton('refresh', W.refreshHistory, () => send({ type: 'refreshHistory' })),
]);
const sProblems = section('problems', W.sectionProblems, [iconButton('refresh', W.refreshProblems, () => send({ type: 'refreshProblems' }))]);
const banner = el('div', { class: 'banner', role: 'alert', hidden: true });
const promptBar = el('div', { class: 'prompt', role: 'status', hidden: true });
app.append(banner, promptBar, sAccount.details, sCurrent.details, sResult.details, sHistory.details, sProblems.details);

/** A question about submitting goes right above the Submit button (when Current problem is shown). */
function promptNearSubmit(s: ViewState): boolean {
  return s.prompt?.near === 'submit' && !sCurrent.details.hidden;
}

/** The contents of an inline question: text, detail, plain buttons. */
function fillPrompt(box: HTMLElement, q: NonNullable<ViewState['prompt']>): void {
  box.className = `prompt notice${q.tone === 'warn' ? ' warn' : ''}`;
  appendChildren(box, [
    el('div', { class: 'row' }, icon(q.tone === 'warn' ? 'warning' : 'info'), el('span', { class: 'grow' }, q.text)),
    q.detail ? el('p', { class: 'small muted' }, q.detail) : null,
    el('div', { class: 'row gap' }, ...q.buttons.map((b) => button(b.label, () => send({ type: 'promptAnswer', id: q.id, button: b.id }), { kind: b.primary ? 'primary' : 'secondary' }))),
  ]);
}

/** Inline question with plain buttons (instead of a modal dialog), under the banner. */
function renderPrompt(s: ViewState): void {
  const q = promptNearSubmit(s) ? null : s.prompt;
  promptBar.hidden = !q;
  promptBar.replaceChildren();
  if (q) fillPrompt(promptBar, q);
}

/** The question shown above Submit that was last scrolled into view (only new ones are). */
let revealedPrompt: number | null = null;

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
      button(c.action === 'login' ? [icon('sign-in'), ' ', W.logIn] : [icon('refresh'), ' ', W.retry], () => send({ type: 'retry' }), { kind: 'primary' }),
    ),
    el('p', {}, c.message),
    (s.problems.loaded || s.history.items.length > 0) && el('p', { class: 'small muted' }, W.showingSavedData),
    el('div', { class: 'row' }, troubleshootingLink()),
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
        el('span', { class: 'grow account-name', title: W.userOnHost(a.fullName ? `${a.fullName} (${a.username})` : a.username, host) },
          el('strong', { class: 'ellipsis' }, a.fullName || a.username),
          el('span', { class: 'muted small ellipsis' }, a.fullName ? `${a.username} · ${host}` : host),
        ),
        button([icon('sign-out'), ' ', W.logOut], () => send({ type: 'logout' }), { title: W.logOutTip }),
      ),
    );
    return;
  }
  if (a.status === 'logging-in') {
    b.append(el('div', { class: 'row muted' }, icon('loading', 'codicon-modifier-spin'), ' ', W.loggingIn(host)));
    return;
  }
  if (a.hasSavedPassword && a.username && !showLoginForm) {
    b.append(
      el('div', { class: 'row' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { class: 'grow ellipsis' }, W.savedLogin, ' ', el('strong', {}, a.username))),
      el('div', { class: 'row gap' },
        button([icon('sign-in'), ' ', W.logIn], () => send({ type: 'loginSaved' }), { kind: 'primary' }),
        el('button', { class: 'link', type: 'button', onclick: () => { showLoginForm = true; render(); } }, W.useAnotherAccount),
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
  if (a.error) b.append(el('div', { class: 'error', role: 'alert' }, icon('error'), ' ', a.error), el('div', { class: 'row' }, troubleshootingLink()));
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
      el('div', { class: 'muted pad' }, s.problems.loading ? W.loadingProblems : W.problemListNotLoaded),
      !s.problems.loading && button(W.loadProblems, () => send({ type: 'refreshProblems' })),
    ]);
  } else if (hits.length === 0) {
    pickerList.append(el('div', { class: 'muted pad' }, W.noMatchingProblems));
  } else {
    const top = !q ? (s.matching.ambiguous ?? s.matching.suggestions) : [];
    if (top.length) {
      pickerList.append(el('div', { class: 'picker-group muted small' }, s.matching.ambiguous ? W.matchesForThisFile : W.suggestedForThisFile));
      for (const p of top) pickerList.append(problemRow(p, s, 'picker'));
      pickerList.append(el('div', { class: 'picker-group muted small' }, W.allProblems));
    }
    for (const p of hits.slice(0, 50)) pickerList.append(problemRow(p, s, 'picker'));
    if (hits.length > 50) pickerList.append(el('div', { class: 'muted pad' }, W.moreResults(hits.length - 50)));
  }
}

function scoreCard(sc: ScoreView): HTMLElement {
  const card = el('div', { class: 'score-card' },
    el('div', { class: 'row score-row' },
      el('span', { class: 'muted small', title: sc.source === 'problem-list' ? `${W.countedScore} · ${W.penaltiesFromListTip}` : undefined }, W.countedScore),
      el('span', { class: 'grow' }),
      sc.source === 'problem-list' ? el('span', { class: 'muted small', title: W.penaltiesFromListTip }, W.fromProblemList) : null,
    ),
    (() => {
      const t = scoreText(sc.counted, sc.rawSum);
      return el('div', { class: `score ${scoreClass(sc.counted, sc.rawSum, outOf(sc))}`, title: t.tip ?? undefined }, sc.counted === null ? W.notAttempted : t.text);
    })(),
    el('div', { class: 'score-facts small' },
      el('span', {}, W.best, ' ', el('strong', {}, fmt(sc.best))),
      el('span', {}, W.latest, ' ', el('strong', {}, fmt(sc.latest))),
      el('span', {}, W.attempts, ' ', el('strong', {}, String(sc.attempts))),
      sc.penaltyLabel ? el('span', { class: 'penalty' }, sc.penaltyLabel) : null,
      sc.rawSum ? el('span', { class: 'muted' }, W.rawSumScoring) : null,
    ),
  );
  if (sc.latestBelowCounted && sc.latest !== null && sc.counted !== null) {
    card.append(el('p', { class: 'hint' }, icon('info'), ' ', W.latestBelowBest(fmt(sc.latest), fmt(sc.counted))));
  }
  return card;
}

function renderCurrent(s: ViewState): void {
  const b = sCurrent.body;
  b.replaceChildren();
  if (!s.file) {
    b.append(el('p', { class: 'muted' }, icon('file'), ' ', W.openFileToSubmit));
    return;
  }
  b.append(
    el('div', { class: 'row file', title: s.file.path },
      icon(s.file.supported ? 'file-code' : 'file'),
      el('span', { class: 'grow ellipsis' }, s.file.name),
      el('span', { class: 'muted small' }, s.file.languageGuess ?? W.unknownType),
    ),
  );

  const p = s.problem;
  const combo = el(
    'button',
    {
      class: 'combo',
      type: 'button',
      'aria-expanded': String(pickerOpen),
      title: p ? W.changeProblemTip(p.name, p.id) : W.chooseProblem,
      onclick: () => (pickerOpen ? closePicker() : openPicker()),
    },
    p
      ? el('span', { class: 'grow combo-text' },
          el('span', { class: 'ellipsis' }, el('strong', {}, p.name), el('span', { class: 'muted' }, ` #${p.id}`)),
          titleParts(p).subtitle ? el('span', { class: 'ellipsis muted small' }, titleParts(p).subtitle!) : null,
        )
      : el('span', { class: 'grow muted' }, W.chooseProblemEllipsis),
    icon(pickerOpen ? 'chevron-up' : 'chevron-down'),
  );
  b.append(
    withContextMenu(el('div', { class: 'field problem-field' },
      el('div', { class: 'field-label' }, W.problem,
        el('span', { class: 'grow' }),
        // All actions visible (as before the "…" menu); right-click offers the same.
        p ? iconButton('file-pdf', W.openStatement, () => send({ type: 'openStatement', problemId: p.id })) : null,
        p ? iconButton('copy', W.copyProblemName, () => send({ type: 'copyName', problemId: p.id })) : null,
        p ? iconButton('globe', W.openOnTheGraderWebsite, () => send({ type: 'openProblemInBrowser', problemId: p.id })) : null,
        // The website's "File": a template file or a zip package (only problems that have one).
        p?.hasAttachment
          ? iconButton('cloud-download', W.downloadAttachment, () => send({ type: 'downloadAttachment', problemId: p.id }), { disabledReason: s.attachment.busy === p.id ? W.downloading : null })
          : null,
        // The grader's test cases as .in / .out files (also with CPH installed).
        p?.hasTestcase
          ? iconButton('save-as', W.saveTestcasesAsFiles, () => send({ type: 'loadTestcases', asFiles: true }), { disabledReason: s.testcases.busy ? W.downloadingTestCases : null })
          : null,
        p && s.folderMode
          ? iconButton(s.folderMode.on ? 'file' : 'folder', s.folderMode.on ? W.linkOnlyFile : W.linkFolder, () => send({ type: 'toggleFolderMode' }), { disabledReason: s.folderMode.disabledReason })
          : null,
        iconButton('sparkle', W.autoDetectTip, () => send({ type: 'autoDetect' })),
        // Every state: a chosen link is unlinked; a name / CPH match or a suggestion becomes "not linked".
        p ? iconButton('close', unlinkLabel(p, s, true), () => send({ type: 'unmapProblem' })) : null,
      ),
      combo,
      pickerOpen ? (renderPickerList(s), pickerBox) : null,
      p ? (s.folder && !s.folder.matched ? folderLine(s.folder) : sourceLine(p.source, p.id, p.name)) : null,
      p && s.file?.renameTo
        ? el('div', { class: 'row source-line small muted' },
            icon('edit'),
            el('button', { class: 'link small', type: 'button', title: W.renameToProblemTip(s.file.name, s.file.renameTo), onclick: () => send({ type: 'renameFileToProblem' }) }, W.renameToProblem),
          )
        : null,
      !p && s.notLinked
        ? el('div', { class: 'notice' },
            el('div', { class: 'row' }, icon('debug-disconnect'), el('span', { class: 'grow' }, W.notLinkedToAProblem)),
            el('div', { class: 'row gap' },
              button(W.chooseProblem, () => openPicker(), { kind: 'primary', title: W.chooseProblemTip }),
              button(W.autoDetect, () => send({ type: 'autoDetect' }), { title: W.autoDetectAgainTip }),
            ),
          )
        : null,
      p?.unavailable
        ? el('div', { class: 'notice warn', role: 'alert' },
            el('div', { class: 'row' }, icon('warning'), el('span', { class: 'grow' }, W.problemUnavailableMsg)),
            el('div', { class: 'row gap' },
              button(W.changeProblem, () => openPicker(), { title: W.changeProblemTitle }),
              button(W.removeLink, () => send({ type: 'unmapProblem' }), { title: W.removeLinkTip }),
            ),
          )
        : null,
      s.matching.note ? el('p', { class: 'hint' }, icon('info'), ' ', s.matching.note) : null,
      s.linkedFiles.length > 1 ? linkedFilesNotice(s) : null,
    ), () => headerMenuItems(p)),
  );

  if (p) {
    b.append(scoreCard(p.score));
    const L = s.languages;
    const select = el('select', {
      id: 'lang',
      disabled: L.loading || L.items.length <= 1,
      title: L.loading ? W.loadingLanguages : L.items.length <= 1 ? W.oneLanguageOnly : W.languageTip,
      onchange: (e: Event) => send({ type: 'selectLanguage', languageId: Number((e.target as HTMLSelectElement).value) }),
    });
    if (L.items.length === 0) select.append(el('option', {}, L.loading ? W.loading : '—'));
    if (L.selectedId === null && L.items.length) select.append(el('option', { value: '', selected: true, disabled: true }, W.chooseLanguage));
    for (const l of L.items) select.append(el('option', { value: l.id, selected: l.id === L.selectedId }, l.name));
    b.append(el('div', { class: 'field' }, el('label', { class: 'field-label', for: 'lang' }, W.language), select));
    // Folder mode: which file Submit sends (the grader takes one file) and which program the tests run.
    if (s.folder) {
      const F = s.folder;
      b.append(
        rolePicker('submit-file', W.submits, 'submit', F.submitFile, F.submitChosen, F.submitWhy, F.candidates, W.submitFileAsk, W.submitFileTip),
        rolePicker('run-file', W.runs, 'run', F.runFile, F.runChosen, F.runWhy, F.runCandidates, W.runFileAsk, W.runFileTip),
        el('p', { class: 'small muted' }, W.submitFileTip),
      );
    }
    // Test-case buttons, all the same width: the grader's (when it has them), the statement's
    // example table (every problem), Run tests; side by side when they fit, stacked otherwise.
    const tests = el('div', { class: 'test-buttons' });
    if (p.hasTestcase) {
      tests.append(
        button(
          s.testcases.busy ? [icon('loading', 'codicon-modifier-spin'), ' ', W.loadingTestCases] : [icon('beaker'), ' ', W.loadTestCases],
          () => send({ type: 'loadTestcases' }),
          {
            disabled: s.testcases.busy,
            title: s.testcases.busy
              ? W.downloadingTestCases
              : s.cph.installed
                ? W.loadTestCasesCphTip
                : W.loadTestCasesFilesTip,
          },
        ),
      );
    }
    tests.append(
      button(
        s.samples.busy ? [icon('loading', 'codicon-modifier-spin'), ' ', W.readingSampleCases] : [icon('table'), ' ', W.loadSampleCases],
        () => send({ type: 'loadSampleCases' }),
        { disabled: s.samples.busy, title: s.samples.busy ? W.readingStatementTip : W.loadSampleCasesTip },
      ),
    );
    // Run tests (CPH installed only): the run file in folder mode, else this file.
    if (s.runTests) {
      tests.append(button([icon('play'), ' ', W.runTests], () => send({ type: 'runTests' }), { disabled: !!s.runTests.disabledReason, title: s.runTests.disabledReason ? `${W.runTestsTip} (${s.runTests.disabledReason})` : W.runTestsTip }));
    }
    b.append(tests);
    equalWidths(tests);
  }

  const mm = p ? s.languages.mismatch : null;
  if (mm) {
    b.append(
      el('div', { class: 'notice warn', role: 'status' },
        el('div', { class: 'row' },
          icon('warning'),
          el('span', { class: 'grow' }, W.languageNotAccepted(mm.wanted)),
          button(W.change, () => openPicker()),
        ),
        el('p', { class: 'small muted' }, W.acceptedLanguages(mm.allowed.join(', '))),
      ),
    );
  }

  if (s.cphTip) {
    b.append(
      el('div', { class: 'notice tip', role: 'note' },
        el('div', { class: 'row' }, icon('lightbulb'), el('span', { class: 'grow small' }, W.cphTip)),
        el('div', { class: 'row gap' },
          button(W.install, () => send({ type: 'cphTip', action: 'install' }), { kind: 'primary', title: W.cphInstallTip }),
          button(W.notNow, () => send({ type: 'cphTip', action: 'later' }), { title: W.notNowTip }),
          el('button', { class: 'link small', type: 'button', title: W.dontShowAgainTip, onclick: () => send({ type: 'cphTip', action: 'never' }) }, W.dontShowAgain),
        ),
      ),
    );
  }

  if (promptNearSubmit(s) && s.prompt) {
    const box = el('div', { id: 'submit-prompt', role: 'status' });
    fillPrompt(box, s.prompt);
    b.append(box);
    sCurrent.details.open = true;
  }

  const sub = s.submit;
  b.append(
    el('button', { class: 'btn big', type: 'button', id: 'submit-btn', disabled: !sub.enabled, title: sub.reason ?? undefined, onclick: () => send({ type: 'submit' }), 'aria-describedby': sub.reason ? 'submit-reason' : undefined },
      sub.busy ? icon('loading', 'codicon-modifier-spin') : icon('cloud-upload'),
      ` ${sub.busy ? 'Grading…' : sub.label}`,
    ),
  );
  if (s.gradingElsewhere) b.append(el('p', { class: 'hint' }, icon('loading', 'codicon-modifier-spin'), ' ', W.gradingOtherFile(s.gradingElsewhere)));
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
  const strip = el('div', { class: 'strip', role: 'group', 'aria-label': W.verdictPerTest });
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
  const btn = iconButton('question', W.readingTheResults, () => {
    legendOpen = legendOpen === where ? null : where;
    forceRender();
  });
  btn.setAttribute('aria-expanded', String(legendOpen === where));
  return btn;
}
function legend(): HTMLElement {
  return el('div', { class: 'legend', role: 'note' },
    el('strong', {}, W.readingTheResults),
    ...verdictLegend().map((c) => el('div', { class: 'row' }, el('span', { class: `tile v-${c.kind}`, 'aria-hidden': 'true' }, c.code), el('span', {}, c.word))),
    el('div', { class: 'row' }, el('span', { class: 'tile-group', 'aria-hidden': 'true' }, el('span', { class: 'tile v-correct' }, 'P'), el('span', { class: 'tile v-correct' }, 'P'), el('span', { class: 'tile v-wrong' }, '-')), el('span', {}, W.legendBox)),
    el('p', { class: 'small' }, W.legendTiles),
    el('p', { class: 'small muted' }, W.legendHover),
  );
}

function renderResult(s: ViewState): void {
  const b = sResult.body;
  b.replaceChildren();
  const r = s.result;
  if (!r) {
    b.append(el('p', { class: 'muted' }, W.noResultYet));
    return;
  }
  b.append(
    el('div', { class: 'row result-head' },
      r.number !== null ? el('span', { class: 'muted' }, W.attempt(r.number)) : null,
      r.number !== null && r.submissionId ? el('span', { class: 'muted' }, '·') : null,
      r.submissionId
        ? el('button', { class: 'link', type: 'button', title: W.openOnTheGraderWebsite, onclick: () => send({ type: 'openSubmission', submissionId: r.submissionId! }) }, `#${r.submissionId}`, icon('link-external'))
        : null,
      el('span', { class: 'grow' }),
      r.verdicts.length ? legendButton('result') : null,
    ),
  );
  if (legendOpen === 'result' && r.verdicts.length) b.append(legend());
  if (r.phase === 'submitting' || r.phase === 'grading') {
    b.append(el('div', { class: 'row status' }, icon('loading', 'codicon-modifier-spin'), ' ', r.message ?? W.grading));
  }
  if (r.phase === 'done' || ((r.phase === 'timeout' || r.phase === 'error') && r.verdicts.length)) {
    const st = scoreText(r.points, activeRawSum());
    const text = r.compileError ? W.compilationError : r.points !== null ? st.text : (r.message ?? W.graded);
    b.append(el('div', { class: 'row score-row' }, el('span', { class: `score ${r.compileError ? 'score-zero' : scoreClass(r.points, activeRawSum())}`, title: r.compileError ? undefined : (st.tip ?? undefined) }, text)));
    if (r.verdicts.length) {
      b.append(verdictStrip(r.verdicts));
    } else if (r.comment && !r.compileError) b.append(plainComment(r.comment));
    const failed = r.verdicts.filter((v) => !v.ok);
    if (failed.length && failed.length <= 6) b.append(el('ul', { class: 'failed' }, ...failed.map((v) => el('li', {}, v.label))));
    if (r.improvement) b.append(el('p', { class: 'improvement' }, icon('graph-line'), ' ', r.improvement));
  }
  if (r.compileError) {
    b.append(
      el('details', { class: 'compiler', open: true },
        el('summary', {}, W.compilerMessage),
        el('pre', {}, r.compilerMessage || W.empty),
        button([icon('go-to-file'), ' ', W.openInEditor], () => send({ type: 'showCompilerMessage' })),
      ),
    );
  }
  if (r.phase === 'timeout' || r.phase === 'error') {
    b.append(el('div', { class: r.phase === 'error' ? 'error' : 'notice' }, icon(r.phase === 'error' ? 'error' : 'clock'), ' ', r.message ?? ''));
  }
  if (r.phase !== 'submitting' && r.phase !== 'grading') {
  }
}

/** Compact strip for history rows: every test (no cut-off), wraps on its own line, groups kept as boxes. */
function miniStrip(verdicts: VerdictView[]): HTMLElement {
  const passed = verdicts.filter((v) => v.ok).length;
  const strip = el('div', { class: 'mini-strip', role: 'img', 'aria-label': W.testsPassed(passed, verdicts.length) });
  const mini = (v: VerdictView) => el('span', { class: `mini v-${v.kind in VERDICT_LETTER ? v.kind : 'unknown'}`, title: v.label });
  const groupCount = new Set(verdicts.filter((v) => v.group !== undefined).map((v) => v.group)).size;
  let i = 0;
  while (i < verdicts.length) {
    const v = verdicts[i];
    if (v.group === undefined) {
      strip.append(mini(v));
      i++;
      continue;
    }
    const members = verdicts.filter((x) => x.group === v.group);
    strip.append(el('span', { class: 'mini-group', title: groupLabel(v.group, groupCount, members) }, ...members.map(mini)));
    i += members.length;
  }
  return strip;
}

function detailBox(d: SubmissionDetailView): HTMLElement {
  const box = el('div', { class: 'detail' });
  box.append(
    el('div', { class: 'score-facts small' },
      el('span', {}, W.maxTime, ' ', el('strong', {}, seconds(d.maxRuntimeMs))),
      el('span', {}, W.peakMemory, ' ', el('strong', {}, megabytes(d.peakMemoryKb))),
      d.sourceFilename ? el('span', { class: 'mono' }, d.sourceFilename) : null,
    ),
  );
  if (d.evaluations.length) {
    const table = el('table', { class: 'evals' },
      el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, W.result), el('th', {}, W.score), el('th', {}, W.time), el('th', {}, W.memory))),
    );
    const body = el('tbody');
    for (const e of d.evaluations) {
      body.append(
        el('tr', {},
          el('td', { class: 'num' }, String(e.index)),
          el('td', {}, el('span', { class: `mini v-${e.kind in VERDICT_LETTER ? e.kind : 'unknown'}`, 'aria-hidden': 'true', title: e.label }), ' ', e.label.replace(/^Test \d+: /, '')),
          el('td', { class: 'num' }, e.score === null ? '–' : fmt(e.score)),
          el('td', { class: 'num' }, seconds(e.timeMs)),
          el('td', { class: 'num' }, megabytes(e.memoryKb)),
        ),
      );
    }
    table.append(body);
    box.append(el('div', { class: 'evals-wrap' }, table));
  }
  if (d.compilerMessage) box.append(el('details', { class: 'compiler' }, el('summary', {}, W.compilerMessage), el('pre', {}, d.compilerMessage)));
  box.append(
    el('div', { class: 'row gap' },
      button([icon('go-to-file'), ' ', W.openThisVersion], () => send({ type: 'openSubmissionSource', submissionId: d.submissionId }), { disabled: !d.hasSource, title: d.hasSource ? W.openThisVersionTip : W.noSourceTip }),
      button([icon('diff'), ' ', W.compareWithCurrentFile], () => send({ type: 'compareSubmission', submissionId: d.submissionId }), { disabled: !d.hasSource, title: d.hasSource ? W.compareWithCurrentFile : W.noSourceTip }),
      el('button', { class: 'link', type: 'button', title: W.openInBrowser, onclick: () => send({ type: 'openSubmission', submissionId: d.submissionId }) }, W.website, icon('link-external')),
    ),
  );
  return box;
}

function historyRow(h: HistoryEntry, s: ViewState): HTMLElement {
  const ex = s.history.expanded;
  const open = ex?.submissionId === h.submissionId;
  const row = el('div', { class: `history-item${open ? ' open' : ''}${h.counted ? ' counted' : ''}` });
  appendChildren(row, [
    el('div', { class: 'row history-line' },
    el('button', { class: 'history-row grow', type: 'button', 'aria-expanded': String(open), title: W.submissionTip(h.submissionId, exact(h.submittedAt)), onclick: () => send({ type: 'toggleSubmission', submissionId: h.submissionId }) },
      icon(open ? 'chevron-down' : 'chevron-right'),
      el('span', { class: 'mono muted' }, h.number !== null ? `${h.number}.` : `#${h.submissionId}`),
      (() => {
        const st = scoreText(h.points, activeRawSum());
        const tip = h.compileError ? W.compilationError : st.tip ? `${st.text}. ${st.tip}` : st.text;
        return el('span', { class: `pill ${h.compileError ? 'score-zero' : scoreClass(h.points, activeRawSum())}`, title: tip, 'aria-label': tip }, h.compileError ? W.ce : fmt(h.points));
      })(),
      // The star takes the colour of the counted score on this problem (penalties included), like the score pill.
      h.counted ? el('span', { class: `badge counted ${scoreClass(s.problem?.score.counted ?? h.points, activeRawSum())}`, title: W.countedTip, 'aria-label': W.countedLabel }, icon('star-full'), el('span', { class: 'counted-text' }, W.counted)) : null,
      el('span', { class: 'grow ellipsis' },
        h.verdicts.length
          ? el('span', { class: 'muted small', title: W.testsPassed(h.verdicts.filter((v) => v.ok).length, h.verdicts.length) }, `${h.verdicts.filter((v) => v.ok).length}/${h.verdicts.length}`)
          : h.compileError
            ? el('span', { class: 'muted small' }, W.compileError)
            : h.comment
              ? el('span', { class: 'mono small' }, `[${h.comment}]`)
              : el('span', { class: 'muted small' }, h.status.replace(/_/g, ' ')),
      ),
      el('span', { class: 'muted small nowrap', title: exact(h.submittedAt) }, relative(h.submittedAt)),
    ),
    iconButton('globe', W.openOnTheGraderWebsite, () => send({ type: 'openSubmission', submissionId: h.submissionId })),
    ),
    h.verdicts.length ? miniStrip(h.verdicts) : null,
  ]);
  if (open) {
    row.append(
      el('div', { class: 'row small muted pad-left' }, h.language ?? '', h.language ? ' · ' : '', exact(h.submittedAt), ` · #${h.submissionId}`),
    );
    if (ex!.detail) row.append(detailBox(ex!.detail));
    else if (ex!.loading) row.append(el('p', { class: 'muted small pad-left' }, icon('loading', 'codicon-modifier-spin'), ' ', W.loadingDetails));
    else if (ex!.error) row.append(el('div', { class: 'error pad-left' }, icon('error'), ' ', ex!.error));
  }
  return row;
}

function renderHistory(s: ViewState): void {
  const b = sHistory.body;
  b.replaceChildren();
  if (!s.problem) {
    b.append(el('p', { class: 'muted' }, W.chooseProblemForHistory));
    return;
  }
  const H = s.history;
  if (legendOpen === 'history') b.append(legend());
  if (H.stale) b.append(el('p', { class: 'hint' }, icon('warning'), ' ', W.mayBeOutOfDate));
  if (!H.items.length) {
    b.append(el('p', { class: 'muted' }, H.loading ? W.loading : H.error ? '' : W.noSubmissions));
  } else {
    const list = el('div', { class: 'history' });
    for (const h of H.items) list.append(historyRow(h, s));
    b.append(list, el('p', { class: 'muted small' }, W.nSubmissions(H.items.length)));
  }
  if (H.loading && H.items.length) b.append(el('p', { class: 'muted small' }, icon('loading', 'codicon-modifier-spin'), ' ', W.refreshing));
  if (H.error) b.append(el('div', { class: 'error' }, icon('error'), ' ', H.error));
}

/** Right-click on the problem header: the same actions as its icons. */
function headerMenuItems(p: ViewState['problem']): MenuItem[] {
  return [
    ...(p
      ? [
          { icon: 'file-pdf', label: W.openStatement, onclick: () => send({ type: 'openStatement', problemId: p.id }) },
          { icon: 'copy', label: W.copyProblemName, onclick: () => send({ type: 'copyName', problemId: p.id }) },
          { icon: 'globe', label: W.openOnTheGraderWebsite, onclick: () => send({ type: 'openProblemInBrowser', problemId: p.id }) },
        ]
      : []),
    ...(p?.hasAttachment
      ? [{ icon: 'cloud-download', label: W.downloadAttachment, onclick: () => send({ type: 'downloadAttachment', problemId: p.id }), disabledReason: state?.attachment.busy === p.id ? W.downloading : null }]
      : []),
    ...(p?.hasTestcase
      ? [{ icon: 'save-as', label: W.saveTestcasesAsFiles, onclick: () => send({ type: 'loadTestcases', asFiles: true }), disabledReason: state?.testcases.busy ? W.downloadingTestCases : null }]
      : []),
    ...(p && state?.folderMode
      ? [{
          icon: state.folderMode.on ? 'file' : 'folder',
          label: state.folderMode.on ? W.linkOnlyFile : W.linkFolder,
          tip: state.folderMode.on ? undefined : W.linkFolderTip,
          onclick: () => send({ type: 'toggleFolderMode' }),
          disabledReason: state.folderMode.disabledReason,
        }]
      : []),
    { icon: 'sparkle', label: W.autoDetectTip, onclick: () => send({ type: 'autoDetect' }) },
    ...(p && state?.file?.renameTo ? [{ icon: 'edit', label: W.renameToProblem, tip: W.renameToProblemTip(state.file.name, state.file.renameTo), onclick: () => send({ type: 'renameFileToProblem' }) }] : []),
    ...(p && state
      ? [{ icon: 'close', label: unlinkLabel(p, state, false), tip: W.autoDetectWontRelink, onclick: () => send({ type: 'unmapProblem' }) }]
      : []),
  ];
}

/** ✕: "Unlink this file / folder" for a link, "Don't match this file / folder" for a match. */
function unlinkLabel(p: NonNullable<ViewState['problem']>, s: ViewState, long: boolean): string {
  if (s.folder && !s.folder.matched) return long ? W.unlinkThisFolderTip : W.unlinkThisFolder;
  if (p.source === 'folder') return long ? W.dontMatchThisFolderTip : W.dontMatchThisFolder;
  if (p.source === 'saved') return long ? W.unlinkThisFileTip : W.unlinkThisFile;
  return long ? W.dontMatchThisFileTip : W.dontMatchThisFile;
}

/** Right-click on a problem row: the row's icons, plus linking the open file and the website. */
function rowMenuItems(p: ProblemView, s: ViewState): MenuItem[] {
  const fileName = s.file?.name;
  return [
    ...(fileName ? [{ icon: 'link', label: W.linkTo(fileName), tip: W.useFor(p.name, fileName), onclick: () => send({ type: 'mapProblem', problemId: p.id }) }] : []),
    { icon: 'copy', label: W.copyProblemName, onclick: () => send({ type: 'copyName', problemId: p.id }) },
    p.hasFile
      ? { icon: 'go-to-file', label: W.goToLinkedFile, onclick: () => send({ type: 'goToFile', problemId: p.id }) }
      : { icon: 'search', label: W.findMatchingFile, onclick: () => send({ type: 'findFile', problemId: p.id }) },
    { icon: 'new-file', label: W.newFileForThisProblem, onclick: () => send({ type: 'newFile', problemId: p.id }) },
    { icon: 'file-pdf', label: W.openStatement, onclick: () => send({ type: 'openStatement', problemId: p.id }) },
    ...(p.hasAttachment
      ? [{ icon: 'cloud-download', label: W.downloadAttachment, onclick: () => send({ type: 'downloadAttachment', problemId: p.id }), disabledReason: s.attachment.busy === p.id ? W.downloading : null }]
      : []),
    { icon: 'globe', label: W.openOnTheGraderWebsite, onclick: () => send({ type: 'openProblemInBrowser', problemId: p.id }) },
  ];
}

/** Last click on a list row (an editor switch caused by it never scrolls the list). */
let lastRowClickAt = 0;

function problemRow(p: ProblemView, s: ViewState, where: 'picker' | 'list'): HTMLElement {
  const mapped = s.problem?.id === p.id;
  const sub = titleParts(p).subtitle;
  const main = el('button', {
    class: 'problem-main',
    type: 'button',
    'aria-label': `${p.name} #${p.id}${sub ? `, ${sub}` : ''}`,
    // Picker: choose this problem for the file. List: open its linked file (or offer choices).
    disabled: where === 'picker' && !s.file,
    onclick: () => {
      if (where === 'picker') {
        pickerOpen = false;
        pickerSearch.value = '';
        send({ type: 'mapProblem', problemId: p.id });
      } else {
        lastRowClickAt = Date.now();
        send({ type: 'problemRowClick', problemId: p.id });
      }
    },
  },
    el('span', { class: 'problem-name ellipsis' }, mapped ? icon('check') : null, p.name, el('span', { class: 'muted id' }, ` #${p.id}`)),
    sub ? el('span', { class: 'problem-full ellipsis muted' }, sub) : null,
  );
  // Tooltip: just the names (bold "name #id", the title below).
  main.dataset.tipTitle = `${p.name} #${p.id}`;
  main.dataset.tip = main.disabled ? W.openFileToLink(sub ? `${sub} · ` : '') : (sub ?? '');
  // Icons as before the "…" menu (shown on hover / keyboard focus); right-click offers the same and more.
  return withContextMenu(
    el('div', { class: `problem-row${mapped ? ' mapped' : ''}`, role: where === 'picker' ? 'option' : undefined, 'aria-selected': where === 'picker' ? String(mapped) : undefined },
      main,
      scorePill(p.score),
      el('span', { class: 'row-actions' },
        iconButton('copy', W.copyProblemName, () => send({ type: 'copyName', problemId: p.id })),
        p.hasFile
          ? iconButton('go-to-file', W.goToLinkedFile, () => send({ type: 'goToFile', problemId: p.id }))
          : iconButton('search', W.findMatchingFile, () => send({ type: 'findFile', problemId: p.id })),
        iconButton('new-file', W.newFileForThisProblem, () => send({ type: 'newFile', problemId: p.id })),
        iconButton('file-pdf', W.openStatement, () => send({ type: 'openStatement', problemId: p.id })),
        // Last, so the other icons stay in the same columns on every row.
        p.hasAttachment
          ? iconButton('cloud-download', W.downloadAttachment, () => send({ type: 'downloadAttachment', problemId: p.id }), { disabledReason: s.attachment.busy === p.id ? W.downloading : null })
          : null,
      ),
    ),
    () => rowMenuItems(p, state ?? s),
  );
}

let linkedOpen = false;
const HOW_TEXT: Record<string, string> = HOW_LINKED;
function linkedFilesNotice(s: ViewState): HTMLElement {
  const box = el('div', { class: 'notice linked' });
  box.append(
    el('div', { class: 'row' },
      icon('files'),
      el('span', { class: 'grow small' }, s.linkedNotice ?? W.nFilesLinked(s.linkedFiles.length)),
      el('button', { class: 'link small', type: 'button', 'aria-expanded': String(linkedOpen), title: linkedOpen ? W.hideTheList : W.showTheFiles, onclick: () => { linkedOpen = !linkedOpen; forceRender(); } }, linkedOpen ? W.hide : W.show),
      el('button', { class: 'link small', type: 'button', title: W.dismissNoticeTip, onclick: () => send({ type: 'dismissLinkedNotice' }) }, W.dismiss),
    ),
  );
  if (linkedOpen) {
    box.append(
      el('div', { class: 'linked-list' },
        // Rows keep their order and height; only the "this file" mark moves.
        ...s.linkedFiles.map((f, i) => {
          const hide = (b: HTMLElement) => {
            if (f.current) {
              b.classList.add('invisible');
              b.setAttribute('aria-hidden', 'true');
              b.tabIndex = -1;
            }
            return b;
          };
          return el('div', { class: `linked-row${f.current ? ' current' : ''}`, 'aria-current': f.current ? 'true' : undefined },
            el('div', { class: 'row' },
              icon(f.current ? 'circle-filled' : f.path.endsWith('/') ? 'folder' : 'file'),
              el('span', { class: 'grow ellipsis', title: f.path }, f.path),
            ),
            el('div', { class: 'row gap small' },
              el('span', { class: 'muted grow' }, f.current ? W.thisFile(HOW_TEXT[f.how]) : HOW_TEXT[f.how]),
              hide(button(W.open, () => send({ type: 'openLinkedFile', index: i }), { title: W.openPath(f.path) })),
              hide(
                f.how === 'chosen'
                  ? button(W.unlink, () => send({ type: 'unlinkLinkedFile', index: i }), { title: W.unlinkFileTip(f.path) })
                  : button(W.dontMatchThisFile, () => send({ type: 'unlinkLinkedFile', index: i }), { title: W.dontMatchFileTip(f.path) }),
              ),
            ),
          );
        }),
      ),
      el('div', { class: 'row gap' }, button(W.unlinkTheOtherFiles, () => send({ type: 'keepOnlyThisFile' }), { title: W.unlinkOthersTip })),
    );
  }
  return box;
}

const SOURCE_ICON: Record<string, string> = { saved: 'pinned', filename: 'file', folder: 'folder', cph: 'beaker', suggested: 'lightbulb' };
const SOURCE_TEXT: Record<string, string> = W_SOURCE;

/** "How matched" line under the problem selector (text, not icon-only). Only "Suggested" stands out, with Confirm. */
function sourceLine(source: string, problemId: number, name: string): HTMLElement {
  if (source === 'suggested') {
    return el('div', { class: 'row source-line source-suggested small muted' },
      icon('lightbulb'),
      el('span', {}, W.suggestedFromFileName),
      el('span', {}, '·'),
      el('button', { class: 'link small', type: 'button', title: W.useThisTip(name, problemId), onclick: () => send({ type: 'confirmProblem', problemId }) }, W.useThis),
    );
  }
  return el('div', { class: `row source-line source-${source} small muted` }, icon(SOURCE_ICON[source] ?? 'info'), el('span', {}, SOURCE_TEXT[source] ?? source));
}

/**
 * Folder mode: one role's dropdown ("Submits" / "Runs"). The first option is
 * "Automatic: <detected file>" (or "asked when needed"); picking a file is
 * remembered for the folder; picking Automatic again forgets the choice.
 */
function rolePicker(id: string, label: string, role: 'submit' | 'run', file: string | null, chosen: boolean, why: string | null, files: string[], askText: string, tip: string): HTMLElement {
  const detected = chosen ? null : file;
  const pick = el('select', {
    id,
    disabled: !files.length,
    title: why && !chosen ? `${tip}. ${W.whyTip(why)}` : tip,
    onchange: (e: Event) => send({ type: 'setFolderRole', role, file: (e.target as HTMLSelectElement).value }),
  });
  pick.append(el('option', { value: '', selected: !chosen }, detected ? W.automatic(detected) : askText));
  for (const f of files) pick.append(el('option', { value: f, selected: chosen && f === file }, f));
  return el('div', { class: 'field' }, el('label', { class: 'field-label', for: id }, label), pick);
}

/** Folder mode: "Folder linked by you: pkg/" (instead of the match line). */
function folderLine(f: NonNullable<ViewState['folder']>): HTMLElement {
  return el('div', { class: 'row source-line source-folder small muted' }, icon('folder'), el('span', { class: 'ellipsis', title: f.path }, W.folderLinked(f.path)));
}

/**
 * Problem list: one persistent virtualized list (every problem reachable by
 * scrolling). Rows are keyed by problem id and rebuilt only when their own
 * data changed; an editor switch only updates the rows whose ✓ changed.
 */
const problemVersion = (p: ProblemView) =>
  JSON.stringify([p.name, p.fullName, p.score, p.status, p.hasFile, p.hasTestcase, p.hasAttachment, state?.attachment.busy === p.id, state?.problem?.id === p.id]);
let listSaveTimer: ReturnType<typeof setTimeout> | undefined;
const problemList = new VirtualList<ProblemView>(document, {
  key: (p) => String(p.id),
  version: problemVersion,
  // Compact mode hides the second line (full name stays in the tooltip).
  kind: (p) => (titleParts(p).subtitle && !compactOn ? 'two-line' : 'one-line'),
  render: (p) => problemRow(p, state!, 'list'),
  fallbackHeight: (k) => (k === 'two-line' ? 38 : 24),
  maxHeight: PANEL.listMaxHeightPx,
  className: 'problem-list',
  onScroll: (top) => {
    ui.listScroll = top;
    clearTimeout(listSaveTimer);
    listSaveTimer = setTimeout(saveUi, PANEL.scrollSaveMs);
  },
});
let listRestored = false;
let listHitsKey = '';
let listHits: ProblemView[] = [];

/** Filtered + sorted items (recomputed only when items, filter or search changed). */
function problemHits(s: ViewState): ProblemView[] {
  const q = problemFilter.value.trim().toLowerCase();
  const key = JSON.stringify([s.problems.items, s.problems.filter, q]);
  if (key !== listHitsKey) {
    listHitsKey = key;
    listHits = sortProblems(filterProblems(s.problems.items, s.problems.filter, q), s.problems.filter.sort ?? 'default');
  }
  return listHits;
}

/** Update the list rows in place (cheap; runs after every state push). */
function syncProblemList(s: ViewState): void {
  if (!s.problems.loaded || !problemList.viewport.isConnected) return;
  problemList.setItems(problemHits(s));
  if (!listRestored && ui.listScroll) {
    problemList.scrollTop = ui.listScroll;
  }
  listRestored = true;
}

function renderProblems(s: ViewState): void {
  const b = sProblems.body;
  const keepScroll = problemList.viewport.isConnected ? problemList.scrollTop : (ui.listScroll ?? 0);
  b.replaceChildren();
  const P = s.problems;
  if (!P.loaded) {
    if (P.loading) b.append(el('p', { class: 'muted' }, icon('loading', 'codicon-modifier-spin'), ' ', W.loadingProblems));
    else if (s.account.status !== 'logged-in' && !s.account.hasSavedPassword) b.append(el('p', { class: 'muted' }, W.logInToSeeProblems));
    else b.append(button([icon('refresh'), ' ', W.loadProblems], () => send({ type: 'refreshProblems' })));
    if (P.error) b.append(el('div', { class: 'error' }, icon('error'), ' ', P.error));
    return;
  }
  b.append(statusFilter(P.filter), el('div', { class: 'row gap filter-row' }, problemFilter, sortSelect(P.filter)));
  if (P.topics.length) b.append(topicFilter(P.filter, P.topics));
  const hits = problemHits(s);
  b.append(problemList.viewport);
  problemList.setItems(hits);
  // The same viewport element is re-inserted: put the scroll position back.
  if (keepScroll && problemList.scrollTop !== keepScroll) problemList.scrollTop = keepScroll;
  listRestored = true;
  b.append(el('p', { class: 'muted small list-count' }, hits.length === P.items.length ? W.nProblems(P.items.length) : W.nOfProblems(hits.length, P.items.length)));
  if (P.penaltyNote) b.append(el('p', { class: 'hint' }, icon('info'), ' ', P.penaltyNote));
  if (P.stale) b.append(el('p', { class: 'hint' }, icon('warning'), ' ', W.mayBeOutOfDate));
  if (P.loading) b.append(el('p', { class: 'muted small' }, icon('loading', 'codicon-modifier-spin'), ' ', W.refreshing));
  if (P.error) b.append(el('div', { class: 'error' }, icon('error'), ' ', P.error));
}

const STATUS_FILTERS: { key: ProblemFilter['status']; label: string; tip: string }[] = [
  { key: 'all', label: W.all, tip: W.allProblems },
  { key: 'unsolved', label: W.unsolved, tip: W.unsolvedTip },
  { key: 'inprogress', label: W.inProgress, tip: W.inProgressTip },
  { key: 'solved', label: W.solved, tip: W.solvedTip },
];

function statusFilter(f: ProblemFilter): HTMLElement {
  return el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': W.filterProblemsByStatus },
    ...STATUS_FILTERS.map((x) =>
      el('button', {
        class: `seg${f.status === x.key ? ' active' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(f.status === x.key), title: x.tip,
        onclick: () => send({ type: 'setFilter', filter: { ...f, status: x.key } }),
      }, x.label),
    ),
  );
}

function sortSelect(f: ProblemFilter): HTMLElement {
  const sel = el('select', { class: 'sort', 'aria-label': W.sortProblems, title: W.sortProblems, onchange: (e: Event) => {
    send({ type: 'setFilter', filter: { ...f, sort: (e.target as HTMLSelectElement).value as ProblemFilter['sort'] } });
  } });
  for (const x of sorts()) sel.append(el('option', { value: x.key, selected: (f.sort ?? 'default') === x.key }, x.label));
  return sel;
}

function topicFilter(f: ProblemFilter, topics: { name: string; description: string | null }[]): HTMLElement {
  return el('div', { class: 'topics', role: 'group', 'aria-label': W.filterProblemsByTopic },
    ...topics.map((t) =>
      el('button', {
        class: `topic${f.topic === t.name ? ' active' : ''}`, type: 'button', 'aria-pressed': String(f.topic === t.name),
        title: W.topicTip(t.description, t.name, f.topic === t.name),
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
    prompt: j([s.prompt, promptNearSubmit(s)]),
    account: j([s.account, s.baseUrl, showLoginForm]),
    current: j([promptNearSubmit(s) ? s.prompt : null, s.notLinked, s.linkedNotice, s.linkedFiles, s.file, s.problem, s.languages, s.submit, s.matching, s.testcases, s.samples, s.cph, s.gradingElsewhere, s.folder, s.folderMode, s.attachment, s.runTests, pickerOpen, pickerOpen ? s.problems : s.problems.loaded]),
    result: j([s.result, legendOpen === 'result', s.problem?.score.rawSum]),
    history: j([pid, s.history, legendOpen === 'history', s.problem?.score.rawSum]),
    problems: j([{ ...s.problems, items: s.problems.items.length }, ui.filter, s.attachment]),
  };
}

/** Panel layout settings: which sections, in which order, and compact mode. */
let compactOn = false;
let sectionOrderKey = '';
function applyLayout(s: ViewState): void {
  const compact = !!s.layout?.compact;
  if (compact !== compactOn) {
    compactOn = compact;
    document.body.classList.toggle('compact', compact);
    problemList.remeasure(); // rows change height: measure and lay the list out again
    lastKeys.delete('problems');
  }
  const order = visibleSections(s.layout?.sections ?? [], s.account.status === 'logged-in');
  const key = order.join(',');
  if (key === sectionOrderKey) return;
  sectionOrderKey = key;
  const all: Record<SectionId, ReturnType<typeof section>> = { account: sAccount, current: sCurrent, result: sResult, history: sHistory, problems: sProblems };
  for (const [id, sec] of Object.entries(all) as [SectionId, ReturnType<typeof section>][]) sec.details.hidden = !order.includes(id);
  // Move only when the order changed (existing elements are moved, nothing is rebuilt).
  app.append(banner, promptBar, ...order.map((id) => all[id].details), ...(Object.keys(all) as SectionId[]).filter((id) => !order.includes(id)).map((id) => all[id].details));
}

function render(): void {
  if (!state) {
    sAccount.body.replaceChildren(el('p', { class: 'muted' }, W.loading));
    return;
  }
  applyLayout(state);
  const active = document.activeElement;
  const pageScroll = document.scrollingElement?.scrollTop ?? 0;
  const keys = sectionKeys(state);
  const renderers: Record<string, (s: ViewState) => void> = {
    banner: renderBanner,
    prompt: renderPrompt,
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
  syncProblemList(state);
  // Persistent inputs survive re-render; restore focus if it was on one of them.
  if (active instanceof HTMLInputElement && document.body.contains(active) && document.activeElement !== active) active.focus();
  // A re-render never moves the panel, except to show a new question above Submit.
  if (document.scrollingElement && document.scrollingElement.scrollTop !== pageScroll) document.scrollingElement.scrollTop = pageScroll;
  const nearSubmit = promptNearSubmit(state) ? state.prompt : null;
  if (nearSubmit && revealedPrompt !== nearSubmit.id) document.getElementById('submit-prompt')?.scrollIntoView?.({ block: 'nearest' });
  revealedPrompt = nearSubmit?.id ?? null;
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
    problemList.scrollTop = 0; // new search: start at the top of the results
    problemFilter.focus();
  }
});

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'state') {
    if (state && state.account.status !== 'logged-in' && m.state.account.status === 'logged-in') showLoginForm = false;
    const prevPid = state?.problem?.id ?? null;
    state = m.state;
    render();
    const pid = state.problem?.id ?? null;
    // The active problem changed because the user opened a file themselves: show its row
    // with a minimal scroll. Never after a click in the list (the list stays where it is).
    if (pid !== null && pid !== prevPid && Date.now() - lastRowClickAt > PANEL.rowClickWindowMs) problemList.revealNearest(String(pid));
  } else if (m.type === 'focus') {
    if (m.target === 'login') {
      showLoginForm = true;
      ui.collapsed.account = false;
      sAccount.details.open = true;
      render();
      (loginUser.value ? loginPass : loginUser).focus();
    } else if (m.target === 'problem-search') {
      openPicker();
    } else if (m.target === 'result') {
      // Grading finished: show the Result section without taking keyboard focus from the editor.
      if (sResult.details.hidden) return; // hidden by cedtGrader.panel.sections
      ui.collapsed.result = false;
      sResult.details.open = true;
      sResult.details.scrollIntoView?.({ block: 'nearest' });
    } else {
      document.getElementById('submit-btn')?.focus();
    }
  }
});

render();
send({ type: 'ready' });
