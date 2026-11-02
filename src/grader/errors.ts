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

export class NetworkError extends GraderError {}

/** HTTP 429 or 5xx after the retries were used up. Treated like being offline (cached data is shown). */
export class ServerBusyError extends NetworkError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Server answered with a flash alert after a submit (problem not available, source missing, ...). */
export class SubmitRejectedError extends GraderError {}

export class PollTimeoutError extends GraderError {}

export class ParseError extends GraderError {}
