import { G } from '../shared/strings';
/** Base class; messages are always human readable and never contain secrets. */
export class GraderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Wrong username/password, throttled, agreement required, etc. */
export class AuthError extends GraderError {
  constructor(
    message: string,
    readonly reason: 'wrong-password' | 'throttled' | 'agreement-required' | 'no-credentials' | 'unknown',
  ) {
    super(message);
  }
}

/** Session ended and could not be renewed (or must not be renewed automatically). */
export class SessionExpiredError extends GraderError {
  constructor(
    message: string,
    /** False for server alerts that a re-login cannot fix (two devices, IP, disabled account). */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class LanguageNotAllowedError extends GraderError {}

/**
 * The grader answered 404 / 403 for a problem (removed, hidden, or closed to
 * you). The link is then shown as "no longer available".
 */
export class ProblemUnavailableError extends GraderError {
  constructor(
    message: string,
    readonly status: 403 | 404,
  ) {
    super(message);
  }
}

export class NetworkError extends GraderError {
  constructor(
    message: string,
    /** Why the request failed, when known. */
    readonly kind: 'offline' | 'unreachable' | 'timeout' | 'server' = 'unreachable',
  ) {
    super(message);
  }
}

/** Map a fetch() rejection to a NetworkError with a kind (DNS → offline, refused/reset → unreachable, abort → timeout). */
export function networkErrorFrom(err: unknown, host: string): NetworkError {
  const e = err as { name?: string; message?: string; cause?: { code?: string; name?: string } };
  const code = e?.cause?.code ?? '';
  if (e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return new NetworkError(G.timeoutHost(host), 'timeout');
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH'].includes(code)) {
    return new NetworkError(G.noInternetConnectionCannotReach(host), 'offline');
  }
  return new NetworkError(G.cannotReachTheGraderServer(host), 'unreachable');
}

/** HTTP 429 or 5xx after the retries were used up. Treated like being offline (cached data is shown). */
export class ServerBusyError extends NetworkError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message, 'server');
  }
}

/** Server answered with a flash alert after a submit (problem not available, source missing, ...). */
export class SubmitRejectedError extends GraderError {}

export class PollTimeoutError extends GraderError {}

export class ParseError extends GraderError {}
