import { beforeEach, describe, expect, it, vi } from 'vitest';

const v = vi.hoisted(() => ({
  item: { text: '', tooltip: '' as unknown, command: '', name: '', visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} },
  edits: [] as ((e: unknown) => void)[],
  answer: undefined as string | undefined,
  prompts: [] as { text: string; buttons: string[]; modal: boolean }[],
  focused: true,
  activeDoc: { uri: { scheme: 'file' } } as unknown,
  /** The prompt's promise stays open, as VS Code's does until the notification is closed. */
  neverAnswers: false,
}));

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    createStatusBarItem: () => v.item,
    get state() { return { focused: v.focused }; },
    get activeTextEditor() { return { document: v.activeDoc }; },
    showInformationMessage: async (text: string, ...rest: unknown[]) => {
      const modal = typeof rest[0] === 'object' && !!(rest[0] as { modal?: boolean }).modal;
      v.prompts.push({ text, buttons: rest.filter((x): x is string => typeof x === 'string'), modal });
      if (v.neverAnswers) return new Promise(() => undefined);
      return v.answer;
    },
  },
  workspace: { onDidChangeTextDocument: (f: (e: unknown) => void) => (v.edits.push(f), { dispose() {} }) },
}));

import { BreakReminder } from '../src/flows/breakReminder';
import { S } from '../src/shared/strings';

const MIN = 60_000;
const flush = () => new Promise((r) => setTimeout(r, 0));

function make(opts: { enabled?: boolean; exam?: boolean } = {}) {
  let now = new Date(2026, 10, 9, 13).getTime();
  const store = new Map<string, unknown>();
  const took: number[] = [];
  const r = new BreakReminder({
    settings: () => ({ enabled: opts.enabled ?? true, minutes: 90 }),
    holds: () => ({ grading: false, running: false, exam: !!opts.exam }),
    state: { get: (k: string) => store.get(k), update: async (k: string, val: unknown) => void store.set(k, val), keys: () => [...store.keys()] } as never,
    account: () => 'https://g:me',
    takeBreak: async () => void took.push(now),
    log: () => undefined,
    now: () => now,
  });
  const edit = () => v.edits.at(-1)!({ document: v.activeDoc, contentChanges: [{}] });
  const workFor = (minutes: number) => { for (let m = 0; m < minutes; m += 5) { now += 5 * MIN; edit(); } };
  return { r, store, took, edit, workFor, advance: (ms: number) => (now += ms) };
}

describe('break reminder in VS Code', () => {
  beforeEach(() => {
    v.item.visible = false; v.edits.length = 0; v.prompts.length = 0; v.answer = undefined; v.focused = true; v.neverAnswers = false; v.item.name = '';
  });

  it('edits count as work; after 90 minutes the status bar shows the hint, and it opens a break', () => {
    const m = make();
    m.workFor(85);
    expect(v.item.visible).toBe(false);
    m.workFor(10);
    expect(v.item.visible).toBe(true);
    expect(v.item.text).toBe(`$(coffee) ${S.breakReminder.hint}`);
    expect(v.item.command).toBe('cedtGrader.takeBreak');
    m.r.tookBreak('sand');
    expect(v.item.visible).toBe(false);
    expect(m.r.lastScene()).toBe('sand');
  });

  it('edits to non-file documents and edits without changes do not count', () => {
    const m = make();
    for (let i = 0; i < 40; i++) { m.advance(5 * MIN); v.edits.at(-1)!({ document: { uri: { scheme: 'output' } }, contentChanges: [{}] }); v.edits.at(-1)!({ document: { uri: { scheme: 'file' } }, contentChanges: [] }); }
    m.r.refresh();
    expect(v.item.visible).toBe(false);
  });

  it("only the user's typing counts: not another file changing, nor anything while the window is in the background", () => {
    const m = make();
    m.edit(); // work starts
    for (let i = 0; i < 40; i++) {
      m.advance(5 * MIN);
      v.edits.at(-1)!({ document: { uri: { scheme: 'file' } }, contentChanges: [{}] }); // format, branch switch, another extension
      v.focused = false;
      m.edit();
      v.focused = true;
    }
    m.r.refresh();
    expect(v.item.visible).toBe(false); // the idle gap reset the count
  });

  it('the status bar item has its name once the reminder runs, in the current language', () => {
    const m = make();
    m.r.refresh();
    expect(v.item.name).toBe(S.breakReminder.take);
  });

  it('a prompt nobody answered (VS Code only hid it) lets a later boundary prompt again', async () => {
    const m = make();
    m.workFor(120);
    v.neverAnswers = true;
    m.r.boundary('verdict-pass');
    await flush();
    expect(v.prompts).toHaveLength(1);
    m.r.boundary('verdict-pass');
    await flush();
    expect(v.prompts).toHaveLength(1); // still on screen
    m.workFor(5);
    m.r.boundary('verdict-pass');
    await flush();
    expect(v.prompts).toHaveLength(2);
  });

  it('the prompt comes at a boundary in its window, never modal, and "Take a Break" opens the break', async () => {
    const m = make();
    m.workFor(95);
    m.r.boundary('verdict-pass');
    expect(v.prompts).toHaveLength(0); // too soon after the hint
    m.workFor(25);
    v.answer = S.breakReminder.take;
    m.r.boundary('verdict-pass');
    await flush();
    expect(v.prompts).toHaveLength(1);
    expect(v.prompts[0].modal).toBe(false);
    expect(v.prompts[0].buttons).toEqual([S.breakReminder.take, S.breakReminder.snooze(30), S.breakReminder.notToday]);
    expect(m.took).toHaveLength(1);
    expect([...m.store.values()][0]).toMatchObject({ prompts: 1 });
  });

  it('no prompt on an exam page, and none when the reminder is off', async () => {
    const exam = make({ exam: true });
    exam.workFor(120);
    exam.r.boundary('switch');
    const off = make({ enabled: false });
    off.workFor(120);
    off.r.boundary('switch');
    off.r.refresh();
    await flush();
    expect(v.prompts).toHaveLength(0);
    expect(v.item.visible).toBe(false);
  });

  it('"Not today" hides the hint and stores the answer for this account', async () => {
    const m = make();
    m.workFor(120);
    v.answer = S.breakReminder.notToday;
    m.r.boundary('tests-pass');
    await flush();
    await flush();
    expect(v.item.visible).toBe(false);
    expect([...m.store.keys()]).toEqual(['cedtGrader.fun.breakDay:https://g:me']);
    expect([...m.store.values()][0]).toMatchObject({ notTodayUntil: new Date(2026, 10, 10, 4).getTime() });
  });
});
