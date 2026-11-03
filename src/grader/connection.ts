import { G } from '../shared/strings';
import { AuthError, NetworkError, RedirectRefusedError, ServerBusyError, SessionExpiredError } from './errors';

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
    return { kind: 'throttled', title: G.loginThrottledTitle, message: G.loginThrottledMsg, action: 'retry' };
  }
  if (err instanceof SessionExpiredError || (err instanceof AuthError && (err.reason === 'wrong-password' || err.reason === 'no-credentials'))) {
    return { kind: 'session', title: G.sessionExpiredTitle, message: G.sessionExpiredMsg, action: 'login' };
  }
  if (err instanceof ServerBusyError && err.status === 429) {
    return { kind: 'throttled', title: G.rateLimitedTitle, message: G.rateLimitedMsg, action: 'retry' };
  }
  if (err instanceof RedirectRefusedError) {
    // Not an internet problem: say where the grader tried to send the request.
    return { kind: 'unreachable', title: G.unreachableTitle, message: err.message, action: 'retry' };
  }
  if (err instanceof NetworkError) {
    switch (err.kind) {
      case 'offline':
        return { kind: 'offline', title: G.offlineTitle, message: G.offlineMsg, action: 'retry' };
      case 'timeout':
        return { kind: 'timeout', title: G.timeoutTitle, message: G.timeoutMsg, action: 'retry' };
      case 'server':
        return { kind: 'server', title: G.serverErrorTitle, message: G.serverErrorMsg, action: 'retry' };
      default:
        return { kind: 'unreachable', title: G.unreachableTitle, message: G.unreachableMsg, action: 'retry' };
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
    return G.submitSentResultLater(sentId);
  }
  if (problem.kind === 'timeout') {
    return G.submitMaybeReceived;
  }
  if (problem.kind === 'server') {
    return G.submitNothingServerError;
  }
  if (problem.kind === 'session') return G.submitNothingLoginExpired;
  if (problem.kind === 'throttled') return G.submitNothingRateLimited;
  return G.submitNothing(problem.title.toLowerCase());
}
