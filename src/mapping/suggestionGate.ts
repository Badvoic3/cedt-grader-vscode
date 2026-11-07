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

/**
 * Which question Submit asks about the problem before sending (pure):
 * - a suggestion (not confirmed) → the suggestion question, always (even with confirmations off);
 * - chosen by the user (a saved file or folder link) → nothing, ever;
 * - an automatic match (file name, folder name) → one confirmation while
 *   "Confirm Before Submit" is on; answering Submit saves the link, so it becomes
 *   "Chosen by you" and is not asked again.
 * `answered`: another question just covered it (the exam warning, or folder mode's "which file").
 */
export type SubmitQuestion = 'suggested' | 'confirmOnce' | null;

export function submitQuestion(o: { source: string; confirmBeforeSubmit: boolean; answered: boolean }): SubmitQuestion {
  if (o.source === 'suggested') return 'suggested';
  if (o.source === 'saved' || o.answered) return null;
  return o.confirmBeforeSubmit ? 'confirmOnce' : null;
}
