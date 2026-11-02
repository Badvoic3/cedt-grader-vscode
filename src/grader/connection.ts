import { G } from '../shared/strings';
import { AuthError, NetworkError, ServerBusyError, SessionExpiredError } from './errors';

/** Kinds of connection trouble shown in the sidebar banner. */
export type ConnectionKind = 'offline' | 'unreachable' | 'server' | 'session' | 'throttled' | 'timeout';

export interface ConnectionProblem {
  kind: ConnectionKind;
  title: string;
  message: string;
  /** What the banner button does. */
  action: 'retry' | 'login';
}

/**
 * Classify an error for the connection banner, or null when it is not a
 * connection problem (wrong language, problem closed, ...: shown inline instead).
 */
export function classifyConnectionError(err: unknown): ConnectionProblem | null {
  if (err instanceof AuthError && err.reason === 'throttled') {
    return { kind: 'throttled', title: G.tooManyLoginAttempts, message: G.theGraderIsBlockingLogins, action: 'retry' };
  }
  if (err instanceof SessionExpiredError || (err instanceof AuthError && (err.reason === 'wrong-password' || err.reason === 'no-credentials'))) {
    return { kind: 'session', title: G.sessionExpired, message: G.yourGraderLoginExpiredAnd, action: 'login' };
  }
  if (err instanceof ServerBusyError && err.status === 429) {
    return { kind: 'throttled', title: G.tooManyRequests, message: G.theGraderIsRateLimiting, action: 'retry' };
  }
  if (err instanceof NetworkError) {
    switch (err.kind) {
      case 'offline':
        return { kind: 'offline', title: G.noInternetConnection, message: G.checkYourInternetConnectionThen, action: 'retry' };
      case 'timeout':
        return { kind: 'timeout', title: G.theGraderIsNotResponding, message: G.theRequestTimedOutThe, action: 'retry' };
      case 'server':
        return { kind: 'server', title: G.graderServerError, message: G.theGraderReturnedAServer, action: 'retry' };
      default:
        return { kind: 'unreachable', title: G.cannotReachTheGrader, message: G.theGraderServerIsUnreachable, action: 'retry' };
    }
  }
  return null;
}

/**
 * Message for a failed submit. `sentId` is the submission id when the POST
 * already succeeded (the failure happened while waiting for the result).
 */
export function describeSubmitFailure(err: unknown, sentId: number | null): string | null {
  const problem = classifyConnectionError(err);
  if (!problem) return null;
  if (sentId !== null) {
    return G.yourSubmissionWasSentResults(sentId);
  }
  if (problem.kind === 'timeout') {
    return G.theGraderDidNotAnswer;
  }
  if (problem.kind === 'server') {
    return G.nothingSubmittedServerError;
  }
  if (problem.kind === 'session') return G.nothingWasSubmittedYourLogin;
  if (problem.kind === 'throttled') return G.nothingWasSubmittedTheGrader;
  return G.nothingWasSubmitted(problem.title.toLowerCase());
}
