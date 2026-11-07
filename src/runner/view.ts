import { RUNNER } from '../shared/constants';
import type { TestCaseView } from '../shared/messages';
import type { Captured, CaseRun, RunnerCase } from './types';

export const capText = (text: string, max: number = RUNNER.viewTextChars): Captured =>
  text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };

export const caseView = (c: RunnerCase): TestCaseView => ({ id: c.id, source: c.source, input: capText(c.input), expected: capText(c.expected) });

/** What the Test view already has. */
export interface SentCases {
  /** Undefined: nothing sent yet. */
  key?: string | null;
  list: readonly RunnerCase[] | null;
  cases: Map<string, RunnerCase>;
  runs: Map<string, CaseRun>;
}

export const nothingSent = (): SentCases => ({ list: null, cases: new Map(), runs: new Map() });

export interface TestsDelta {
  fresh: boolean;
  order: string[];
  cases: TestCaseView[];
  runs: Record<string, CaseRun | null>;
}

/** What changed since `sent`, which it brings up to date. Another list starts over. */
export function testsDelta(sent: SentCases, key: string | null, list: readonly RunnerCase[], runs: ReadonlyMap<string, CaseRun>): TestsDelta {
  const fresh = sent.key !== key;
  if (fresh) Object.assign(sent, nothingSent(), { key });
  const cases: TestCaseView[] = [];
  if (sent.list !== list) {
    const before = sent.cases;
    sent.cases = new Map(list.map((c) => [c.id, c]));
    sent.list = list;
    for (const c of list) {
      const old = before.get(c.id);
      if (!old || old.source !== c.source || old.input !== c.input || old.expected !== c.expected) cases.push(caseView(c));
    }
  }
  const out: Record<string, CaseRun | null> = {};
  for (const id of sent.runs.keys()) {
    if (!runs.has(id)) {
      out[id] = null;
      sent.runs.delete(id);
    }
  }
  for (const [id, run] of runs) {
    if (sent.runs.get(id) !== run) {
      out[id] = run;
      sent.runs.set(id, run);
    }
  }
  return { fresh, order: list.map((c) => c.id), cases, runs: out };
}
