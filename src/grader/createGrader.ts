import { GraderClient } from './providers/cafeGrader/client';
import type { GraderProvider, GraderProviderOptions } from './provider';

/** The one place that picks a provider. Only cafe-grader-web exists today. */
export function createGrader(opts: GraderProviderOptions = {}): GraderProvider {
  return new GraderClient(opts);
}
