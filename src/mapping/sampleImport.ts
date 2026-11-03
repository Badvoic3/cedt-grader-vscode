import { SAMPLES } from '../shared/constants';
import type { GraderCase } from './cphImport';

/**
 * Experimental "Import sample cases from this statement": the statement
 * viewer reads the PDF's sample table (webview/sampleTables.ts) and sends the
 * cases here. Webview data is untrusted: strings only, size and count caps.
 */
export interface SampleCase {
  input: string;
  output: string;
  /** A note was removed from this case (shown in the preview; not stored). */
  annotated: boolean;
}

/** The cases of an `importSamples` message, or null when anything is off. */
export function validateSampleCases(raw: unknown): SampleCase[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > SAMPLES.maxCases) return null;
  const out: SampleCase[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') return null;
    const { input, output, annotated } = c as Record<string, unknown>;
    if (typeof input !== 'string' || typeof output !== 'string') return null;
    if (!input.trim() || input.length > SAMPLES.maxCaseChars || output.length > SAMPLES.maxCaseChars) return null;
    out.push({ input, output, annotated: annotated === true });
  }
  return out;
}

/** Cases numbered 1, 2, … (their CPH id is STATEMENT_ID_BASE + number); each text ends with one newline, `\n` line endings. */
export function sampleCasesToImport(cases: SampleCase[]): GraderCase[] {
  const text = (s: string) => `${s.replace(/\r\n?/g, '\n').replace(/\s+$/, '')}\n`;
  return cases.map((c, i) => ({ testcaseId: i + 1, num: i + 1, input: text(c.input), output: text(c.output) }));
}
