import type { RunSummary } from '../src/runner/types';
import { W } from '../src/shared/strings';

/** The summary pill, the same in the main panel and the Test view. */
export function summaryPill(s: RunSummary): { text: string; tone: 'quiet' | 'busy' | 'bad' | 'good' } {
  switch (s.kind) {
    case 'no-cases':
      return { text: W.runNoCases, tone: 'quiet' };
    case 'not-run':
      return { text: W.runNotRun, tone: 'quiet' };
    case 'compiling':
      return { text: W.runCompiling, tone: 'busy' };
    case 'running':
      return { text: W.runRunning(s.done, s.total), tone: 'busy' };
    case 'compile-error':
      return { text: W.runCompileError, tone: 'bad' };
    case 'done':
      return { text: W.runPassed(s.passed, s.total), tone: s.passed === s.total ? 'good' : 'bad' };
  }
}
