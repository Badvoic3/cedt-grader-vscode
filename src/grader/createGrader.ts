import { checkServer } from './providers/cafeGrader/compat';
import { GraderClient } from './providers/cafeGrader/client';
import type { GraderProvider, GraderProviderOptions, ServerCheck, ServerCheckOptions } from './provider';

/** The one place that picks a provider. Only cafe-grader-web exists today. */
export function createGrader(opts: GraderProviderOptions = {}): GraderProvider {
  return new GraderClient(opts);
}

/** Does a supported grader answer at this address? A later provider picker starts here. */
export function checkGraderServer(baseUrl: string, opts: ServerCheckOptions = {}): Promise<ServerCheck> {
  return checkServer(baseUrl, opts);
}
