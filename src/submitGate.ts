import type { ContestDetection } from './grader/types';
import { mustBlock } from './grader/contest';

export type GateDecision =
  | { kind: 'allow' }
  | { kind: 'block'; reason: string }
  /** Contest, but the user enabled `allowContestSubmissions`: ask (modal) every single time. */
  | { kind: 'confirm'; reason: string };

export const CONTEST_BLOCK_MESSAGE =
  'This problem is part of an active contest/exam. Submit through the website.';

export const CONTEST_CONFIRM_MESSAGE =
  'This problem is part of an active contest/exam. Only submit from VS Code if your instructor has explicitly ' +
  'permitted it for this exam. VS Code does not send the check-ins the website sends, so you may appear absent.';

/**
 * Contest gate (claude-code-prompt.md section 2b). Pure, so it is unit tested.
 * Uncertain detection counts as a contest.
 */
export function decideSubmit(d: ContestDetection | null, allowContestSubmissions: boolean): GateDecision {
  if (d === null) return { kind: 'block', reason: 'Could not check whether a contest is running. ' + CONTEST_BLOCK_MESSAGE };
  if (!mustBlock(d)) return { kind: 'allow' };
  if (allowContestSubmissions) return { kind: 'confirm', reason: CONTEST_CONFIRM_MESSAGE };
  return { kind: 'block', reason: CONTEST_BLOCK_MESSAGE };
}
