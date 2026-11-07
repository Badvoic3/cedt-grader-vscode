import { describe, expect, it } from 'vitest';
import { compileSet } from '../src/mapping/folderRoles';
import { detectRunnerLanguage, findOnPath, runnerLanguageOfName, Toolchains } from '../src/runner/languages';
import { runToEnd } from '../src/runner/process';
import { FakeProcessApi } from './fakeProcess';

describe('detectRunnerLanguage: extension', () => {
  it.each([
    ['a.cpp', 'cpp'], ['a.cc', 'cpp'], ['a.cxx', 'cpp'], ['a.hpp', 'cpp'], ['a.hh', 'cpp'], ['a.hxx', 'cpp'], ['A.CPP', 'cpp'],
    ['a.c', 'c'], ['a.py', 'python'], ['a.java', 'java'], ['a.js', 'javascript'], ['a.mjs', 'javascript'],
    ['a.rs', 'rust'], ['a.go', 'go'], ['a.php', 'php'], ['a.rb', 'ruby'], ['a.hs', 'haskell'],
  ])('%s → %s', (path, want) => expect(detectRunnerLanguage({ path })).toBe(want));

  it('an unknown extension with nothing else is null', () => expect(detectRunnerLanguage({ path: 'notes.txt' })).toBeNull());
});

describe('detectRunnerLanguage: .h', () => {
  const h = (o: object) => detectRunnerLanguage({ path: 'x.h', ...o });
  it('a .cpp neighbour → C++', () => expect(h({ siblings: ['main.cpp'] })).toBe('cpp'));
  it('a .c neighbour → C', () => expect(h({ siblings: ['main.c'], text: 'int f();' })).toBe('c'));
  it('both neighbours → the text decides', () => {
    expect(h({ siblings: ['a.c', 'b.cpp'], text: 'class A {};' })).toBe('cpp');
    expect(h({ siblings: ['a.c', 'b.cpp'], text: 'int f();' })).toBe('c');
  });
  it.each(['#include <iostream>', '#include <vector>', 'using namespace std;', 'namespace a {}', 'class X {};', 'template<class T>', 'std::cout'])('C++ text: %s', (text) => {
    expect(h({ text })).toBe('cpp');
  });
  it('a problem that permits only C → C', () => expect(h({ text: 'int f();', permitted: ['C'] })).toBe('c'));
  it('a problem that permits both stays C++', () => expect(h({ text: 'int f();', permitted: ['C', 'C++'] })).toBe('cpp'));
  it('nothing to go on → C++, like Submit', () => expect(h({})).toBe('cpp'));
});

describe('detectRunnerLanguage: fallbacks', () => {
  it('languageId for a file with no extension', () => {
    expect(detectRunnerLanguage({ path: 'solution', languageId: 'python' })).toBe('python');
    expect(detectRunnerLanguage({ path: 'solution', languageId: 'plaintext' })).toBeNull();
  });
  it.each([
    ['#!/usr/bin/env python3\nprint(1)', 'python'],
    ['#!/usr/bin/python3.12', 'python'],
    ['#!/usr/bin/env node', 'javascript'],
    ['#!/usr/bin/ruby', 'ruby'],
    ['#!/usr/bin/env php', 'php'],
  ])('shebang %j', (text, want) => expect(detectRunnerLanguage({ path: 'solution', text })).toBe(want));
  it('a shebang it does not know, and one not on line 1', () => {
    expect(detectRunnerLanguage({ path: 'solution', text: '#!/bin/sh' })).toBeNull();
    expect(detectRunnerLanguage({ path: 'solution', text: '\n#!/usr/bin/python3' })).toBeNull();
  });
  it('the extension beats languageId', () => expect(detectRunnerLanguage({ path: 'a.py', languageId: 'cpp' })).toBe('python'));
});

describe('detectRunnerLanguage: the Submit language', () => {
  it('settles C against C++', () => {
    expect(detectRunnerLanguage({ path: 'a.c', selected: 'C++' })).toBe('cpp');
    expect(detectRunnerLanguage({ path: 'x.h', selected: 'C', siblings: ['a.cpp'] })).toBe('c');
  });
  it('names a file with no known extension', () => expect(detectRunnerLanguage({ path: 'solution', selected: 'Python 3' })).toBe('python'));
  it('never overrides a clear extension', () => expect(detectRunnerLanguage({ path: 'a.py', selected: 'C++' })).toBe('python'));
  it('a language that can not run here changes nothing', () => expect(detectRunnerLanguage({ path: 'a.cpp', selected: 'Pascal' })).toBe('cpp'));
});

describe('detectRunnerLanguage: folder mode', () => {
  it('the caller passes the Runs file, so the header open in the editor does not matter', () => {
    expect(detectRunnerLanguage({ path: 'pkg/main.c' })).toBe('c');
  });
});

describe('runnerLanguageOfName', () => {
  it.each([
    ['C++', 'cpp'], ['cpp', 'cpp'], ['C++17', 'cpp'], ['C', 'c'], ['c', 'c'], ['Python 3', 'python'], ['python', 'python'],
    ['Java', 'java'], ['JavaScript', 'javascript'], ['Rust', 'rust'], ['Go', 'go'], ['PHP', 'php'], ['Ruby', 'ruby'], ['Haskell', 'haskell'],
  ])('%s', (name, want) => expect(runnerLanguageOfName(name)).toBe(want));
  it.each(['Pascal', 'PostgreSQL', 'Digital', 'C#'])('%s can not run here', (name) => expect(runnerLanguageOfName(name)).toBeNull());
});

describe('findOnPath', () => {
  const posix = (files: string[], path = '/usr/bin:/opt/bin') => ({ path, platform: 'darwin' as const, exists: (f: string) => files.includes(f) });
  it('takes the first match, as an absolute path', () => {
    expect(findOnPath('g++', posix(['/opt/bin/g++', '/usr/bin/g++']))).toBe('/usr/bin/g++');
  });
  it('skips relative PATH entries, so a workspace can not plant a compiler', () => {
    expect(findOnPath('g++', posix(['./g++', 'bin/g++', '/usr/bin/g++'], '.:bin::/usr/bin'))).toBe('/usr/bin/g++');
    expect(findOnPath('g++', posix(['./g++'], '.'))).toBeNull();
  });
  it('on Windows: `;`, `.exe` only, drive paths', () => {
    const l = { path: 'C:\\mingw\\bin\;.;D:\\x', platform: 'win32' as const, exists: (f: string) => f === 'C:\\mingw\\bin\\g++.exe' || f === '.\\g++.exe' };
    expect(findOnPath('g++', l)).toBe('C:\\mingw\\bin\\g++.exe');
    expect(findOnPath('node', { ...l, exists: (f: string) => f === 'D:\\x\\node.cmd' })).toBeNull();
  });
});

describe('Toolchains', () => {
  const lookup = (files: string[]) => () => ({ path: '/usr/bin', platform: 'linux' as const, exists: (f: string) => files.includes(f) });
  const replying = (reply: (command: string, args: readonly string[]) => { code?: number; stdout?: string; stderr?: string }) =>
    new FakeProcessApi((c) => {
      const r = reply(c.command, c.args);
      setImmediate(() => {
        if (r.stdout) c.child.stdout.write(r.stdout);
        if (r.stderr) c.child.stderr.write(r.stderr);
        c.child.finish(r.code ?? 0);
      });
    });

  it('finds the first working tool, with its version, once per session', async () => {
    const p = replying(() => ({ stdout: 'g++ 13.2\nmore' }));
    const t = new Toolchains(p, lookup(['/usr/bin/g++', '/usr/bin/clang++']));
    const [a, b] = await Promise.all([t.get('cpp'), t.get('cpp')]);
    expect(a).toEqual({ ok: true, tools: { compiler: { path: '/usr/bin/g++', args: [], version: 'g++ 13.2' } } });
    expect(b).toBe(a);
    expect(p.calls).toHaveLength(1);
    t.reset();
    await t.get('cpp');
    expect(p.calls).toHaveLength(2);
  });

  it('checks nothing until a language is needed', () => {
    const p = replying(() => ({}));
    new Toolchains(p, lookup(['/usr/bin/g++']));
    expect(p.calls).toHaveLength(0);
  });

  it('says what is missing', async () => {
    expect(await new Toolchains(replying(() => ({})), lookup([])).get('cpp')).toEqual({ ok: false, missing: 'g++ / clang++' });
  });

  it('a stub that exits with an error is not a tool (macOS java without a JDK)', async () => {
    const p = replying((cmd) => (cmd.endsWith('javac') ? { stdout: 'javac 21' } : { code: 1, stderr: 'Unable to locate a Java Runtime.' }));
    expect(await new Toolchains(p, lookup(['/usr/bin/java', '/usr/bin/javac'])).get('java')).toEqual({ ok: false, missing: 'java' });
  });

  it('java needs both tools, and reports on stderr', async () => {
    const p = replying((cmd) => ({ stderr: `${cmd.endsWith('javac') ? 'javac' : 'openjdk'} 21` }));
    const r = await new Toolchains(p, lookup(['/usr/bin/java', '/usr/bin/javac'])).get('java');
    expect(r).toMatchObject({ ok: true, tools: { compiler: { version: 'javac 21' }, runtime: { version: 'openjdk 21' } } });
    expect(p.calls[0].args).toEqual(['-version']);
  });

  it('python must be Python 3', async () => {
    const p = replying((cmd) => ({ stdout: cmd.endsWith('python3') ? 'Python 2.7.18' : 'Python 3.12.1' }));
    const r = await new Toolchains(p, lookup(['/usr/bin/python3', '/usr/bin/python'])).get('python');
    expect(r).toMatchObject({ ok: true, tools: { runtime: { path: '/usr/bin/python', version: 'Python 3.12.1' } } });
  });

  it('the Windows launcher keeps its -3', async () => {
    const p = replying(() => ({ stdout: 'Python 3.12.1' }));
    const r = await new Toolchains(p, () => ({ path: 'C:\\w', platform: 'win32', exists: (f) => f === 'C:\\w\\py.exe' })).get('python');
    expect(r).toMatchObject({ ok: true, tools: { runtime: { path: 'C:\\w\\py.exe', args: ['-3'] } } });
    expect(p.calls[0].args).toEqual(['-3', '--version']);
  });

  it('a path from the settings comes first', async () => {
    const p = replying(() => ({ stdout: 'custom' }));
    const r = await new Toolchains(p, lookup(['/usr/bin/g++']), () => ({ 'g++': '/my/g++' })).get('cpp');
    expect(r).toMatchObject({ ok: true, tools: { compiler: { path: '/my/g++' } } });
  });
});

describe('runToEnd', () => {
  it('kills the tree on timeout', async () => {
    const quiet = new FakeProcessApi(() => {});
    const r = await runToEnd(quiet, 'x', [], { timeoutMs: 5 });
    expect(r.timedOut).toBe(true);
    expect(quiet.kills).toHaveLength(1);
  });
  it('reports a tool that can not start', async () => {
    const p = new FakeProcessApi((c) => setImmediate(() => c.child.emit('error', Object.assign(new Error('x'), { code: 'EACCES' }))));
    expect((await runToEnd(p, 'x', [], { timeoutMs: 1000 })).spawnError?.code).toBe('EACCES');
  });
  it('keeps at most maxBytes and keeps reading', async () => {
    const p = new FakeProcessApi((c) => setImmediate(() => {
      c.child.stdout.write('a'.repeat(100));
      c.child.stdout.write('b'.repeat(100));
      setImmediate(() => c.child.finish(0));
    }));
    expect((await runToEnd(p, 'x', [], { timeoutMs: 1000, maxBytes: 150 })).stdout).toBe(`${'a'.repeat(100)}${'b'.repeat(50)}`);
  });
  it('stops on abort', async () => {
    const quiet = new FakeProcessApi(() => {});
    const ac = new AbortController();
    const r = runToEnd(quiet, 'x', [], { timeoutMs: 10_000, signal: ac.signal });
    ac.abort();
    expect((await r).signal).toBe('SIGKILL');
  });
});

describe('compileSet', () => {
  const T = (o: Record<string, string>) => new Map(Object.entries(o));
  it('the run file first, then every other .cpp', () => {
    expect(compileSet(['main.cpp', 'b.cpp', 'a.cpp', 'student.h'], T({ 'main.cpp': 'int main() {}', 'a.cpp': 'int a;', 'b.cpp': 'int b;' }), 'main.cpp')).toEqual({ sources: ['main.cpp', 'a.cpp', 'b.cpp'], leftOut: [] });
  });
  it('leaves out other files with main(), and says so', () => {
    expect(compileSet(['main.cpp', 'gen.cpp', 'util.cpp'], T({ 'main.cpp': 'int main() {}', 'gen.cpp': 'int main() {}', 'util.cpp': 'int u;' }), 'main.cpp')).toEqual({ sources: ['main.cpp', 'util.cpp'], leftOut: ['gen.cpp'] });
  });
  it('a chosen run file swaps which main is the program', () => {
    const t = T({ 'main.cpp': 'int main() {}', 'main2.cpp': 'int main() {}' });
    expect(compileSet(['main.cpp', 'main2.cpp'], t, 'main2.cpp')).toEqual({ sources: ['main2.cpp'], leftOut: ['main.cpp'] });
  });
  it('goes into subfolders, like the grader', () => {
    expect(compileSet(['main.cpp', 'lib/x.cpp'], T({ 'lib/x.cpp': '' }), 'main.cpp').sources).toEqual(['main.cpp', 'lib/x.cpp']);
  });
  it('C: the .c files; .cpp files stay out of a C program', () => {
    expect(compileSet(['main.c', 'a.c', 'b.cpp'], T({ 'main.c': 'int main() {}', 'a.c': '' }), 'main.c').sources).toEqual(['main.c', 'a.c']);
  });
  it('a main() in a comment does not count', () => {
    expect(compileSet(['main.cpp', 'a.cpp'], T({ 'a.cpp': '// int main() {}\nint a;' }), 'main.cpp').leftOut).toEqual([]);
  });
});
