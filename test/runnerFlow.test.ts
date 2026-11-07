import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const v = vi.hoisted(() => ({
  isTrusted: true,
  textDocuments: [] as { uri: { fsPath: string; toString(): string }; isDirty: boolean; isUntitled: boolean; languageId: string; save: () => Promise<boolean> }[],
}));

vi.mock('vscode', () => ({
  workspace: {
    get isTrusted() { return v.isTrusted; },
    get textDocuments() { return v.textDocuments; },
  },
}));

import type { Host } from '../src/flows/host';
import { ownerKey, Runner } from '../src/flows/runner';
import { allPassed, emptyState, summarize } from '../src/runner/state';
import { CaseStore } from '../src/runner/store';
import { S } from '../src/shared/strings';
import { type FakeCall, FakeProcessApi } from './fakeProcess';

/** Echoes stdin, like a program that prints its input; the compiler "succeeds". */
function programs(o: { compile?: (c: FakeCall) => void; run?: (c: FakeCall) => void } = {}) {
  return new FakeProcessApi((c) => {
    if (c.args.includes('--version') || c.args.includes('-version')) {
      setImmediate(() => {
        c.child.stdout.write('tool 1.0\n');
        setImmediate(() => c.child.finish(0));
      });
    } else if (c.args.includes('-iquote') || c.args.includes('-d')) {
      if (o.compile) return o.compile(c);
      const out = c.args[c.args.indexOf('-o') + 1];
      void writeFile(out, 'bin').then(() => c.child.finish(0));
    } else if (o.run) o.run(c);
    else {
      c.child.stdin.on('data', (d) => c.child.stdout.write(d));
      c.child.stdin.on('end', () => setImmediate(() => c.child.finish(0)));
    }
  });
}
const compiles = (p: FakeProcessApi) => p.calls.filter((c) => c.args.includes('-iquote'));

describe('Runner', () => {
  let dir: string;
  let file: string;
  let store: CaseStore;
  let told: string[];
  let emits: number;
  let h: Record<string, unknown> & { problem: { id: number } | null; folder: Record<string, unknown> };
  const P = { problemId: 7 };
  let limitsFromGrader: ReturnType<typeof vi.fn>;

  const uri = (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` });
  const make = (p: FakeProcessApi) => new Runner(h as unknown as Host, p);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runner-flow-'));
    file = join(dir, 'a.cpp');
    await writeFile(file, 'int main() {}\n');
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'bin', 'g++'), '');
    process.env.PATH = `${join(dir, 'bin')}:${process.env.PATH}`;
    store = new CaseStore(join(dir, 'storage'), () => 'https://g.example');
    told = [];
    emits = 0;
    limitsFromGrader = vi.fn(async () => null);
    v.isTrusted = true;
    v.textDocuments = [];
    h = {
      ctx: { globalStorageUri: { fsPath: join(dir, 'storage') } },
      cfg: { runnerDefaultTimeSeconds: 5, runnerDefaultMemoryMB: 256, runnerCompilerPaths: { 'g++': join(dir, 'bin', 'g++') }, runnerExtraCompileArgs: {} },
      cases: store,
      data: { limits: limitsFromGrader },
      problem: { id: 7 },
      fileUri: uri(file),
      languages: [],
      selectedLanguageId: null,
      currentProblem: () => h.problem,
      allowedLanguages: () => [],
      folder: { link: null, runUri: () => uri(file), askRole: async () => 'main.cpp', compileFiles: async () => null },
      emit: () => void emits++,
      tellInline: async (_: unknown, msg: string) => void told.push(msg),
      describe: (e: unknown) => String(e),
    };
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('runs the list and keeps the results in memory', async () => {
    await store.add(P, { input: 'x', expected: 'x' });
    await store.add(P, { input: 'y', expected: 'z' });
    const r = make(programs());
    await r.onActiveFile();
    expect(r.summary()).toEqual({ kind: 'not-run' });
    expect(await r.run()).toEqual({ kind: 'done', passed: 1, total: 2 });
    expect(r.summary()).toEqual({ kind: 'done', passed: 1, total: 2 });
    expect(r.running).toBe(false);
  });

  it('one case runs alone, and a second run compiles nothing', async () => {
    const list = await store.add(P, { input: 'x', expected: 'x' });
    const p = programs();
    const r = make(p);
    await r.run();
    await r.run([list.cases[0].id]);
    expect(compiles(p)).toHaveLength(1);
  });

  it('an unlinked file runs its own list with the default limits', async () => {
    h.problem = null;
    await store.add({ file }, { input: 'x', expected: 'x' });
    const r = make(programs());
    await r.onActiveFile();
    expect(await r.run()).toEqual({ kind: 'done', passed: 1, total: 1 });
    expect(r.owner()).toEqual({ file });
  });

  it('linking a file carries its cases to the problem', async () => {
    await store.add({ file }, { input: 'mine', expected: 'x' });
    await make(programs()).onActiveFile();
    expect((await store.read(P)).cases.map((c) => c.input)).toEqual(['mine']);
    expect((await store.read({ file })).cases).toEqual([]);
  });

  it('a suggestion is only a guess: the cases wait', async () => {
    h.problem = { id: 7, source: 'suggested' } as never;
    await store.add({ file }, { input: 'mine', expected: 'x' });
    await make(programs()).onActiveFile();
    expect((await store.read(P)).cases).toEqual([]);
    expect((await store.read({ file })).cases).toHaveLength(1);
  });

  it('a renamed unlinked file keeps its cases, also when its folder moved', async () => {
    h.problem = null;
    await store.add({ file }, { input: 'mine', expected: 'x' });
    const r = make(programs());
    await r.onMoved(file, join(dir, 'b.cpp'));
    expect((await store.read({ file: join(dir, 'b.cpp') })).cases).toHaveLength(1);
    await r.onMoved(dir, `${dir}-moved`);
    expect((await store.read({ file: join(`${dir}-moved`, 'b.cpp') })).cases).toHaveLength(1);
  });

  it('nothing runs in an untrusted workspace', async () => {
    v.isTrusted = false;
    await store.add(P, { input: 'x', expected: 'x' });
    const p = programs();
    expect(await make(p).run()).toBeNull();
    expect(told).toEqual([S.runner.untrusted]);
    expect(p.calls).toHaveLength(0);
  });

  it('no cases: nothing starts', async () => {
    const p = programs();
    expect(await make(p).run()).toBeNull();
    expect(p.calls).toHaveLength(0);
  });

  it('a file with no known language says so', async () => {
    (h.folder as { runUri: () => unknown }).runUri = () => uri(join(dir, 'notes.xyz'));
    await store.add(P, { input: 'x', expected: 'x' });
    expect(await make(programs()).run()).toBeNull();
    expect(told).toEqual([S.runner.noLanguage]);
  });

  it('a missing compiler is a compile error with a clear text, and the run state ends', async () => {
    (h.cfg as { runnerCompilerPaths: object }).runnerCompilerPaths = {};
    const old = process.env.PATH;
    process.env.PATH = '/nowhere';
    await store.add(P, { input: 'x', expected: 'x' });
    const r = make(programs());
    await r.onActiveFile();
    expect(await r.run()).toEqual({ kind: 'compile-error' });
    process.env.PATH = old;
    expect(r.running).toBe(false);
  });

  it('a compile error ends the run with nothing run', async () => {
    await store.add(P, { input: 'x', expected: 'x' });
    const p = programs({ compile: (c) => setImmediate(() => {
      c.child.stderr.write('a.cpp:1:1: error: no\n');
      setImmediate(() => c.child.finish(1));
    }) });
    const r = make(p);
    expect(await r.run()).toEqual({ kind: 'compile-error' });
    expect(p.calls.filter((c) => c.command.endsWith('prog'))).toHaveLength(0);
    expect(r.running).toBe(false);
  });

  it('a later good run clears the compile error', async () => {
    await store.add(P, { input: 'x', expected: 'x' });
    let bad = true;
    const p = programs({ compile: (c) => {
      if (bad) return setImmediate(() => c.child.finish(1));
      void writeFile(c.args[c.args.indexOf('-o') + 1], 'bin').then(() => c.child.finish(0));
    } });
    const r = make(p);
    await r.run();
    bad = false;
    expect(await r.run()).toEqual({ kind: 'done', passed: 1, total: 1 });
  });

  it('Stop during a run ends it, and every case has a final state', async () => {
    await store.add(P, { input: 'x', expected: 'x' });
    await store.add(P, { input: 'y', expected: 'y' });
    const r = make(programs({ run: () => setImmediate(() => r.stop()) }));
    await r.onActiveFile();
    expect(await r.run()).toEqual({ kind: 'not-run' });
    expect(r.running).toBe(false);
  });

  it('Stop during a compile leaves no error', async () => {
    await store.add(P, { input: 'x', expected: 'x' });
    const r = make(programs({ compile: () => setImmediate(() => r.stop()) }));
    expect(await r.run()).toEqual({ kind: 'not-run' });
  });

  it('only one run at a time', async () => {
    await store.add(P, { input: 'x', expected: 'x' });
    const p = programs();
    const r = make(p);
    const first = r.run();
    expect(r.running).toBe(true); // at once: a double click starts nothing
    expect(await r.run()).toBeNull();
    await first;
    expect(compiles(p)).toHaveLength(1);
    expect(r.running).toBe(false);
  });

  it('switching files during a run keeps its results on their own list', async () => {
    await store.add(P, { input: 'x', expected: 'x' });
    const p = programs();
    const r = make(p);
    await r.onActiveFile();
    const run = r.run();
    await vi.waitFor(() => expect(p.calls.length).toBeGreaterThan(0)); // past resolving what to run
    h.problem = null;
    await r.onActiveFile();
    expect(r.summary()).toEqual({ kind: 'no-cases' });
    await run;
    h.problem = { id: 7 };
    await r.onActiveFile();
    expect(r.summary()).toEqual({ kind: 'done', passed: 1, total: 1 });
  });

  it('saves unsaved edits first, only of this file', async () => {
    await store.add(P, { input: 'x', expected: 'x' });
    const save = vi.fn(async () => true);
    const other = vi.fn(async () => true);
    v.textDocuments = [
      { uri: uri(file), isDirty: true, isUntitled: false, languageId: 'cpp', save },
      { uri: uri(join(dir, 'other.cpp')), isDirty: true, isUntitled: false, languageId: 'cpp', save: other },
    ];
    await make(programs()).run();
    expect(save).toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });

  it('folder mode: compiles the set, runs main while student.h is open, saves the whole folder', async () => {
    const pkg = join(dir, 'pkg');
    await mkdir(pkg);
    await writeFile(join(pkg, 'main.cpp'), '#include "student.h"\nint main() {}\n');
    await writeFile(join(pkg, 'util.cpp'), 'int u;\n');
    await writeFile(join(pkg, 'student.h'), 'int a;\n');
    h.fileUri = uri(join(pkg, 'student.h'));
    h.folder = {
      link: { fsPath: pkg, entry: {} },
      runUri: () => uri(join(pkg, 'main.cpp')),
      askRole: async () => 'main.cpp',
      compileFiles: async () => ({ sources: ['main.cpp', 'util.cpp'], leftOut: ['gen.cpp'] }),
    };
    await store.add(P, { input: 'x', expected: 'x' });
    const save = vi.fn(async () => true);
    v.textDocuments = [{ uri: uri(join(pkg, 'student.h')), isDirty: true, isUntitled: false, languageId: 'cpp', save }];
    const p = programs();
    await make(p).run();
    expect(save).toHaveBeenCalled();
    const args = compiles(p)[0].args;
    expect(args.slice(-2)).toEqual([join(pkg, 'main.cpp'), join(pkg, 'util.cpp')]);
    expect(args[args.indexOf('-iquote') + 1]).toBe(pkg);
  });

  it('folder mode: when the run file is asked and not given, nothing starts', async () => {
    h.folder = { link: { fsPath: dir, entry: {} }, runUri: () => null, askRole: async () => null, compileFiles: async () => null };
    await store.add(P, { input: 'x', expected: 'x' });
    const p = programs();
    expect(await make(p).run()).toBeNull();
    expect(p.calls).toHaveLength(0);
  });

  it('a build folder that can not run programs falls back to the storage folder', async () => {
    await store.add(P, { input: 'x', expected: 'x' });
    let first = true;
    const p = programs({ run: (c) => {
      if (first) {
        first = false;
        setImmediate(() => c.child.emit('error', Object.assign(new Error('no'), { code: 'EACCES' })));
        return;
      }
      c.child.stdin.on('data', (d) => c.child.stdout.write(d));
      c.child.stdin.on('end', () => setImmediate(() => c.child.finish(0)));
    } });
    expect(await make(p).run()).toEqual({ kind: 'done', passed: 1, total: 1 });
    const outs = compiles(p).map((c) => c.args[c.args.indexOf('-o') + 1]);
    expect(outs).toHaveLength(2);
    expect(outs[1].startsWith(join(dir, 'storage', 'bin'))).toBe(true);
  });

  it('writes nothing into the folder of the file', async () => {
    await store.add(P, { input: 'x', expected: 'x' });
    await make(programs()).run();
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).sort()).toEqual(['a.cpp', 'bin', 'storage']);
  });

  it('reset stops a run and forgets every result', async () => {
    await store.add(P, { input: 'x', expected: 'x' });
    const r = make(programs());
    await r.onActiveFile();
    await r.run();
    r.reset();
    await r.onActiveFile();
    expect(r.summary()).toEqual({ kind: 'not-run' });
  });

  describe('limits', () => {
    const slow = (ms: number) => programs({ run: (c) => setTimeout(() => c.child.finish(0), ms) });

    it('the grader\'s limit decides the verdict, and is saved for offline use', async () => {
      limitsFromGrader.mockResolvedValue({ timeMs: 1, memoryMB: 64 });
      await store.add(P, { input: '', expected: '' });
      const r = make(slow(30));
      expect(await r.run()).toEqual({ kind: 'done', passed: 0, total: 1 });
      const saved = await store.read(P);
      expect(saved.limits).toMatchObject({ timeMs: 1, memoryMB: 64 });
      expect(r.knownLimits(saved)).toEqual({ timeMs: 1, memoryMB: 64, source: 'grader' });
    });

    it('no answer from the grader: the defaults, and the run goes ahead', async () => {
      await store.add(P, { input: '', expected: '' });
      const r = make(slow(5));
      expect(await r.run()).toEqual({ kind: 'done', passed: 1, total: 1 });
      expect(r.knownLimits(await store.read(P))).toEqual({ timeMs: 5000, memoryMB: 256, source: 'default' });
    });

    it('saved limits are used at once, even while the grader is silent', async () => {
      limitsFromGrader.mockReturnValue(new Promise(() => {}));
      await store.add(P, { input: '', expected: '' });
      await store.setMeta(7, { limits: { timeMs: 1, memoryMB: 64, fetchedAt: 'then' } });
      expect(await make(slow(30)).run()).toEqual({ kind: 'done', passed: 0, total: 1 });
    });

    it('an unlinked file never asks the grader', async () => {
      h.problem = null;
      await store.add({ file }, { input: 'x', expected: 'x' });
      await make(programs()).run();
      expect(limitsFromGrader).not.toHaveBeenCalled();
    });

    it('opening the test view asks once for the shown problem', async () => {
      const r = make(programs());
      r.fetchLimits();
      expect(limitsFromGrader).toHaveBeenCalledWith(7);
      h.problem = null;
      r.fetchLimits();
      expect(limitsFromGrader).toHaveBeenCalledTimes(1);
    });
  });

  it('should the split open: not on a full pass or a run that never started', () => {
    expect(Runner.shouldOpenTests({ kind: 'done', passed: 2, total: 2 })).toBe(false);
    expect(Runner.shouldOpenTests({ kind: 'done', passed: 1, total: 2 })).toBe(true);
    expect(Runner.shouldOpenTests({ kind: 'compile-error' })).toBe(true);
    expect(Runner.shouldOpenTests(null)).toBe(false);
  });

  it('owner keys never collide', () => {
    expect(ownerKey({ problemId: 1 })).not.toBe(ownerKey({ file: '1' }));
  });
});

describe('summarize', () => {
  const cases = [{ id: 'a' }, { id: 'b' }];
  const s = (o = {}) => ({ ...emptyState(), ...o });
  const done = (id: string, verdict: 'AC' | 'WA') => [id, { caseId: id, state: 'done' as const, verdict }] as const;

  it('each pill', () => {
    expect(summarize([], s())).toEqual({ kind: 'no-cases' });
    expect(summarize(cases, s())).toEqual({ kind: 'not-run' });
    expect(summarize(cases, s({ phase: 'compiling' }))).toEqual({ kind: 'compiling' });
    expect(summarize(cases, s({ failure: { message: 'x', file: null, line: null } }))).toEqual({ kind: 'compile-error' });
    expect(summarize(cases, s({ runs: new Map([done('a', 'AC'), done('b', 'WA')]) }))).toEqual({ kind: 'done', passed: 1, total: 2 });
  });
  it('running counts what is done so far', () => {
    const runs = new Map<string, unknown>([done('a', 'AC'), ['b', { caseId: 'b', state: 'running' }]]);
    expect(summarize(cases, s({ phase: 'running', runs }))).toEqual({ kind: 'running', done: 1, total: 2 });
  });
  it('a case added after the run counts as not passed', () => {
    const st = s({ runs: new Map([done('a', 'AC')]) });
    expect(summarize(cases, st)).toEqual({ kind: 'done', passed: 1, total: 2 });
    expect(allPassed(summarize(cases, st))).toBe(false);
  });
  it('a deleted case no longer counts', () => {
    expect(allPassed(summarize([{ id: 'a' }], s({ runs: new Map([done('a', 'AC'), done('gone', 'WA')]) })))).toBe(true);
  });
});
