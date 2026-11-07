/*
 * README pictures (media/readme/*.png), rendered from the real sidebar bundle
 * with made-up sample data: no grader account, no network, no real names.
 * Run `npm run build` first (it reads media/dist/webview.js + webview.css).
 *
 *   npx tsx scripts/readmeShots.ts [--lang en|th] [--out <dir>] [name …]
 *
 * --lang th writes `<name>.th.png` with the panel in Thai. Names: see SHOTS
 * below (default: all). Needs Google Chrome (or CHROME=<path to a Chromium
 * binary>), driven headless over the DevTools protocol on 127.0.0.1; the
 * page loads only local files. The panel is 320 px wide in a 340 px frame,
 * at 2× (680 px wide pictures), in VS Code's Dark Modern colours.
 *
 * Each PNG is reduced to a 256-colour palette with ffmpeg (palettegen /
 * paletteuse, no dithering: about half the size, no visible change) when
 * `ffmpeg` is on PATH (or FFMPEG=<path>); otherwise Chrome's PNG is kept.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseGraderComment } from '../src/grader/verdicts';
import { setLanguage, type Lang } from '../src/shared/i18n';
import type { HistoryEntry, ProblemView, ScoreView, SubmissionDetailView, ViewState } from '../src/shared/messages';
import { G, MATCH_SOURCE, S } from '../src/shared/strings';

const ROOT = resolve(__dirname, '..');
const DIST = join(ROOT, 'media', 'dist');
const WIDTH = 340; // CSS px; the panel is WIDTH - 2 * SIDE
const SIDE = 10;
const SCALE = 2;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ---------------------------------------------------------------- sample data

const BASE_URL = 'https://cedt-grader.nattee.net';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const score = (counted: number | null, extra: Partial<ScoreView> = {}): ScoreView => ({
  counted, outOf: 100, best: counted, latest: counted, attempts: counted === null ? 0 : 1,
  penaltyLabel: null, rawSum: false, source: 'problem-list', latestBelowCounted: false, ...extra,
});

function problem(id: number, name: string, fullName: string, sc: ScoreView, tags: string[], extra: Partial<ProblemView> = {}): ProblemView {
  const status = sc.attempts === 0 ? 'untried' : (sc.best ?? 0) >= 100 ? 'solved' : 'inprogress';
  return {
    id, name, fullName, score: sc, hasFile: sc.attempts > 0, hasTestcase: true, hasAttachment: false, status, tags,
    lastSubmissionTime: sc.attempts ? minutesAgo(id % 97) : null, lastOpened: null, ...extra,
  };
}

/** Built after setLanguage(), so host-side texts (S / G / MATCH_SOURCE) are in the chosen language. */
function sample() {
  const current = problem(1360, '00_Intro_11', '00_Intro_★_Hello_World',
    score(90, { best: 100, latest: 100, attempts: 3, penaltyLabel: G.penalty('10', 'ai') }), ['ComProg']);
  const pkg = problem(1531, '07_Class_12', '07_Class_★★_Queue_Header',
    score(60, { best: 60, latest: 60, attempts: 1 }), ['ComProg'], { hasAttachment: true });
  const problems: ProblemView[] = [
    current,
    problem(1361, '00_Intro_12', '00_Intro_★_Input_and_Output', score(100, { attempts: 2 }), ['ComProg', 'warm-up']),
    problem(1271, '01_Expr_11', '01_Expr_★_An_Expression', score(100), []),
    problem(1272, '01_Expr_12', '01_Expr_★_Quadratic_Root', score(55, { attempts: 4 }), ['math']),
    problem(1305, '02_If_11', '02_If_★_Grade', score(null), []),
    problem(1306, '02_If_12', '02_If_★★_Triangle', score(null), []),
    problem(1420, '03_Loop_11', '03_Loop_★_Sum_of_Digits', score(null), ['Loop']),
  ];

  // Test 4 timed out: History's details show a long verdict ("Time Limit Exceed") that has to fit a narrow panel.
  const verdicts = parseGraderComment('PPPT[PP]-');
  const history: HistoryEntry[] = [
    { submissionId: 2461102, number: 3, points: 71, status: 'done', comment: 'PPPT[PP]-', submittedAt: minutesAgo(5), language: 'C++', compileError: false, counted: true, verdicts },
    { submissionId: 2460877, number: 2, points: 40, status: 'done', comment: 'PPP-[P-]-', submittedAt: minutesAgo(53), language: 'C++', compileError: false, counted: false, verdicts: parseGraderComment('PPP-[P-]-') },
    { submissionId: 2460512, number: 1, points: 0, status: 'compilation_error', comment: 'Compilation error', submittedAt: minutesAgo(70), language: 'C++', compileError: true, counted: false, verdicts: [] },
  ];
  const detail: SubmissionDetailView = {
    submissionId: 2461102, url: `${BASE_URL}/submissions/2461102`, status: 'done', compilerMessage: null,
    maxRuntimeMs: 12, peakMemoryKb: 3482, hasSource: true, sourceFilename: '00_Intro_11.cpp',
    evaluations: verdicts.map((v, i) => ({
      index: v.index, kind: v.kind, label: G.verdict[v.kind] ?? v.kind,
      score: v.ok ? 14.29 : 0, timeMs: 2 + i, memoryKb: 3400 + 10 * i,
    })),
  };

  const state: ViewState = {
    baseUrl: BASE_URL,
    layout: { sections: ['account', 'current', 'result', 'history', 'problems'], compact: false },
    account: { status: 'logged-in', username: '6830000021', fullName: 'Somchai Jaidee', hasSavedPassword: true, rememberPassword: true, error: null, server: { draft: null, status: 'idle', message: null } },
    file: { path: 'grader/00_Intro_11.cpp', name: '00_Intro_11.cpp', languageGuess: 'C++', supported: true, renameTo: null },
    problem: { ...current, source: 'filename', sourceLabel: MATCH_SOURCE.filename, unavailable: false },
    linkedFiles: [],
    linkedNotice: null,
    folder: null,
    runTests: null,
    folderMode: { on: false, disabledReason: null },
    attachment: { busy: null },
    crash: null,
    notLinked: false,
    prompt: null,
    matching: { suggestions: [], ambiguous: null, note: null },
    testcases: { busy: false },
    languages: { loading: false, items: [{ id: 1, name: 'C' }, { id: 2, name: 'C++' }, { id: 3, name: 'Python' }, { id: 4, name: 'Java' }], selectedId: 2, mismatch: null },
    connection: null,
    submit: { enabled: true, busy: false, reason: null, label: S.submitLabel },
    result: {
      phase: 'done', problemId: 1360, problemName: '00_Intro_11', submissionId: 2461102, submissionUrl: `${BASE_URL}/submissions/2461102`,
      number: 3, points: 71, comment: 'PPPT[PP]-', verdicts, compileError: false, compilerMessage: null,
      improvement: G.countedImproved(40, 71), message: null,
    },
    gradingElsewhere: null,
    history: { loading: false, stale: false, error: null, items: history, expanded: null },
    problems: {
      loading: false, loaded: true, stale: false, items: problems, error: null,
      filter: { status: 'all', topic: null, topicsIn: [], topicsOut: [], tags: [], tagMode: 'or', sort: 'default' },
      topics: [{ name: 'ComProg', description: null }, { name: 'Loop', description: null }],
      tags: ['math', 'warm-up'],
      topicClickOrder: 'showFirst',
      penaltyNote: null,
    },
  };

  const folderState: ViewState = {
    ...state,
    file: { path: 'grader/07_Class_12/student.h', name: 'student.h', languageGuess: 'C++', supported: true, renameTo: null },
    problem: { ...pkg, source: 'saved', sourceLabel: MATCH_SOURCE.saved, unavailable: false },
    folder: {
      path: 'grader/07_Class_12/', matched: false,
      submitFile: 'student.h', submitWhy: S.folder.why.student('main.cpp'), submitChosen: false,
      runFile: 'main.cpp', runWhy: S.folder.why['only-main']('main.cpp'), runChosen: false,
      candidates: ['main.cpp', 'student.h'], runCandidates: ['main.cpp', 'student.h'],
    },
    folderMode: { on: true, disabledReason: null },
    runTests: { summary: { kind: 'done', passed: 3, total: 6 }, running: false, disabledReason: null, testsOpen: false },
    result: null,
    history: { ...state.history, items: [] },
  };
  return { state, folderState, history, detail };
}

// ---------------------------------------------------------------- shots

interface Shot {
  state?: ViewState;
  /** JavaScript run in the page after the state is rendered (clicks on local UI such as the legend). */
  after?: string;
  /** Full-width HTML replacing the webview panel (Activity Bar + Extensions sidebar for `install`). */
  html?: string;
}

function installHtml(lang: Lang): string {
  const nlsFile = lang === 'th' ? 'package.nls.th.json' : 'package.nls.json';
  const nls = JSON.parse(readFileSync(join(ROOT, nlsFile), 'utf8')) as Record<string, string>;
  const desc = nls['extension.description'] ?? '';
  const iconPng = pathToFileURL(join(ROOT, 'media', 'icon.png')).href;
  const iconSvg = readFileSync(join(ROOT, 'media', 'icon.svg'), 'utf8').trim();
  const hint = lang === 'th' ? 'ไอคอน Grader จะแสดงตรงนี้หลังติดตั้ง' : 'CEDT Grader appears here after install';
  return `<style>
    .inst-wrap { display: flex; width: ${WIDTH}px; background: #181818; color: #cccccc; font-family: -apple-system, BlinkMacSystemFont, sans-serif; border-top: 1px solid #2b2b2b; border-bottom: 1px solid #2b2b2b; }
    .inst-act { width: 48px; flex-shrink: 0; background: #181818; border-right: 1px solid #2b2b2b; display: flex; flex-direction: column; align-items: center; padding: 2px 0 4px; box-sizing: border-box; }
    .inst-act-item { position: relative; width: 48px; height: 34px; display: flex; align-items: center; justify-content: center; color: #868686; }
    .inst-act-item .codicon { font-size: 22px; }
    .inst-act-item.active { color: #ffffff; height: 36px; }
    .inst-act-item.active::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: #0078d4; }
    .inst-act-item.grader { color: #cccccc; height: 38px; margin-top: 2px; }
    .inst-act-item.grader svg { width: 22px; height: 22px; }
    .inst-act-item.grader::after { content: ''; position: absolute; inset: 4px 9px; border: 1px dashed #3794ff; border-radius: 5px; opacity: 0.75; }
    .inst-side { flex: 1; min-width: 0; display: flex; flex-direction: column; background: #181818; }
    .inst-hdr { height: 35px; padding: 0 10px 0 16px; display: flex; align-items: center; justify-content: space-between; font-size: 11px; letter-spacing: 0.04em; color: #cccccc; }
    .inst-hdr-icons { display: flex; gap: 6px; color: #c5c5c5; }
    .inst-hdr-icons .codicon { font-size: 16px; }
    .inst-search-wrap { padding: 0 10px 8px 10px; border-bottom: 1px solid #2b2b2b; }
    .inst-search { height: 26px; background: #313131; border: 1px solid #0078d4; border-radius: 2px; padding: 0 6px 0 8px; display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .inst-search-text { font-size: 13px; color: #ffffff; white-space: nowrap; overflow: hidden; }
    .inst-search-right { display: flex; align-items: center; gap: 4px; color: #9d9d9d; flex-shrink: 0; }
    .inst-search-right .codicon { font-size: 14px; }
    .inst-row { display: flex; gap: 10px; padding: 10px 10px 10px 12px; background: #2a2d2e; border-bottom: 1px solid #2b2b2b; align-items: flex-start; }
    .inst-icon { width: 42px; height: 42px; border-radius: 6px; flex-shrink: 0; margin-top: 2px; }
    .inst-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .inst-title-row { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
    .inst-title { font-size: 13px; font-weight: 700; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .inst-desc { font-size: 12px; color: #9d9d9d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 16px; }
    .inst-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 3px; }
    .inst-pub { font-size: 11px; font-weight: 600; color: #9d9d9d; }
    .inst-cta { display: flex; align-items: center; gap: 5px; }
    .inst-btn { background: #0078d4; color: #ffffff; font-size: 11px; font-weight: 600; line-height: 16px; padding: 1px 8px; border-radius: 2px; }
    .inst-step { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 999px; background: #0078d4; color: #ffffff; font-size: 10px; font-weight: 700; line-height: 1; box-shadow: 0 0 0 1.5px #181818; flex-shrink: 0; }
    .inst-act-item .inst-step { position: absolute; top: 2px; right: 5px; }
    .inst-callout { margin-top: auto; height: 40px; padding: 0 10px 2px 8px; display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: #9d9d9d; }
    .inst-arrow { color: #3794ff; font-size: 13px; font-weight: 700; line-height: 1; }
  </style>
  <div class="inst-wrap">
    <div class="inst-act">
      <div class="inst-act-item"><span class="codicon codicon-files"></span></div>
      <div class="inst-act-item"><span class="codicon codicon-search"></span></div>
      <div class="inst-act-item"><span class="codicon codicon-source-control"></span></div>
      <div class="inst-act-item"><span class="codicon codicon-debug-alt"></span></div>
      <div class="inst-act-item active"><span class="codicon codicon-extensions"></span><span class="inst-step">1</span></div>
      <div class="inst-act-item grader">${iconSvg}</div>
    </div>
    <div class="inst-side">
      <div class="inst-hdr">
        <span>EXTENSIONS</span>
        <span class="inst-hdr-icons">
          <span class="codicon codicon-refresh"></span>
          <span class="codicon codicon-clear-all"></span>
          <span class="codicon codicon-ellipsis"></span>
        </span>
      </div>
      <div class="inst-search-wrap">
        <div class="inst-search">
          <span class="inst-search-text">Grader Submit</span>
          <span class="inst-search-right">
            <span class="inst-step">2</span>
            <span class="codicon codicon-clear-all"></span>
            <span class="codicon codicon-filter"></span>
          </span>
        </div>
      </div>
      <div class="inst-row">
        <img class="inst-icon" src="${iconPng}" alt="">
        <div class="inst-main">
          <div class="inst-title-row"><span class="inst-title">Grader Submit</span></div>
          <div class="inst-desc">${desc}</div>
          <div class="inst-foot">
            <span class="inst-pub">Badvoic3</span>
            <span class="inst-cta"><span class="inst-step">3</span><span class="inst-btn">Install</span></span>
          </div>
        </div>
      </div>
      <div class="inst-callout">
        <span class="inst-arrow">←</span>
        <span>${hint}</span>
      </div>
    </div>
  </div>`;
}

function shots(lang: Lang): Record<string, Shot> {
  const { state, folderState, detail } = sample();
  const only = (ids: ViewState['layout']['sections'], s: ViewState = state): ViewState => ({ ...s, layout: { ...s.layout, sections: ids } });
  return {
    install: { html: installHtml(lang) },
    panel: { state },
    current: { state: only(['current']) },
    notice: {
      state: only(['current'], {
        ...state,
        linkedFiles: [
          { path: 'grader/00_Intro_11.cpp', current: true, how: 'filename' },
          { path: 'practice/00_Intro_11.cpp', current: false, how: 'filename' },
        ],
        linkedNotice: S.notice.sameNameOne,
      }),
    },
    'folder-mode': { state: only(['current'], folderState) },
    result: { state: only(['result']), after: `document.querySelector('#sec-result .section-body button[aria-expanded]')?.click()` },
    history: { state: only(['history'], { ...state, history: { ...state.history, expanded: { submissionId: 2461102, loading: false, error: null, detail } } }) },
    problems: { state: only(['problems']) },
    banner: {
      state: only(['history'], {
        ...state,
        connection: { kind: 'offline', title: G.offlineTitle, message: G.offlineMsg, action: 'retry' },
        history: { ...state.history, stale: true },
      }),
    },
  };
}

// ---------------------------------------------------------------- page

/** VS Code "Dark Modern" theme variables (the ones webview/style.css reads) and VS Code's macOS fonts. */
const THEME: Record<string, string> = {
  'font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
  'font-size': '13px',
  'font-weight': 'normal',
  'editor-font-family': 'Menlo, Monaco, "Courier New", monospace',
  foreground: '#cccccc',
  descriptionForeground: '#9d9d9d',
  errorForeground: '#f85149',
  focusBorder: '#0078d4',
  'widget-border': '#313131',
  'widget-shadow': 'rgba(0, 0, 0, 0.36)',
  'sideBar-background': '#181818',
  'sideBarSectionHeader-background': '#181818',
  'sideBarSectionHeader-foreground': '#cccccc',
  'sideBarSectionHeader-border': '#2b2b2b',
  'editor-background': '#1f1f1f',
  'editorWidget-background': '#202020',
  'editorHoverWidget-background': '#202020',
  'editorHoverWidget-foreground': '#cccccc',
  'editorHoverWidget-border': '#454545',
  'editorWarning-foreground': '#cca700',
  'input-background': '#313131',
  'input-border': '#3c3c3c',
  'input-foreground': '#cccccc',
  'input-placeholderForeground': '#989898',
  'inputValidation-infoBackground': '#063b49',
  'inputValidation-infoBorder': '#007acc',
  'inputValidation-warningBackground': '#352a05',
  'inputValidation-warningBorder': '#b89500',
  'inputValidation-errorBackground': '#5a1d1d',
  'inputValidation-errorBorder': '#be1100',
  'dropdown-background': '#313131',
  'dropdown-border': '#3c3c3c',
  'dropdown-foreground': '#cccccc',
  'button-background': '#0078d4',
  'button-foreground': '#ffffff',
  'button-hoverBackground': '#026ec1',
  'button-border': 'rgba(255, 255, 255, 0.07)',
  'button-secondaryBackground': '#313131',
  'button-secondaryForeground': '#cccccc',
  'button-secondaryHoverBackground': '#3c3c3c',
  'list-hoverBackground': '#2a2d2e',
  'list-inactiveSelectionBackground': '#37373d',
  'list-focusOutline': '#0078d4',
  'toolbar-hoverBackground': 'rgba(90, 93, 94, 0.31)',
  'textLink-foreground': '#4daafc',
  'textLink-activeForeground': '#4daafc',
  'textCodeBlock-background': '#2b2b2b',
  'badge-background': '#616161',
  'badge-foreground': '#f8f8f8',
  'testing-iconPassed': '#73c991',
  'testing-iconFailed': '#f14c4c',
  'menu-background': '#1f1f1f',
  'menu-foreground': '#cccccc',
  'menu-border': '#454545',
  'menu-selectionBackground': '#0078d4',
  'menu-selectionForeground': '#ffffff',
  'charts-yellow': '#cca700',
  'charts-purple': '#b180d7',
  'charts-blue': '#3794ff',
  'charts-green': '#89d185',
  'charts-red': '#f14c4c',
};

function pageHtml(lang: Lang): string {
  const url = (f: string) => pathToFileURL(join(DIST, f)).href;
  const vars = Object.entries(THEME).map(([k, v]) => `--vscode-${k}: ${v};`).join('\n');
  return `<!DOCTYPE html>
<html lang="${lang}" class="vscode-dark">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="${url('codicon.css')}">
<link rel="stylesheet" href="${url('webview.css')}">
<style>
:root { ${vars} }
html { background: #181818; }
body { width: ${WIDTH - 2 * SIDE}px; margin: 6px ${SIDE}px 0; }
/* No caret, no hover state, no scrollbars in the pictures. */
* { caret-color: transparent; scrollbar-width: none; }
</style>
</head>
<body class="vscode-dark">
<div id="app"></div>
<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return undefined; }, setState() {} });</script>
<script src="${url('webview.js')}"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------- Chrome (DevTools protocol)

class Cdp {
  private id = 0;
  private waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private events: { method: string; resolve: () => void }[] = [];
  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w?.fail(new Error(`${m.error.message}`));
        else w?.ok(m.result);
      } else {
        this.events = this.events.filter((e) => (e.method === m.method ? (e.resolve(), false) : true));
      }
    });
  }
  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => fail(new Error('DevTools connection failed')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, fail) => this.waiting.set(id, { ok, fail }));
  }
  once(method: string): Promise<void> {
    return new Promise((resolve) => this.events.push({ method, resolve }));
  }
  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close(): void {
    this.ws.close();
  }
}

async function launchChrome(profile: string): Promise<{ page: Cdp; stop: () => Promise<void> }> {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME=<path>`);
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-default-apps', '--disable-extensions', '--disable-domain-reliability',
    '--metrics-recording-only', '--safebrowsing-disable-auto-update', '--hide-scrollbars', '--force-color-profile=srgb',
    '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication',
    'about:blank',
  ], { stdio: 'ignore', env: { ...process.env, TZ: 'Asia/Bangkok' } });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(portFile)) {
    proc.kill();
    throw new Error('Chrome did not start');
  }
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = await Cdp.open(targets.find((t) => t.type === 'page')!.webSocketDebuggerUrl);
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  return { page, stop: async () => { page.close(); proc.kill(); await exited; } };
}

async function take(page: Cdp, htmlUrl: string, shot: Shot): Promise<Buffer> {
  const loaded = page.once('Page.loadEventFired');
  await page.send('Page.navigate', { url: htmlUrl });
  await loaded;
  if (shot.html) {
    await page.eval(`document.body.style.cssText = 'width:${WIDTH}px;margin:0'; document.getElementById('app').innerHTML = ${JSON.stringify(shot.html)}; Promise.all([...document.images].map((i) => i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))`);
  } else {
    await page.eval(`window.postMessage(${JSON.stringify({ type: 'state', state: shot.state })}, '*'); new Promise((r) => setTimeout(r, 50))`);
  }
  if (shot.after) await page.eval(`${shot.after}; new Promise((r) => setTimeout(r, 50))`);
  await page.eval(`document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`);
  const bottom: number = await page.eval(`document.body.getBoundingClientRect().bottom`);
  const height = Math.ceil(bottom) + (shot.html ? 0 : 6);
  const r = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: WIDTH, height, scale: 1 } });
  return Buffer.from(r.data, 'base64');
}

/** 256-colour palette, in place (keeps the file when ffmpeg is missing or fails). */
function shrink(file: string): void {
  const tmp = `${file}.tmp.png`;
  const r = spawnSync(process.env.FFMPEG ?? 'ffmpeg', [
    '-loglevel', 'error', '-y', '-i', file,
    '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=none',
    tmp,
  ], { stdio: 'ignore' });
  if (r.status === 0 && existsSync(tmp)) renameSync(tmp, file);
  else rmSync(tmp, { force: true });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const lang = (opt('--lang') ?? 'en') as Lang;
  if (lang !== 'en' && lang !== 'th') throw new Error('--lang must be en or th');
  const out = resolve(opt('--out') ?? join(ROOT, 'media', 'readme'));
  if (!existsSync(join(DIST, 'webview.js'))) throw new Error('media/dist/webview.js is missing: run `npm run build` first');
  setLanguage(lang);
  const all = shots(lang);
  const names = args.length ? args : Object.keys(all);
  for (const n of names) if (!all[n]) throw new Error(`unknown picture "${n}" (known: ${Object.keys(all).join(', ')})`);

  const work = mkdtempSync(join(tmpdir(), 'readme-shots-'));
  const htmlPath = join(work, 'panel.html');
  writeFileSync(htmlPath, pageHtml(lang));
  const { page, stop } = await launchChrome(join(work, 'profile'));
  try {
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 3000, deviceScaleFactor: SCALE, mobile: false });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    mkdirSync(out, { recursive: true });
    for (const n of names) {
      const png = await take(page, pathToFileURL(htmlPath).href, all[n]!);
      const file = join(out, lang === 'en' ? `${n}.png` : `${n}.${lang}.png`);
      writeFileSync(file, png);
      shrink(file);
      console.log(`${file}  ${(statSync(file).size / 1024).toFixed(0)} KB`);
    }
  } finally {
    await stop();
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
