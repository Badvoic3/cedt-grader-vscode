import * as vscode from 'vscode';
import { BREAK } from '../shared/constants';
import { KEYS } from '../shared/stateKeys';
import { S } from '../shared/strings';
import { BreakTimer, type BoundaryKind, type BreakDay, type BreakScene, type Holds, normalizeBreakDay, type PromptAnswer } from './breakRules';

export interface BreakReminderDeps {
  /** The reminder's settings, read at call time. */
  settings(): { enabled: boolean; minutes: number };
  /** What may not be interrupted right now (grading, a test run, an exam page). */
  holds(): Holds;
  /** globalState. */
  state: vscode.Memento;
  /** `<baseUrl>:<user>`: the day's prompts are counted per account. */
  account(): string;
  /** Open the break tab (the prompt's or the hint's "Take a Break"). */
  takeBreak(): Promise<void>;
  log(msg: string): void;
  now?: () => number;
}

/**
 * The break reminder in VS Code: counts work from edits, runs and submits, shows `$(coffee) Break?` in the status
 * bar once enough work has passed, and offers a small, non-modal prompt only at a task boundary. The rules live in
 * breakRules.ts; this class only feeds them and shows what they say.
 */
export class BreakReminder implements vscode.Disposable {
  private readonly timer: BreakTimer;
  private readonly item = vscode.window.createStatusBarItem('cedtGrader.break', vscode.StatusBarAlignment.Left, 49);
  private readonly subs: vscode.Disposable[] = [];
  private lastEdit = -Infinity;
  private tickHandle: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: BreakReminderDeps) {
    this.timer = new BreakTimer(deps.settings().minutes);
    this.item.command = 'cedtGrader.takeBreak';
    this.subs.push(
      this.item,
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file' || !e.contentChanges.length) return;
        // The user's typing: not an extension, a formatter in the background, or a branch switch reloading open files.
        if (!vscode.window.state.focused || vscode.window.activeTextEditor?.document !== e.document) return;
        const t = this.now();
        if (t - this.lastEdit < BREAK.activityDebounceMs) return;
        this.lastEdit = t;
        this.activity();
      }),
    );
  }

  start(): void {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => this.refresh(), BREAK.tickMs);
    this.refresh();
  }

  /** A run or a submit (edits are counted by the reminder itself). */
  activity(): void {
    this.timer.activity(this.now());
    this.refresh();
  }

  /** A celebration played: no prompt right after it. */
  celebrated(): void {
    this.timer.celebrated(this.now());
  }

  /** A task boundary: maybe the prompt. Failures are never boundaries. */
  boundary(kind: BoundaryKind): void {
    const s = this.deps.settings();
    if (!s.enabled) return;
    const t = this.now();
    const day = this.day(t);
    this.timer.setMinutes(s.minutes);
    if (!this.timer.boundary(t, kind, this.deps.holds(), day)) return;
    const shown = this.timer.prompted(day, t);
    void this.saveDay(shown);
    void this.prompt(t);
  }

  /** A break started (any path: the prompt, the hint, a command): count again from zero. */
  tookBreak(scene: BreakScene | null): void {
    this.timer.reset();
    const t = this.now();
    if (scene) void this.saveDay({ ...this.day(t), lastScene: scene });
    this.refresh();
  }

  /** The scene the last break showed, so the next random one differs. */
  lastScene(): BreakScene | null {
    return this.day(this.now()).lastScene;
  }

  /** Settings or the account changed. */
  refresh(): void {
    const s = this.deps.settings();
    this.timer.setMinutes(s.minutes);
    this.item.name = S.breakReminder.take;
    const t = this.now();
    if (!s.enabled || this.timer.show(t, this.day(t)) !== 'hint') {
      this.item.hide();
      return;
    }
    this.item.text = `$(coffee) ${S.breakReminder.hint}`;
    this.item.tooltip = S.breakReminder.hintTip(this.worked(t));
    this.item.show();
  }

  /** Another account starts with its own day and a fresh count. */
  resetSession(): void {
    this.timer.reset();
    this.refresh();
  }

  dispose(): void {
    if (this.tickHandle) clearInterval(this.tickHandle);
    for (const d of this.subs) d.dispose();
  }

  private async prompt(t: number): Promise<void> {
    let answer: PromptAnswer = 'ignored';
    try {
      // Non-modal: it never takes the keyboard. Its promise stays open until the user closes or answers it, also
      // after it hides by itself: BreakTimer stops waiting for it (BREAK.promptOpenMs).
      const take = S.breakReminder.take, snooze = S.breakReminder.snooze(BREAK.snoozeMs / 60_000), notToday = S.breakReminder.notToday;
      const pick = await vscode.window.showInformationMessage(S.breakReminder.prompt(this.worked(t)), take, snooze, notToday);
      answer = pick === take ? 'take' : pick === snooze ? 'snooze' : pick === notToday ? 'not-today' : 'ignored';
    } catch (err) {
      this.deps.log(`Break prompt: ${String(err)}`);
    }
    await this.saveDay(this.timer.answer(this.now(), answer, this.day(this.now())));
    this.refresh();
    if (answer === 'take') await this.deps.takeBreak();
  }

  private worked(t: number): string {
    const m = Math.max(1, Math.round(this.timer.worked(t) / 60_000));
    return S.breakReminder.duration(Math.floor(m / 60), m % 60);
  }

  private day(t: number): BreakDay {
    return normalizeBreakDay(this.deps.state.get(this.key()), t);
  }

  private saveDay(day: BreakDay): Thenable<void> {
    return this.deps.state.update(this.key(), day);
  }

  private key(): string {
    return `${KEYS.funBreakDayPrefix}:${this.deps.account()}`;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
