import type { ViewState } from './messages';

/**
 * Getting Started walkthrough (`contributes.walkthroughs` in package.json).
 * Steps complete through context keys the extension sets from `ViewState`
 * (no `vscode` import here; `src/extension.ts` calls `setContext`).
 */
export const WALKTHROUGH_ID = 'cedtGrader.start';

export const WALKTHROUGH_CONTEXT = {
  loggedIn: 'cedtGrader.loggedIn',
  hasSourceFile: 'cedtGrader.hasSourceFile',
  hasProblem: 'cedtGrader.hasProblem',
  submitted: 'cedtGrader.submitted',
} as const;

export type WalkthroughContext = Record<(typeof WALKTHROUGH_CONTEXT)[keyof typeof WALKTHROUGH_CONTEXT], boolean>;

/** Context values for a state; "submitted" stays true once a submission was sent this session. */
export function walkthroughContext(s: ViewState, submittedBefore: boolean): WalkthroughContext {
  const supported = !!s.file?.supported;
  const phase = s.result?.phase;
  return {
    [WALKTHROUGH_CONTEXT.loggedIn]: s.account.status === 'logged-in',
    [WALKTHROUGH_CONTEXT.hasSourceFile]: supported,
    [WALKTHROUGH_CONTEXT.hasProblem]: supported && !!s.problem,
    [WALKTHROUGH_CONTEXT.submitted]: submittedBefore || phase === 'grading' || phase === 'done' || phase === 'timeout',
  } as WalkthroughContext;
}
