import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Builder } from '../src/runner/compile';
import { execCase, runCases } from '../src/runner/execute';
import { type RunnerLanguage, Toolchains } from '../src/runner/languages';
import { nodeProcessApi } from '../src/runner/process';
import type { CaseRun, RunLimits, RunnerCase } from '../src/runner/types';

// Tiny real programs on whatever tools this machine has. A missing tool skips
// its test, so CI on Ubuntu and Windows covers what this computer can't.
const lookup = () => ({ path: process.env.PATH ?? '', platform: process.platform, exists: existsSync });
const tools = new Toolchains(nodeProcessApi, lookup);
const limits: RunLimits = { timeMs: 5000, memoryMB: 1024, source: 'default' };
const onCase = (input: string, expected: string): RunnerCase => ({ id: 'c', source: 'custom', input, expected });

let dir: string;
let builder: Builder;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'runner-real-'));
  builder = new Builder(nodeProcessApi, { platform: process.platform, root: join(dir, 'bin'), fallbackRoot: join(dir, 'fb') });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function build(language: RunnerLanguage, name: string, text: string, more: Record<string, string> = {}, sub = 'src') {
  const r = await tools.get(language);
  if (!r.ok) return null;
  const folder = await mkdtemp(join(dir, `${sub}-`));
  const main = join(folder, name);
  await writeFile(main, text);
  for (const [f, t] of Object.entries(more)) await writeFile(join(folder, f), t);
  const out = await builder.build({ language, folder, sources: [main], tools: r.tools });
  return { out, folder };
}

async function run(program: { command: string; args: string[]; fresh: boolean }, cases: RunnerCase[], l = limits, signal = new AbortController().signal) {
  const updates: CaseRun[] = [];
  await runCases({ proc: nodeProcessApi, cases, program, limits: l, scratchRoot: dir, env: { ...process.env, PYTHONUTF8: '1' }, platform: process.platform, signal, onUpdate: (u) => updates.push(u) });
  return updates.filter((u) => u.state === 'done' || u.state === 'stopped');
}

const CAT = {
  cpp: ['a.cpp', '#include <iostream>\n#include <string>\nint main(){std::string s;std::cin>>s;std::cout<<s<<"\\n";}\n'],
  c: ['a.c', '#include <stdio.h>\nint main(void){char s[99];scanf("%98s",s);printf("%s\\n",s);return 0;}\n'],
  python: ['a.py', 'print(input())\n'],
  java: ['Main.java', 'import java.util.*;\npublic class Main { public static void main(String[] a) { System.out.println(new Scanner(System.in).next()); } }\n'],
  javascript: ['a.js', 'console.log(require("fs").readFileSync(0,"utf8").trim());\n'],
  rust: ['a.rs', 'use std::io;\nfn main(){let mut s=String::new();io::stdin().read_line(&mut s).unwrap();println!("{}",s.trim());}\n'],
  go: ['a.go', 'package main\nimport "fmt"\nfunc main(){var s string;fmt.Scan(&s);fmt.Println(s)}\n'],
  php: ['a.php', '<?php echo trim(fgets(STDIN)), "\\n";\n'],
  ruby: ['a.rb', 'puts gets\n'],
  haskell: ['a.hs', 'main :: IO ()\nmain = getLine >>= putStrLn\n'],
} as const;

describe('real programs', { timeout: 240_000 }, () => {
  it.each(Object.keys(CAT) as (keyof typeof CAT)[])('%s runs a case to AC and a wrong one to WA', async (language) => {
    const [name, text] = CAT[language];
    const b = await build(language, name, text);
    if (!b) return;
    // The compiler's own words, when it fails on a CI image.
    expect(b.out.ok ? '' : b.out.failure?.message).toBe('');
    if (!b.out.ok) return;
    const [ok, wrong] = await run(b.out.program, [onCase('สวัสดี\n', 'สวัสดี'), { ...onCase('a\n', 'b'), id: 'd' }]);
    expect([ok.verdict, wrong.verdict]).toEqual(['AC', 'WA']);
    expect(ok.actual?.text.trim()).toBe('สวัสดี');
    if (process.platform === 'win32') expect(ok.memoryKB).toBeNull();
  });

  it('C++: -DEVAL is on, ONLINE_JUDGE is off, gnu++17 is on', async () => {
    const b = await build('cpp', 'a.cpp', '#include <cstdio>\nint main(){\n#ifdef EVAL\nputs("eval");\n#endif\n#ifdef ONLINE_JUDGE\nputs("oj");\n#endif\nprintf("%ld\\n",__cplusplus);}\n');
    if (!b?.out.ok) return;
    expect((await run(b.out.program, [onCase('', 'eval\n201703')]))[0].verdict).toBe('AC');
  });

  it('a package: main.cpp with student.h and a folder with spaces and Thai in its name', async () => {
    const b = await build('cpp', 'main.cpp', '#include "student.h"\n#include <cstdio>\nint main(){printf("%d\\n",f());}\n', { 'student.h': 'int f(){return 42;}\n' }, 'โฟลเดอร์ มีช่อง');
    if (!b) return;
    expect(b.out).toMatchObject({ ok: true });
    if (b.out.ok) expect((await run(b.out.program, [onCase('', '42')]))[0].verdict).toBe('AC');
    expect((await readdir(b.folder)).sort()).toEqual(['main.cpp', 'student.h']);
  });

  it('a compile error is reported with its place', async () => {
    const b = await build('cpp', 'a.cpp', 'int main(){\n  return x\n}\n');
    if (!b) return;
    expect(b.out).toMatchObject({ ok: false, failure: { line: 2 } });
  });

  it('a crash is RE, a non-zero exit is RE, stderr alone is AC', async () => {
    const b = await build('cpp', 'a.cpp', '#include <cstdio>\n#include <cstdlib>\nint main(){int n;scanf("%d",&n);fputs("debug\\n",stderr);puts("1");if(n==1)return 3;if(n==2)abort();}\n');
    if (!b?.out.ok) return;
    const [plain] = await run(b.out.program, [onCase('0', '1')]);
    const [exit] = await run(b.out.program, [onCase('1', '1')]);
    const [crash] = await run(b.out.program, [onCase('2', '1')]);
    expect([plain.verdict, exit.verdict, crash.verdict]).toEqual(['AC', 'RE', 'RE']);
    expect(plain.stderr?.text.trim()).toBe('debug');
    expect(crash.stderr?.text).not.toContain('terminated abnormally');
  });

  it('deep recursion that the grader allows does not crash here', async () => {
    const b = await build('cpp', 'a.cpp', '#include <cstdio>\nint f(int n){volatile char b[1024];b[0]=n;return n?f(n-1)+b[0]*0+1:0;}\nint main(){printf("%d\\n",f(200000));}\n');
    if (!b?.out.ok) return;
    expect((await run(b.out.program, [onCase('', '200000')]))[0].verdict).toBe('AC');
  });

  it('an endless loop is TLE, and a child it started dies with it', async () => {
    if (process.platform === 'win32') return;
    const b = await build('python', 'a.py', 'import subprocess,sys,time\nsubprocess.Popen(["sleep","30"])\nprint("started",flush=True)\ntime.sleep(30)\n');
    if (!b?.out.ok) return;
    const t = Date.now();
    const [r] = await run(b.out.program, [onCase('', 'x')], { ...limits, timeMs: 300 });
    expect(r.verdict).toBe('TLE');
    expect(Date.now() - t).toBeLessThan(5000); // the sleeping child doesn't hold the pipes
  });

  it('endless output is cut, killed and reported, with memory staying small', async () => {
    const b = await build('cpp', 'a.cpp', '#include <cstdio>\nint main(){for(;;)puts("yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy");}\n');
    if (!b?.out.ok) return;
    const [r] = await run(b.out.program, [onCase('', 'y')]);
    expect(r.verdict).toBe('OLE');
    expect(r.actual?.text.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('Stop ends a running program', async () => {
    const b = await build('cpp', 'a.cpp', 'int main(){for(;;);}\n');
    if (!b?.out.ok) return;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    expect((await run(b.out.program, [onCase('', 'x')], limits, ac.signal))[0].state).toBe('stopped');
  });

  it('peak memory is a real figure on macOS and Linux', async () => {
    if (process.platform === 'win32') return;
    const b = await build('cpp', 'a.cpp', '#include <cstdlib>\n#include <unistd.h>\nint main(){volatile char*p=(volatile char*)malloc(64<<20);for(long i=0;i<(64<<20);i+=4096)p[i]=1;usleep(1200000);return 0;}\n');
    if (!b?.out.ok) return;
    const [r] = await run(b.out.program, [onCase('', '')]);
    expect(r.memoryKB).toBeGreaterThan(60_000);
    const [over] = await run(b.out.program, [onCase('', '')], { ...limits, memoryMB: 16 });
    expect(over.verdict).toBe('MLE');
  });

  it('a program that writes files writes them in its temp folder', async () => {
    const b = await build('python', 'a.py', 'open("out.txt","w").write("x")\nprint("ok")\n');
    if (!b?.out.ok) return;
    expect((await run(b.out.program, [onCase('', 'ok')]))[0].verdict).toBe('AC');
    expect(await readdir(b.folder)).toEqual(['a.py']);
  });

  it('execCase can be used with no meter', async () => {
    const r = await execCase(nodeProcessApi, { command: process.execPath, args: ['-e', 'console.log(1)'], input: '', expectedBytes: 1, limits, cwd: dir, env: process.env });
    expect(r).toMatchObject({ exitCode: 0, fullStdout: '1\n' });
  });

  it('nothing is left in the scratch folder', async () => {
    await mkdir(join(dir, 'x'), { recursive: true });
    expect((await readdir(dir)).filter((n) => n.startsWith('cedt-grader-run-'))).toEqual([]);
  });
});
