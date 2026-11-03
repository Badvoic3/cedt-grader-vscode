import type { SampleCase } from '../data/sampleTables';
import type { GraderCase } from './testCases';

/** Statement cases numbered 1, 2, … (their CPH id is STATEMENT_ID_BASE + number); each text ends with one newline, `\n` line endings. */
export function sampleCasesToImport(cases: SampleCase[]): GraderCase[] {
  const text = (s: string) => `${s.replace(/\r\n?/g, '\n').replace(/\s+$/, '')}\n`;
  return cases.map((c, i) => ({ testcaseId: i + 1, num: i + 1, input: text(c.input), output: text(c.output) }));
}
