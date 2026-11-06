import { GraderError, NetworkError, RedirectRefusedError } from '../../errors';
import type { ServerCheck, ServerCheckOptions } from '../../provider';
import { Redactor } from '../../redact';
import { ApiClient } from './api';

/** Any API route: `Api::V1::BaseController` answers 401 before anything else when there is no token. */
const PROBE_PATH = '/api/v1/languages';

/** The JSON a cafe-grader API gives this request: a token error, or a language list. */
export function looksLikeCafeGrader(status: number, contentType: string, text: string): boolean {
  if (!/\bjson\b/i.test(contentType)) return false;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  if (status === 401) {
    const error = (body as { error?: unknown } | null)?.error;
    return typeof error === 'string' && /token/i.test(error);
  }
  if (status !== 200 || !Array.isArray(body)) return false;
  return body.every((l: { id?: unknown; name?: unknown } | null) => typeof l?.id === 'number' && typeof l?.name === 'string');
}

/**
 * One anonymous read, never retried, no credentials. This catches a mistyped
 * or wrong address; it can't prove a server is honest, since any server could
 * give the same answer.
 */
export async function checkServer(baseUrl: string, opts: ServerCheckOptions = {}): Promise<ServerCheck> {
  const api = new ApiClient(baseUrl, opts.fetch ?? ((i, init) => fetch(i, init)), opts.log ?? (() => {}), new Redactor());
  try {
    const { status, contentType, text } = await api.probe(PROBE_PATH);
    if (status === 429 || status >= 500) return { status: 'unreachable' };
    return { status: looksLikeCafeGrader(status, contentType, text) ? 'compatible' : 'incompatible' };
  } catch (err) {
    if (err instanceof RedirectRefusedError) return { status: 'incompatible' };
    if (err instanceof GraderError && !(err instanceof NetworkError)) return { status: 'incompatible' }; // a body too large to be this answer
    return { status: 'unreachable' };
  }
}
