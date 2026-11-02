/**
 * Protocol probe for cafe-grader-web (CEDT Grader).
 *
 *   npx tsx scripts/probe.ts --list
 *   npx tsx scripts/probe.ts --problem 123 [--fixtures]
 *   npx tsx scripts/probe.ts --problem 123 --submit path/to/sol.cpp [--language 2] [--fixtures]
 *
 * Credentials come from `.env` (GRADER_USER, GRADER_PASS, optional GRADER_BASE_URL).
 * Never prints passwords, cookies or CSRF tokens. Prints isContestPage() for
 * the pages it reads (informational only).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  chooseLanguage,
  DEFAULT_BASE_URL,
  GraderClient,
  GraderError,
  HttpSession,
  isContestPage,
  parseLoginForm,
  sanitizeHtml,
  type SubmissionStatus,
} from '../src/grader';

interface Args {
  list: boolean;
  fixtures: boolean;
  problem?: number;
  submit?: string;
  language?: number;
  }

function parseArgs(argv: string[]): Args {
  const a: Args = { list: false, fixtures: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`Missing value for ${k}`);
      return v;
    };
    if (k === '--list') a.list = true;
    else if (k === '--fixtures') a.fixtures = true;
    else if (k === '--problem') a.problem = Number(next());
    else if (k === '--submit') a.submit = next();
    else if (k === '--language') a.language = Number(next());
    else if (k === '--help' || k === '-h') {
      console.log(readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else die(`Unknown argument: ${k}`);
  }
  if (a.problem !== undefined && !(Number.isInteger(a.problem) && a.problem > 0)) die('--problem must be a positive integer');
  if (a.submit && a.problem === undefined) die('--submit needs --problem <id>');
  return a;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function printContest(where: string, html: string): void {
  console.log(`  isContestPage (${where}): ${isContestPage(html)}`);
}

function printStatus(s: SubmissionStatus): void {
  console.log(`  submission: ${s.id ?? '-'}  state: ${s.state}  score: ${s.score ?? '-'}  tries: ${s.tries ?? '-'}  time: ${s.time ?? '-'}`);
  if (s.comment) console.log(`  comment:    ${s.comment}`);
  if (s.verdicts.length) {
    console.log(`  verdicts:   ${s.verdicts.map((v) => (v.ok ? 'P' : v.kind === 'wrong' ? '-' : '!')).join('')}`);
    for (const v of s.verdicts.filter((x) => !x.ok)) console.log(`    ${v.label}  [${v.kind}]`);
  }
  if (s.compileError) console.log('  compile error: yes');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const envPath = resolve('.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const username = process.env.GRADER_USER ?? '';
  const password = process.env.GRADER_PASS ?? '';
  const baseUrl = (process.env.GRADER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!username || !password) die('Set GRADER_USER and GRADER_PASS in .env');

  const fixtureDir = resolve('test/fixtures');
  const personal = [username];
  const saved: string[] = [];
  const save = (name: string, html: string, userId: number | null) => {
    if (!args.fixtures) return;
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(resolve(fixtureDir, name), sanitizeHtml(html, { personal, userId }));
    saved.push(name);
  };

  // Record raw poll responses so --fixtures can save a pending and a graded one.
  const pollBodies: { pending?: string; graded?: string } = {};
  const recordingFetch = async (input: string, init?: RequestInit) => {
    const res = await fetch(input, init);
    if (args.fixtures && input.includes('get_latest_submission_status') && res.status === 200) {
      const body = await res.clone().text();
      if (/Waiting to be graded/i.test(body)) pollBodies.pending ??= body;
      else pollBodies.graded = body;
    }
    return res;
  };

  console.log(`Grader: ${baseUrl}`);

  // 0. Login page, fetched in a throw-away session (no credentials sent).
  const anon = new HttpSession(baseUrl);
  const loginPage = await anon.request('/');
  const lf = parseLoginForm(loginPage.body);
  console.log(`Login page: form ${lf.present ? 'found' : 'NOT found'}, agreement checkbox: ${lf.hasAgreement ? 'PRESENT' : 'absent'}`);
  if (lf.hasAgreement) {
    console.log('  The probe cannot log in while the grader asks for this agreement; accept it once on the website.');
  }
  save('login_page.html', loginPage.body, null);

  const client = new GraderClient({
    baseUrl,
    getCredentials: async () => ({ username, password }),
    fetch: recordingFetch,
    log: (line) => console.log(`  http: ${line}`),
  });

  // 1. Login.
  console.log('\n[1] Log in');
  await client.login();
  console.log(`  logged in. userId: ${client.userId === null ? 'not found on landing page' : `found (${String(client.userId).length} digits)`}`);

  // 2. Problem list.
  console.log('\n[2] Problem list (/main/list)');
  const listRaw = await client.getRaw('/main/list');
  save('main_list.html', listRaw.body, client.userId);
  const problems = await client.listProblems();
  console.log(`  ${problems.length} problems`);
  for (const p of args.list ? problems : problems.slice(0, 5)) {
    console.log(`    #${p.id}  ${p.name}  —  ${p.fullName}  best=${p.bestScore ?? '-'}  latest=${p.latestSubmissionId ?? '-'}`);
  }
  if (!args.list && problems.length > 5) console.log('    … (use --list for all)');
  printContest('problem list', listRaw.body);

  // 3. JSON list availability (informational only).
  try {
    const j = await client.getRaw('/main/list.json', { Accept: 'application/json' });
    const isJson = /json/.test(j.contentType);
    let n = '?';
    if (isJson) {
      try {
        n = String((JSON.parse(j.body) as unknown[]).length);
      } catch {
        /* ignore */
      }
    }
    console.log(`\n[3] /main/list.json: HTTP ${j.status}, ${isJson ? `JSON with ${n} entries` : `not JSON (${j.contentType || 'no content-type'})`}`);
  } catch (e) {
    console.log(`\n[3] /main/list.json: unavailable (${e instanceof Error ? e.message : e})`);
  }

  if (args.problem === undefined) return finish();
  const pid = args.problem;

  // 4. Submit page.
  console.log(`\n[4] Submit page for problem #${pid}`);
  const subRaw = await client.getRaw(`/submissions/direct_edit_problem/${pid}`);
  save('direct_edit_problem.html', subRaw.body, client.userId);
  const page = await client.getSubmitPage(pid);
  console.log(`  name: ${page.problemName ?? '?'}  full: ${page.problemFullName ?? '?'}  canSubmit: ${page.canSubmit}`);
  console.log(`  languages${page.languageForced ? ' (forced)' : ''}: ${page.languages.map((l) => `${l.id}=${l.name}${l.selected ? '*' : ''}`).join(', ') || '(none)'}`);
  printContest('submit page', subRaw.body);

  // 5. Existing submission (fixtures only): status, edit page, compiler msg, evaluations.
  const row = problems.find((p) => p.id === pid);
  if (args.fixtures && row?.latestSubmissionId) {
    console.log(`\n[5] Latest existing submission #${row.latestSubmissionId} (for fixtures)`);
    const edit = await client.getRaw(`/submissions/${row.latestSubmissionId}/edit`);
    save('submission_edit.html', edit.body, client.userId);
    try {
      const st = await client.getLatestStatus(pid);
      printStatus(st);
      if (pollBodies.graded) save('latest_status_graded.turbo.html', pollBodies.graded, client.userId);
      save('compiler_msg.turbo.html', await client.postTurbo(`/submissions/${row.latestSubmissionId}/compiler_msg`), client.userId);
      save('evaluations.turbo.html', await client.postTurbo(`/submissions/${row.latestSubmissionId}/evaluations`), client.userId);
    } catch (e) {
      console.log(`  status: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 6. Submit.
  if (args.submit) {
    console.log(`\n[6] Submit ${args.submit}`);
    const source = readFileSync(resolve(args.submit), 'utf8');
    let languageId = args.language;
    if (languageId === undefined) {
      const choice = chooseLanguage(args.submit, page.languages, page.languageForced);
      if (choice.kind === 'match') languageId = choice.language.id;
      else if (choice.kind === 'ambiguous') die(`Ambiguous language; pass --language one of ${choice.candidates.map((l) => `${l.id}=${l.name}`).join(', ')}`);
      else if (choice.kind === 'not-allowed') die(`${choice.wanted} is not allowed for this problem (allowed: ${choice.allowed.map((l) => l.name).join(', ')})`);
      else die('Unknown file extension; pass --language <id>');
    }
    console.log(`  language_id: ${languageId}`);
    const result = await client.submit(pid, languageId, source, { filename: args.submit });
    console.log(`  submitted: #${result.submissionId}  poll URL from server: ${result.pollUrl ? 'yes' : 'no (using discovered user id)'}`);
    const final = await client.pollLatest(pid, {
      submissionId: result.submissionId,
      pollUrl: result.pollUrl,
      onUpdate: (s) => console.log(`  … ${s.state}${s.score !== null ? ` score=${s.score}` : ''}`),
    });
    printStatus(final);
    if (pollBodies.pending) save('latest_status_pending.turbo.html', pollBodies.pending, client.userId);
    if (pollBodies.graded) save('latest_status_graded.turbo.html', pollBodies.graded, client.userId);

    const editRaw = await client.getRaw(`/submissions/${result.submissionId}/edit`).catch(() => null);
    if (editRaw) save('submission_edit.html', editRaw.body, client.userId);
    if (final.compileError) {
      const raw = await client.postTurbo(`/submissions/${result.submissionId}/compiler_msg`).catch(() => null);
      if (raw) save('compiler_msg_error.turbo.html', raw, client.userId);
      const msg = await client.getCompilerMessage(result.submissionId).catch((e) => `(failed: ${e.message})`);
      console.log(`  compiler message:\n${msg.split('\n').map((l) => '    ' + l).join('\n')}`);
    }
  }
  return finish();

  function finish(): void {
    if (saved.length) {
      console.log(`\nSaved sanitized fixtures to test/fixtures/: ${saved.join(', ')}`);
      console.log('Review them for personal data before committing.');
    }
  }
}

main().catch((e) => {
  const msg = e instanceof GraderError ? `${e.name}: ${e.message}` : e instanceof Error ? e.message : String(e);
  console.error(`\nFAILED: ${msg}`);
  process.exit(1);
});
