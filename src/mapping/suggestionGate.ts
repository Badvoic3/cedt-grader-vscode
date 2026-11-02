/**
 * Write actions on a suggested (unconfirmed) match: one light, non-modal
 * question; answering yes confirms the link, so it is never asked again.
 * Read-only features don't go through here (suggestions behave like links).
 * No `vscode` import (unit tested).
 */
export type GateAnswer = 'yes' | 'choose' | undefined;

export async function confirmSuggestion(opts: {
  /** Current source of the active file's problem. */
  source: string;
  /** Ask in the panel; resolves 'yes', 'choose' (pick another problem) or undefined (dismissed). */
  ask: () => Promise<GateAnswer>;
  /** Save the link (the suggestion becomes "Chosen by you"). */
  confirm: () => Promise<void>;
  /** Open the problem picker. */
  chooseAnother: () => Promise<void>;
}): Promise<boolean> {
  if (opts.source !== 'suggested') return true;
  const a = await opts.ask();
  if (a === 'yes') {
    await opts.confirm();
    return true;
  }
  if (a === 'choose') await opts.chooseAnother();
  return false;
}
