import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GraderClient } from '../src/grader/providers/cafeGrader/client';
import type { GraderProvider } from '../src/grader/provider';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Code that talks to "a grader" must see only the interface, never a concrete provider. */
describe('GraderProvider boundary', () => {
  const consumers = [...files('src/data'), ...files('src/flows'), ...files('src/mapping'), 'src/controller.ts', 'src/config.ts'];
  const concrete = /from '(?:\.\.?\/)+grader\/(?:providers\/|client'|api'|web'|http'|parsers'|sanitize'|verdicts')/;

  it('controller, data, flows and mapping import no concrete provider', () => {
    const offenders = consumers.filter((f) => concrete.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('nothing uses the GraderClient class outside src/grader', () => {
    const offenders = consumers.filter((f) => /\bGraderClient\b/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the cafe-grader provider satisfies the interface and declares capabilities', () => {
    const p: GraderProvider = new GraderClient({ baseUrl: 'https://example.test' });
    expect(Object.keys(p.capabilities).sort()).toEqual(['attachments', 'pdfStatement', 'penaltyHtml', 'rawSumScores', 'testcases']);
  });
});
