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

/** Server answered with a flash alert after a submit (problem not available, source missing, ...). */
export class SubmitRejectedError extends GraderError {}

export class ContestBlockedError extends GraderError {
  constructor(message = 'This problem is part of an active contest/exam. Submit through the website.') {
    super(message);
  }
}

export class PollTimeoutError extends GraderError {}

export class ParseError extends GraderError {}
