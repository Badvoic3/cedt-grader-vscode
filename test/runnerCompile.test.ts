import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Builder, compileCommand, compileLimitMs, javaMainClass, localFiles, needsStaging, parseCompileError, runCommand } from '../src/runner/compile';
import type { Toolset } from '../src/runner/languages';
import { S } from '../src/shared/strings';
import { type FakeCall, FakeProcessApi } from './fakeProcess';

/** Built with the system's separator, as the code builds it. */
const PROG = join('/out', 'prog');
const tool = (path: string) => ({ path, args: [], version: 'v1' });
const cc: Toolset = { compiler: tool('/usr/bin/g++') };
const input = (o = {}) => ({ language: 'cpp' as const, folder: '/pkg', sources: ['/pkg/main.cpp', '/pkg/a.cpp'], tools: cc, outDir: '/out', platform: 'linux' as const, ...o });

describe('compileCommand', () => {
  it('C++ matches the grader, and every source is an argument', () => {
    const c = compileCommand(input())!;
    expect(c.command).toBe('/usr/bin/g++');
    expect(c.args).toEqual(['-o', PROG, '-iquote', '/pkg', '-DEVAL', '-std=gnu++17', '-O2', '-pipe', '-Wall', '-Wextra', '-fdiagnostics-color=never', '/pkg/main.cpp', '/pkg/a.cpp']);
  });
  it('never defines ONLINE_JUDGE', () => expect(compileCommand(input())!.args.join(' ')).not.toContain('ONLINE_JUDGE'));
  it('C uses gnu17', () => expect(compileCommand(input({ language: 'c' }))!.args).toContain('-std=gnu17'));
  it('macOS: a large stack, never -static', () => {
    const a = compileCommand(input({ platform: 'darwin' }))!.args;
    expect(a).toContain('-Wl,-stack_size,0x20000000');
    expect(a).not.toContain('-static');
  });
  it('Windows: static, with a large stack and .exe', () => {
    const a = compileCommand(input({ platform: 'win32' }))!.args;
    expect(a).toEqual(expect.arrayContaining(['-static', '-Wl,--stack,536870912']));
    expect(a[1]).toMatch(/prog\.exe$/);
  });
  it('a header as the program compiles as source', () => {
    expect(compileCommand(input({ sources: ['/pkg/x.h'] }))!.args.slice(-3)).toEqual(['-x', 'c++', '/pkg/x.h']);
  });
  it('extra arguments come before the sources', () => {
    const a = compileCommand(input({ extraArgs: ['-fsanitize=address'] }))!.args;
    expect(a.indexOf('-fsanitize=address')).toBeLessThan(a.indexOf('/pkg/main.cpp'));
  });
  it('the other compiled languages', () => {
    expect(compileCommand(input({ language: 'java', sources: ['/p/A.java'], tools: { compiler: tool('javac'), runtime: tool('java') } }))!.args).toEqual(['-encoding', 'UTF-8', '-d', '/out', '/p/A.java']);
    expect(compileCommand(input({ language: 'rust', sources: ['/p/a.rs'], tools: { compiler: tool('rustc') } }))!.args).toEqual(['-O', '-o', PROG, '/p/a.rs']);
    expect(compileCommand(input({ language: 'go', sources: ['/p/a.go'], tools: { compiler: tool('go') } }))!.args).toEqual(['build', '-o', PROG, '/p/a.go']);
    expect(compileCommand(input({ language: 'haskell', sources: ['/p/a.hs'], tools: { compiler: tool('ghc') } }))!.args).toEqual(['-O2', '-outputdir', '/out', '-o', PROG, '/p/a.hs']);
  });
  it('no compile step for an interpreted language', () => {
    expect(compileCommand(input({ language: 'python', tools: { runtime: tool('python3') } }))).toBeNull();
  });
});

describe('compileLimitMs', () => {
  it('60 s, and longer for GHC, which can pass that on a slow Windows machine', () => {
    expect(compileLimitMs('cpp')).toBe(60_000);
    expect(compileLimitMs('rust')).toBe(60_000);
    expect(compileLimitMs('haskell')).toBe(180_000);
    expect(S.runner.compileTimedOut(180)).toBe('Compiling took over 180 seconds and was stopped.');
  });
});

describe('runCommand', () => {
  it('Linux raises the stack, with the path passed as an argument and never as shell text', () => {
    expect(runCommand(input({ outDir: "/o'; rm -rf x" }))).toEqual({ command: '/bin/sh', args: ['-c', 'ulimit -s unlimited 2>/dev/null; exec "$0"', join("/o'; rm -rf x", 'prog')] });
  });
  it('macOS runs the binary', () => expect(runCommand(input({ platform: 'darwin' }))).toEqual({ command: PROG, args: [] }));
  it('interpreted: the runtime and the source, with its fixed arguments', () => {
    expect(runCommand(input({ language: 'python', sources: ['/p/a.py'], tools: { runtime: { ...tool('py'), args: ['-3'] } } }))).toEqual({ command: 'py', args: ['-3', '/p/a.py'] });
  });
  it('Java starts the class with main', () => {
    const r = runCommand(input({ language: 'java', sources: ['/p/Main.java'], tools: { compiler: tool('javac'), runtime: tool('java') } }), 'class Helper {}\npublic class Solver { public static void main(String[] a) {} }');
    expect(r.args.slice(-3)).toEqual(['-cp', '/out', 'Solver']);
  });
});

describe('javaMainClass', () => {
  it('the class before main, with its package', () => {
    expect(javaMainClass('package a.b;\nclass X { static void main(String[] v) {} }', 'F')).toBe('a.b.X');
  });
  it('the file name when there is no main', () => expect(javaMainClass('class X {}', 'Main')).toBe('Main'));
  it('ignores comments', () => expect(javaMainClass('// class Y\nclass X { public static void main(String[] a){} } ', 'F')).toBe('X'));
});

describe('parseCompileError', () => {
  it.each([
    ['g++', '/a/main.cpp:7:3: error: expected ;', '/a/main.cpp', 7],
    ['fatal', 'x.cpp:1:10: fatal error: y.h: No such file', 'x.cpp', 1],
    ['Windows path', 'C:\\Users\\me\\a.cpp:12:3: error: no', 'C:\\Users\\me\\a.cpp', 12],
    ['an error in the header', 'In file included from main.cpp:2:\nstudent.h:5:1: error: oops', 'student.h', 5],
    ['javac', 'Main.java:3: error: ; expected', 'Main.java', 3],
    ['rustc', 'error[E0425]: nope\n --> a.rs:2:5\n', 'a.rs', 2],
    ['go', '# command-line-arguments\na.go:3:5: undefined: x', 'a.go', 3],
    ['ghc', 'a.hs:3:5: error: [GHC-88464]', 'a.hs', 3],
    ['colour codes', '\u001b[1ma.cpp:2:1: \u001b[31merror: \u001b[0mx', 'a.cpp', 2],
  ])('%s', (_, text, file, line) => expect(parseCompileError(text)).toEqual({ file, line }));
  it('a linker error has no place', () => expect(parseCompileError('ld: symbol(s) not found')).toEqual({ file: null, line: null }));
  it('a warning is not the error', () => {
    expect(parseCompileError('a.cpp:1:1: warning: w\na.cpp:9:1: error: e')).toEqual({ file: 'a.cpp', line: 9 });
  });
});

describe('localFiles', () => {
  /** Windows spells these `C:\\p\\main.cpp`. */
  const posix = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
  const read = (o: Record<string, string>) => async (p: string) => o[posix(p)] ?? null;
  it('follows includes, relative to the includer then the folder, and survives a cycle', async () => {
    const m = await localFiles(['/p/main.cpp'], '/p', read({
      '/p/main.cpp': '#include "lib/a.h"\n#include <vector>',
      '/p/lib/a.h': '#include "b.h"\n#include "root.h"',
      '/p/lib/b.h': '#include "a.h"',
      '/p/root.h': '',
    }));
    expect([...m.keys()].map(posix).sort()).toEqual(['/p/lib/a.h', '/p/lib/b.h', '/p/main.cpp', '/p/root.h']);
  });
});

describe('needsStaging', () => {
  it('only Windows, only a non-ASCII path', () => {
    expect(needsStaging(['C:\\ผู้ใช้\\a.cpp'], 'win32')).toBe(true);
    expect(needsStaging(['C:\\a b\\a.cpp'], 'win32')).toBe(false);
    expect(needsStaging(['/home/ผู้ใช้/a.cpp'], 'linux')).toBe(false);
  });
});

describe('Builder', () => {
  let dir: string;
  let main: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runner-build-'));
    main = join(dir, 'pkg', 'main.cpp');
    await mkdir(join(dir, 'pkg'));
    await writeFile(main, '#include "student.h"\nint main() {}\n');
    await writeFile(join(dir, 'pkg', 'student.h'), 'int a;\n');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  /** A compiler that writes the file `-o` names. */
  const compiler = (reply: (c: FakeCall) => void = (c) => setImmediate(() => c.child.finish(0))) => new FakeProcessApi((c) => {
    const out = c.args[c.args.indexOf('-o') + 1];
    void writeFile(out, 'binary').then(() => reply(c));
  });
  const make = (p: FakeProcessApi, platform: NodeJS.Platform = 'linux') => new Builder(p, { platform, root: join(dir, 'bin'), fallbackRoot: join(dir, 'store', 'bin'), env: {} });
  const job = (o = {}) => ({ language: 'cpp' as const, folder: join(dir, 'pkg'), sources: [main], tools: cc, ...o });

  it('compiles once; the same sources reuse the build', async () => {
    const p = compiler();
    const b = make(p);
    expect(await b.build(job())).toMatchObject({ ok: true, program: { fresh: true } });
    expect(await b.build(job())).toMatchObject({ ok: true, program: { fresh: false } });
    expect(p.calls).toHaveLength(1);
  });

  it('writes nothing next to the sources', async () => {
    await make(compiler()).build(job());
    expect((await readdir(join(dir, 'pkg'))).sort()).toEqual(['main.cpp', 'student.h']);
  });

  it('a changed header, flag or compiler compiles again', async () => {
    const p = compiler();
    const b = make(p);
    await b.build(job());
    await writeFile(join(dir, 'pkg', 'student.h'), 'int b;\n');
    await b.build(job());
    await b.build(job({ extraArgs: ['-g'] }));
    await b.build(job({ tools: { compiler: { ...tool('/usr/bin/g++'), version: 'v2' } } }));
    expect(p.calls).toHaveLength(4);
  });

  it('sets English compiler messages on POSIX', async () => {
    const p = compiler();
    await make(p).build(job());
    expect(p.calls[0].options.env?.LC_ALL).toBe('C');
    expect(p.calls[0].options.cwd).toBe(join(dir, 'pkg'));
  });

  it('a compile error gives the text and place, and keeps no build', async () => {
    const p = compiler((c) => setImmediate(() => {
      c.child.stderr.write('main.cpp:2:1: error: nope\n');
      setImmediate(() => c.child.finish(1));
    }));
    const b = make(p);
    expect(await b.build(job())).toEqual({ ok: false, failure: { message: 'main.cpp:2:1: error: nope', file: 'main.cpp', line: 2 } });
    expect(await readdir(join(dir, 'bin'))).toEqual([]);
  });

  it('keeps warnings on success', async () => {
    const p = compiler((c) => setImmediate(() => {
      c.child.stderr.write('a.cpp:1:1: warning: unused\n');
      setImmediate(() => c.child.finish(0));
    }));
    expect(await make(p).build(job())).toMatchObject({ ok: true, program: { warnings: 'a.cpp:1:1: warning: unused' } });
  });

  it('explains bits/stdc++.h on Apple clang', async () => {
    const p = compiler((c) => setImmediate(() => {
      c.child.stderr.write("main.cpp:1:10: fatal error: 'bits/stdc++.h' file not found\n");
      setImmediate(() => c.child.finish(1));
    }));
    expect(await make(p).build(job())).toMatchObject({ ok: false, failure: { hint: S.runner.bitsStdc, line: 1 } });
  });

  it('Stop during a compile is no failure', async () => {
    const ac = new AbortController();
    const p = compiler(() => ac.abort());
    expect(await make(p).build(job({ signal: ac.signal }))).toEqual({ ok: false, failure: null });
  });

  it('a compiler that can not start says why', async () => {
    const p = new FakeProcessApi((c) => setImmediate(() => c.child.emit('error', new Error('spawn EACCES'))));
    expect(await make(p).build(job())).toMatchObject({ ok: false, failure: { message: S.runner.compilerFailed('spawn EACCES') } });
  });

  it('the noexec fallback builds in the other folder, once', async () => {
    const p = compiler();
    const b = make(p);
    await b.build(job());
    expect(b.useFallback()).toBe(true);
    expect(await b.build(job())).toMatchObject({ program: { fresh: true } });
    expect(p.calls[1].args[p.calls[1].args.indexOf('-o') + 1].startsWith(join(dir, 'store', 'bin'))).toBe(true);
    expect(b.useFallback()).toBe(false);
  });

  it('an interpreted language starts straight from the source', async () => {
    const p = new FakeProcessApi();
    const r = await make(p).build(job({ language: 'python', sources: [main], tools: { runtime: tool('/usr/bin/python3') } }));
    expect(r).toEqual({ ok: true, program: { command: '/usr/bin/python3', args: [main], fresh: false, warnings: '' } });
    expect(p.calls).toHaveLength(0);
  });

  it('Windows with a Thai path compiles a staged copy, keeping the layout', async () => {
    const thai = join(dir, 'โฟลเดอร์');
    await mkdir(join(thai, 'lib'), { recursive: true });
    const m = join(thai, 'main.cpp');
    await writeFile(m, '#include "lib/a.h"\nint main() {}\n');
    await writeFile(join(thai, 'lib', 'a.h'), 'int a;\n');
    let seen: string[] = [];
    const p = compiler((c) => {
      void readdir(String(c.options.cwd), { recursive: true }).then((f) => {
        seen = f.map(String).sort();
        c.child.finish(0);
      });
    });
    await make(p, 'win32').build(job({ folder: thai, sources: [m] }));
    expect(seen).toEqual(['lib', join('lib', 'a.h'), 'main.cpp']);
    expect(p.calls[0].args.at(-1)).not.toContain('โฟลเดอร์');
  });
});
