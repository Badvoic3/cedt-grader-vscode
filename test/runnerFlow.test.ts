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
  describe('case actions', () => {
    const seeded = async () => {
      await store.add(P, { input: 'a\n', expected: 'a\n' });
      await store.add(P, { input: 'b\n', expected: 'b\n' });
      const r = make(programs());
      await r.onActiveFile();
      await r.run();
      return { r, ids: (await store.read(P)).cases.map((c) => c.id) };
    };

    it('an edit clears that case\'s result only, and a Grader case becomes Custom', async () => {
      await store.merge(7, [{ input: 'a\n', expected: 'a\n', testcaseId: 1 }, { input: 'b\n', expected: 'b\n', testcaseId: 2 }], 'grader');
      const r = make(programs());
      await r.onActiveFile();
      await r.run();
      const [first, second] = (await store.read(P)).cases.map((c) => c.id);
      await r.editCase(first, { expected: 'x\n' });
      const v = (h.tests = { busy: false, samplesBusy: false, statementNoPdf: false }, r.testsView());
      expect(v.runs.has(first)).toBe(false);
      expect(v.runs.get(second)?.verdict).toBe('AC');
      expect(v.cases[0]).toMatchObject({ source: 'custom', expected: 'x\n' });
    });

    it('a run waits for edits sent just before it', async () => {
      const { r, ids } = await seeded();
      void r.editCase(ids[0], { expected: 'wrong\n' });
      const s = await r.run();
      expect(s).toEqual({ kind: 'done', passed: 1, total: 2 });
    });

    it('add, remove and reorder change the list at once, in order', async () => {
      const { r, ids } = await seeded();
      h.tests = { busy: false, samplesBusy: false, statementNoPdf: false };
      await r.addCase();
      expect(r.testsView().cases).toHaveLength(3);
      await r.reorderCases([ids[1], ids[0], r.testsView().cases[2].id]);
      expect(r.testsView().cases[0].id).toBe(ids[1]);
      await r.removeCase(ids[1]);
      expect(r.testsView().cases.map((c) => c.id)).not.toContain(ids[1]);
      expect(r.testsView().runs.has(ids[1])).toBe(false);
    });

    it('a failed save is shown, and later changes still work', async () => {
      const { r, ids } = await seeded();
      const update = store.update.bind(store);
      store.update = () => Promise.reject(new Error('disk full'));
      await r.editCase(ids[0], { expected: 'x\n' });
      expect(told).toEqual([S.runner.saveFailed('Error: disk full')]);
      store.update = update;
      await r.editCase(ids[0], { expected: 'y\n' });
      expect((await store.read(P)).cases[0].expected).toBe('y\n');
    });

    it('Set Actual as Expected uses the whole output, and refuses a cut one', async () => {
      await store.add(P, { input: 'hello\n', expected: 'nope\n' });
      const p = programs();
      const r = make(p);
      await r.onActiveFile();
      await r.run();
      const id = (await store.read(P)).cases[0].id;
      expect(r.textOf(id, 'actual')).toBe('hello\n');
      await r.setExpected(id);
      expect((await store.read(P)).cases[0].expected).toBe('hello\n');

      await store.update(P, id, { expected: 'nope\n' });
      await r.run();
      const run = (r as unknown as { state(o: unknown): { runs: Map<string, { actual: { truncated: boolean } }> } }).state(P).runs.get(id)!;
      run.actual.truncated = true;
      await r.setExpected(id);
      expect((await store.read(P)).cases[0].expected).toBe('nope\n');
    });

    it('copies the whole text, also when the view shows it cut', async () => {
      const big = 'x'.repeat(100_000);
      await store.add(P, { input: big, expected: 'y\n' });
      const r = make(programs());
      await r.onActiveFile();
      const id = (await store.read(P)).cases[0].id;
      expect(r.textOf(id, 'input')).toBe(big);
      expect(r.textOf('nope', 'input')).toBeNull();
    });
  });

  describe('review fixes', () => {
    it('saves before reading the file, so the language and main() checks see the new text', async () => {
      const order: string[] = [];
      v.textDocuments = [{ uri: uri(file), isDirty: true, isUntitled: false, languageId: 'cpp', save: async () => (order.push('save'), true) }];
      await store.add(P, { input: 'a\n', expected: 'a\n' });
      h.folder = { ...h.folder, link: { fsPath: dir }, compileFiles: async () => (order.push('read'), null) };
      await make(programs()).run();
      expect(order).toEqual(['save', 'read']);
    });

    it('limits that arrive after an account change are dropped', async () => {
      await store.add(P, { input: 'a\n', expected: 'a\n' });
      let answer = (_: unknown) => {};
      limitsFromGrader.mockImplementation(() => new Promise((done) => (answer = done)));
      const r = make(programs());
      await r.onActiveFile();
      r.fetchLimits();
      r.reset();
      answer({ timeMs: 1000, memoryMB: 64 });
      await new Promise((done) => setTimeout(done, 10));
      expect((await store.read(P)).limits).toBeUndefined();
    });

    it('a re-download that changes a case drops its old result, and only its', async () => {
      await store.merge(7, [{ input: 'a\n', expected: 'a\n', testcaseId: 1 }, { input: 'b\n', expected: 'b\n', testcaseId: 2 }], 'grader');
      h.tests = { busy: false, samplesBusy: false, statementNoPdf: false };
      const r = make(programs());
      await r.onActiveFile();
      await r.run();
      await store.merge(7, [{ input: 'a\n', expected: 'new\n', testcaseId: 1 }], 'grader');
      await r.onActiveFile();
      const [first, second] = r.testsView().cases.map((c) => c.id);
      expect(r.testsView().runs.has(first)).toBe(false);
      expect(r.testsView().runs.has(second)).toBe(true);
    });

    // Exit code 126 is how `sh` and `time` say it; Windows has neither.
    it.skipIf(process.platform === 'win32')('a storage folder that can\'t run programs either ends in a message, with no case left running', async () => {
      await store.add(P, { input: 'a\n', expected: 'a\n' });
      const p = programs({ run: (c) => setImmediate(() => c.child.finish(126)) });
      const r = make(p);
      await r.onActiveFile();
      expect(await r.run()).toEqual({ kind: 'compile-error' });
      expect(r.failureText()).toBe(S.runner.compilerFailed('EACCES'));
    });
  });

  describe('sample tip', () => {
    beforeEach(() => {
      h.tests = { busy: false, samplesBusy: false, statementNoPdf: false };
      h.problem = { id: 7, name: 'P', hasTestcase: true } as never;
    });
    const wrongSample = () => store.merge(7, [{ input: 'a\n', expected: 'nope\n' }], 'sample');

    it('shows after 2 runs where only PDF samples fail, and stays away once dismissed', async () => {
      await wrongSample();
      const r = make(programs());
      await r.onActiveFile();
      await r.run();
      expect(r.testsView().head.sampleTip).toBe(false);
      await r.run();
      expect(r.testsView().head.sampleTip).toBe(true);
      await r.dismissSampleTip();
      expect(r.testsView().head.sampleTip).toBe(false);
      await r.run();
      expect(r.testsView().head.sampleTip).toBe(false);
      expect((await store.read(P)).sampleTip?.dismissed).toBe(true);
    });

    it('never beside a failing Grader case', async () => {
      await wrongSample();
      await store.merge(7, [{ input: 'b\n', expected: 'nope\n', testcaseId: 1 }], 'grader');
      const r = make(programs());
      await r.onActiveFile();
      await r.run();
      await r.run();
      await r.run();
      expect(r.testsView().head.sampleTip).toBe(false);
      expect((await store.read(P)).sampleTip?.failedRuns ?? 0).toBe(0);
    });

    it('a run that didn\'t compile doesn\'t count', async () => {
      await wrongSample();
      const r = make(programs({ compile: (c) => setImmediate(() => c.child.finish(1)) }));
      await r.onActiveFile();
      await r.run();
      await r.run();
      expect((await store.read(P)).sampleTip).toBeUndefined();
    });
  });

  it('compareTexts gives the whole expected text and the output, numbered by position', async () => {
    await store.add(P, { input: 'a\n', expected: 'x\n' });
    await store.add(P, { input: 'b\n', expected: 'y\n' });
    const r = make(programs());
    await r.onActiveFile();
    const id = (await store.read(P)).cases[1].id;
    expect(r.compareTexts(id)).toBeNull();
    await r.run();
    expect(r.compareTexts(id)).toEqual({ n: 2, expected: 'y\n', actual: 'b\n' });
    expect(r.compareTexts('nope')).toBeNull();
  });

  describe('views', () => {
    beforeEach(() => {
      h.tests = { busy: false, samplesBusy: true, statementNoPdf: false };
    });

    it('main panel: no cases disables Run tests with a reason', async () => {
      const r = make(programs());
      await r.onActiveFile();
      expect(r.panelView()).toEqual({ summary: { kind: 'no-cases' }, running: false, disabledReason: S.runTests.noCases });
      await r.addCase();
      expect(r.panelView()).toEqual({ summary: { kind: 'not-run' }, running: false, disabledReason: null });
    });

    it('a linked problem has the Load row; a file with no problem has none, default limits and its name as title', async () => {
      const r = make(programs());
      h.problem = { id: 7, name: '01_Expr', hasTestcase: true } as never;
      await r.onActiveFile();
      expect(r.testsView().head).toMatchObject({ title: '01_Expr', problemId: 7, load: { testcases: { busy: false }, samples: { busy: true } } });
      h.tests = { busy: false, samplesBusy: false, statementNoPdf: true };
      h.problem = { id: 7, name: '01_Expr', hasTestcase: false } as never;
      expect(r.testsView().head.load).toEqual({ testcases: null, samples: null });
      h.problem = null;
      await r.onActiveFile();
      expect(r.testsView().head).toMatchObject({ title: 'a.cpp', problemId: null, load: null, limits: { timeMs: 5000, memoryMB: 256, source: 'default' } });
    });

    it('right after a file switch the last file\'s cases are not shown as the new one\'s', async () => {
      await store.add(P, { input: 'a\n', expected: 'a\n' });
      const r = make(programs());
      await r.onActiveFile();
      h.problem = { id: 8 } as never;
      expect(r.summary()).toEqual({ kind: 'no-cases' });
      expect(r.testsView().cases).toEqual([]);
    });

    it('a slow read of the last file never replaces the newest list', async () => {
      await store.add(P, { input: 'a\n', expected: 'a\n' });
      const r = make(programs());
      const read = store.read.bind(store);
      let release = () => {};
      const held = new Promise<void>((done) => (release = done));
      store.read = async (o) => {
        const got = await read(o);
        if ('problemId' in o && o.problemId === 7) await held;
        return got;
      };
      const slow = r.onActiveFile();
      h.problem = { id: 8 } as never;
      await r.onActiveFile();
      release();
      await slow;
      expect(r.testsView().key).toBe('problem:8');
      expect(r.testsView().cases).toEqual([]);
    });
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
