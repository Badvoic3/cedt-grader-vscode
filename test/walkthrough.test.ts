import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ViewState } from '../src/shared/messages';
import { WALKTHROUGH_CONTEXT, WALKTHROUGH_ID, walkthroughContext } from '../src/shared/walkthrough';

const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const walkthrough = pkg.contributes.walkthroughs.find((w: { id: string }) => w.id === WALKTHROUGH_ID);
type Step = { id: string; title: string; description: string; media: { markdown?: string }; completionEvents: string[] };
const steps: Step[] = walkthrough?.steps ?? [];

describe('Getting Started walkthrough (package.json)', () => {
  it('exists with the expected steps', () => {
    expect(walkthrough).toBeTruthy();
    expect(steps.map((s) => s.id)).toEqual(['openPanel', 'login', 'openFile', 'checkProblem', 'submit', 'cph']);
  });

  it('every step has a markdown page that exists and is packaged', () => {
    const ignore = readFileSync(join(root, '.vscodeignore'), 'utf8');
    expect(ignore).toMatch(/^!media\/walkthrough\/\*\*$/m);
    for (const s of steps) {
      expect(s.media.markdown).toMatch(/^media\/walkthrough\/.+\.md$/);
      expect(existsSync(join(root, s.media.markdown!))).toBe(true);
    }
  });

  it('every step can complete, through a context key the extension sets, a view or an install', () => {
    const keys = new Set<string>(Object.values(WALKTHROUGH_CONTEXT));
    for (const s of steps) {
      expect(s.completionEvents.length).toBeGreaterThan(0);
      for (const e of s.completionEvents) {
        if (e.startsWith('onContext:')) expect(keys.has(e.slice('onContext:'.length))).toBe(true);
        else expect(e).toMatch(/^(onView:cedtGrader\.panel|extensionInstalled:DivyanshuAgrawal\.competitive-programming-helper)$/);
      }
    }
  });

  it('command links point to contributed commands (or known VS Code ones)', () => {
    const ours = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
    const builtIn = new Set(['workbench.action.files.openFolder', 'extension.open']);
    for (const s of steps) {
      for (const m of s.description.matchAll(/\(command:([\w.]+)/g)) expect(ours.has(m[1]) || builtIn.has(m[1])).toBe(true);
    }
    expect(ours.has('cedtGrader.openWalkthrough')).toBe(true);
  });
});

describe('walkthrough context keys', () => {
  const base = {
    account: { status: 'logged-out' },
    file: null,
    problem: null,
    result: null,
  } as unknown as ViewState;
  const S = (over: Record<string, unknown>) => ({ ...base, ...over }) as ViewState;
  const K = WALKTHROUGH_CONTEXT;

  it('nothing done yet', () => {
    expect(walkthroughContext(base, false)).toEqual({ [K.loggedIn]: false, [K.hasSourceFile]: false, [K.hasProblem]: false, [K.submitted]: false });
  });

  it('logged in, source file with a problem', () => {
    const c = walkthroughContext(S({ account: { status: 'logged-in' }, file: { supported: true }, problem: { id: 1 } }), false);
    expect(c).toMatchObject({ [K.loggedIn]: true, [K.hasSourceFile]: true, [K.hasProblem]: true });
  });

  it('a problem for an unsupported file does not count', () => {
    expect(walkthroughContext(S({ file: { supported: false }, problem: { id: 1 } }), false)[K.hasProblem]).toBe(false);
  });

  it('submitted once a submission was sent, and stays true', () => {
    expect(walkthroughContext(S({ result: { phase: 'submitting' } }), false)[K.submitted]).toBe(false);
    expect(walkthroughContext(S({ result: { phase: 'error' } }), false)[K.submitted]).toBe(false);
    expect(walkthroughContext(S({ result: { phase: 'grading' } }), false)[K.submitted]).toBe(true);
    expect(walkthroughContext(base, true)[K.submitted]).toBe(true);
  });
});
