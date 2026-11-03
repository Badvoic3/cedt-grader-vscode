/**
 * Protocol probe for cafe-grader-web (CEDT Grader). Read-only unless --submit is given.
 *
 *   npx tsx scripts/probe.ts [--list] [--problem <id>] [--fixtures]
 *   npx tsx scripts/probe.ts --problem <id> --submit path/to/sol.cpp [--language <id>]
 *   npx tsx scripts/probe.ts --problem <id> --attachment   (status, type, file name, size; zip entry names; never the body)
 *
 * Credentials come from `.env` (GRADER_USER, GRADER_PASS, optional GRADER_BASE_URL).
 * Never prints passwords, tokens, cookies or CSRF tokens.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ApiClient,
  type ApiLanguage,
  type ApiProblem,
  type ApiSubmission,
  chooseLanguage,
  DEFAULT_BASE_URL,
  GraderClient,
  GraderError,
  isContestPage,
  parseListScores,
  Redactor,
  sanitizeHtml,
  sanitizeJson,
  summarize,
  type SubmissionResult,
  WebSession,
} from '../src/grader';
import { attachmentKind, planZip } from '../src/mapping/attachment';

interface Args {
  list: boolean;
  fixtures: boolean;
  attachment: boolean;
  problem?: number;
  submit?: string;
  language?: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { list: false, fixtures: false, attachment: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i] ?? die(`Missing value for ${k}`);
    if (k === '--list') a.list = true;
    else if (k === '--fixtures') a.fixtures = true;
    else if (k === '--attachment') a.attachment = true;
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
  if (a.attachment && a.problem === undefined) die('--attachment needs --problem <id>');
  return a;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function printResult(s: SubmissionResult): void {
  console.log(`  submission #${s.id} (attempt ${s.number ?? '?'})  status=${s.status}  state=${s.state}  points=${s.points ?? '-'}`);
  if (s.comment) console.log(`  comment: ${s.comment}`);
  if (s.verdicts.length) for (const v of s.verdicts.filter((x) => !x.ok)) console.log(`    ${v.label}  [${v.kind}]`);
  if (s.compileError) console.log(`  compiler message: ${(s.compilerMessage ?? '').split('\n').length} line(s)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const envPath = resolve('.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const username = process.env.GRADER_USER ?? '';
  const password = process.env.GRADER_PASS ?? '';
  const baseUrl = (process.env.GRADER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!username || !password) die('Set GRADER_USER and GRADER_PASS in .env');

  const log = (line: string) => console.log(`  http: ${line}`);
  const redactor = new Redactor();
  const api = new ApiClient(baseUrl, (i, init) => fetch(i, init), log, redactor);
  const fixtureDir = resolve('test/fixtures');
  const saved: string[] = [];
  let userId: number | null = null;
  let fullName = '';
  const personal = () => [username, fullName, ...fullName.split(/\s+/)].filter((s) => s.length >= 2);
  const saveJson = (name: string, data: unknown) => {
    if (!args.fixtures) return;
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(resolve(fixtureDir, name), JSON.stringify(sanitizeJson(data, { personal: personal(), userId }), null, 2) + '\n');
    saved.push(name);
  };
  const saveHtml = (name: string, html: string) => {
    if (!args.fixtures) return;
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(resolve(fixtureDir, name), sanitizeHtml(html, { personal: personal(), userId }));
    saved.push(name);
  };

  console.log(`Grader: ${baseUrl}`);

  // 1. API login.
  console.log('\n[1] API login (POST /api/v1/auth/login)');
  const login = await api.login(username, password);
  userId = login.user.id;
  fullName = login.user.full_name ?? '';
  console.log(`  ok. user id: ${String(userId).length} digits, token expires ${login.expires_at}`);

  // 2. /me
  console.log('\n[2] GET /api/v1/me');
  const me = await api.get<Record<string, unknown>>('/api/v1/me');
  console.log(`  fields: ${Object.keys(me).join(', ')}`);

  // 3. Problems.
  console.log('\n[3] GET /api/v1/problems');
  const problems = await api.get<ApiProblem[]>('/api/v1/problems');
  saveJson('api_problems.json', problems.slice(0, 15));
  console.log(`  ${problems.length} problems; fields: ${Object.keys(problems[0] ?? {}).join(', ')}`);
  for (const p of args.list ? problems : problems.slice(0, 5)) {
    console.log(`    #${p.id}  ${p.name}  best=${p.best_score ?? '-'} last=${p.last_score ?? '-'} n=${p.submission_count} testcases=${p.has_testcase} langs=${p.permitted_languages ? p.permitted_languages.map((l) => l.name).join('/') : 'all'}`);
  }
  if (!args.list && problems.length > 5) console.log('    … (use --list for all)');

  // 4. Languages.
  console.log('\n[4] GET /api/v1/languages');
  const langs = await api.get<ApiLanguage[]>('/api/v1/languages');
  saveJson('api_languages.json', langs);
  console.log(`  ${langs.map((l) => `${l.id}=${l.pretty_name}(${l.name}, .${l.ext})`).join('  ')}`);

  // 5. Web session + /main/list (penalties, exam hint).
  console.log('\n[5] Web login + GET /main/list (hint/AI penalties, raw-sum)');
  const web = new WebSession(baseUrl, undefined, log, redactor);
  let listScores: ReturnType<typeof parseListScores> | null = null;
  try {
    const html = await web.login(username, password);
    saveHtml('main_list.html', html);
    listScores = parseListScores(html);
    const withPenalty = [...listScores.values()].filter((x) => x.cost > 0).length;
    const rawSum = [...listScores.values()].filter((x) => x.rawSum).length;
    console.log(`  ${listScores.size} rows; with penalty: ${withPenalty}; raw-sum: ${rawSum}; isContestPage: ${isContestPage(html)}`);
  } catch (e) {
    console.log(`  web list unavailable: ${e instanceof Error ? e.message : e}`);
  }

  if (args.problem === undefined) return finish();
  const pid = args.problem;

  // 6. One problem.
  console.log(`\n[6] GET /api/v1/problems/${pid}`);
  const p = await api.get<ApiProblem>(`/api/v1/problems/${pid}`);
  saveJson('api_problem.json', p);
  const summary = summarize({
    bestScore: p.best_score,
    lastScore: p.last_score,
    submissionCount: p.submission_count,
    list: listScores?.get(pid) ?? null,
  });
  console.log(`  ${p.name} — ${p.full_name}; full_score=${p.full_score ?? '-'}; submissions=${p.submission_ids?.length ?? 0}`);
  console.log(`  counted=${summary.counted ?? '-'} best=${summary.best ?? '-'} latest=${summary.latest ?? '-'} penalty=${summary.penaltyLabel ?? 'none'} (${summary.source})`);

  console.log(`\n[7] GET /api/v1/problems/${pid}/submissions`);
  const subs = await api.get<unknown[]>(`/api/v1/problems/${pid}/submissions`);
  saveJson('api_submissions.json', subs.slice(0, 5));
  console.log(`  ${subs.length} submission(s)`);

  const lastId = p.submission_ids?.[0] ?? p.last_submission_id;
  if (lastId) {
    console.log(`\n[8] GET /api/v1/submissions/${lastId}`);
    const s = await api.get<ApiSubmission>(`/api/v1/submissions/${lastId}`);
    saveJson('api_submission.json', s);
    console.log(`  status=${s.status} points=${s.points ?? '-'} comment=${s.grader_comment ?? '-'} evaluations=${s.evaluations?.length ?? 0} compiler_message=${s.compiler_message ? `${s.compiler_message.length} chars` : 'none'}`);
  }

  console.log(`\n[9] GET /api/v1/problems/${pid}/testcases (Phase 3 import check)`);
  try {
    const tcs = await api.get<unknown[]>(`/api/v1/problems/${pid}/testcases`);
    saveJson('api_testcases.json', tcs.slice(0, 5));
    console.log(`  ${tcs.length} testcase(s) visible`);
  } catch (e) {
    console.log(`  not available: ${e instanceof Error ? e.message : e}`);
  }

  // Attachment (only with --attachment): headers and zip entry names, never the body.
  if (args.attachment) {
    console.log(`\n[9b] GET /api/v1/problems/${pid}/files/attachment (has_attachment=${p.has_attachment})`);
    const client = new GraderClient({ baseUrl, getStoredCredentials: async () => ({ username, password }), log });
    await client.login({ username, password });
    const a = await client.getAttachment(pid);
    if (a.status !== 200) console.log(`  ${a.status}: ${a.error ?? '-'}`);
    else {
      console.log(`  200 type=${a.contentType ?? '-'} filename=${a.filename ?? '-'} bytes=${a.bytes.length} kind=${attachmentKind(a.filename, a.contentType, a.bytes)}`);
      if (attachmentKind(a.filename, a.contentType, a.bytes) === 'zip') {
        try {
          const plan = planZip(a.bytes);
          console.log(`  zip: ${plan.files.length} file(s)${plan.topFolder ? ` (top folder "${plan.topFolder}" stripped)` : ''}: ${plan.files.map((f) => f.rel).join(', ')}`);
        } catch (e) {
          console.log(`  zip refused: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
  }

  // 10. Optional submit (through GraderClient, like the extension).
  if (args.submit) {
    console.log(`\n[10] Submit ${args.submit}`);
    const client = new GraderClient({
      baseUrl,
      getStoredCredentials: async () => ({ username, password }),
      log,
    });
    await client.login({ username, password });
    if (client.contestPage) console.log('  note: isContestPage = true (the extension would warn here)');
    const all = await client.languagesFor({ permittedLanguageIds: p.permitted_languages ? p.permitted_languages.map((l) => l.id) : null });
    let languageId = args.language;
    if (languageId === undefined) {
      const c = chooseLanguage(args.submit, all);
      if (c.kind === 'match') languageId = c.language.id;
      else die(`Cannot pick a language (${c.kind}); pass --language <id> from: ${all.map((l) => `${l.id}=${l.name}`).join(', ')}`);
    }
    console.log(`  language_id: ${languageId}`);
    const sub = await client.submit(pid, languageId, readFileSync(resolve(args.submit), 'utf8'), args.submit.split('/').pop()!);
    console.log(`  created #${sub.id} (attempt ${sub.number ?? '?'})`);
    const final = await client.pollSubmission(sub.id, { onUpdate: (s) => console.log(`  … ${s.status}`) });
    printResult(final);
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
