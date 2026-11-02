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
    return { kind: 'throttled', title: 'Too many login attempts', message: 'The grader is blocking logins for a few minutes. Wait, then press Retry.', action: 'retry' };
  }
  if (err instanceof SessionExpiredError || (err instanceof AuthError && (err.reason === 'wrong-password' || err.reason === 'no-credentials'))) {
    return { kind: 'session', title: 'Session expired', message: 'Your grader login expired and logging in again failed. Log in again.', action: 'login' };
  }
  if (err instanceof ServerBusyError && err.status === 429) {
    return { kind: 'throttled', title: 'Too many requests', message: 'The grader is rate-limiting requests. Wait a minute, then press Retry.', action: 'retry' };
  }
  if (err instanceof NetworkError) {
    switch (err.kind) {
      case 'offline':
        return { kind: 'offline', title: 'No internet connection', message: 'Check your internet connection, then press Retry.', action: 'retry' };
      case 'timeout':
        return { kind: 'timeout', title: 'The grader is not responding', message: 'The request timed out. The server may be busy; press Retry in a moment.', action: 'retry' };
      case 'server':
        return { kind: 'server', title: 'Grader server error', message: 'The grader returned a server error (5xx). Try again later.', action: 'retry' };
      default:
        return { kind: 'unreachable', title: 'Cannot reach the grader', message: 'The grader server is unreachable. Check your connection or try again later.', action: 'retry' };
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
    return `Your submission #${sentId} was sent. Results will load when the connection is back.`;
  }
  if (problem.kind === 'timeout') {
    return 'The grader did not answer in time. Check History before resubmitting: it may or may not have been received.';
  }
  if (problem.kind === 'server') {
    return 'The grader returned a server error. Nothing was submitted (check History to be sure).';
  }
  if (problem.kind === 'session') return 'Nothing was submitted: your login expired. Log in again and resubmit.';
  if (problem.kind === 'throttled') return 'Nothing was submitted: the grader is rate-limiting requests. Try again in a minute.';
  return `Nothing was submitted: ${problem.title.toLowerCase()}.`;
}
