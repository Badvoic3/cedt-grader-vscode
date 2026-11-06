/**
 * Inline questions in the panel (plain buttons under the banner, or above
 * Submit): the calm alternative to modal dialogs. No `vscode` import: the
 * host passes `onChange` (re-render) and `reveal` (show the panel when it is
 * hidden), so the rules are unit tested.
 *
 * One question at a time: a new one, a file switch (`cancel`) or a dismissal
 * resolves the open one with `undefined`. A question with `stays` doesn't
 * depend on the active file, so a file switch leaves it open.
 */
export interface InlinePrompt {
  id: number;
  text: string;
  detail: string | null;
  tone: 'info' | 'warn';
  buttons: { id: string; label: string; primary?: boolean }[];
  /** 'submit': a question about submitting, shown right above the Submit button. */
  near: 'submit' | null;
}

export interface AskOptions {
  detail?: string;
  tone?: 'info' | 'warn';
  near?: 'submit';
  /** Stays open when the active file changes (the question names what it is about). */
  stays?: boolean;
}

export class InlinePrompts {
  private open: InlinePrompt | null = null;
  private stays = false;
  private resolveOpen: ((v: string | undefined) => void) | null = null;
  private seq = 0;

  constructor(
    private readonly onChange: () => void,
    /** Called when a question is asked while the panel is hidden. */
    private readonly reveal: () => void,
    private readonly isVisible: () => boolean,
  ) {}

  /** The question shown now (ViewState.prompt). */
  get current(): InlinePrompt | null {
    return this.open;
  }

  /** Resolves with the chosen button id, or undefined when replaced, dismissed or cancelled. */
  ask(text: string, buttons: InlinePrompt['buttons'], opts: AskOptions = {}): Promise<string | undefined> {
    this.resolveOpen?.(undefined);
    this.stays = !!opts.stays;
    const id = ++this.seq;
    this.open = { id, text, detail: opts.detail ?? null, tone: opts.tone ?? 'info', buttons, near: opts.near ?? null };
    this.onChange();
    if (!this.isVisible()) this.reveal();
    return new Promise((resolve) => {
      this.resolveOpen = (v) => {
        if (this.open?.id === id) {
          this.open = null;
          this.resolveOpen = null;
          this.onChange();
        }
        resolve(v);
      };
    });
  }

  /** A button in the panel (null = dismissed). Answers for an older question are ignored. */
  answer(id: number, button: string | null): void {
    if (this.open?.id === id) this.resolveOpen?.(button ?? undefined);
  }

  /** The active file changed: the open question goes away unanswered, unless it stays. */
  cancel(): void {
    if (!this.stays) this.resolveOpen?.(undefined);
  }
}
