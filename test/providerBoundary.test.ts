import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GraderClient } from '../src/grader/providers/cafeGrader/client';
import type { GraderProvider } from '../src/grader/provider';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Value names taken from the `src/grader` barrel; `type` imports are not code and are allowed. */
function barrelValues(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'[./]*grader(?:\/index)?'/g)) {
    if (m[1]) continue;
    for (const part of m[2].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name && !name.startsWith('type ')) names.push(name);
    }
  }
  return names;
}

/** Code that talks to "a grader" must see only the interface, never a concrete provider. */
describe('GraderProvider boundary', () => {
  const consumers = [...files('src/data'), ...files('src/flows'), ...files('src/mapping'), ...files('src/ui'), 'src/controller.ts', 'src/extension.ts', 'src/config.ts'];
  const byPath = /from '(?:\.\.?\/)+grader\/(?:providers\/|api'|web'|http'|parsers'|sanitize'|verdicts')/;
  let concrete: Set<string>;

  beforeAll(async () => {
    concrete = new Set();
    for (const f of files('src/grader/providers')) for (const name of Object.keys(await import(resolve(f)))) concrete.add(name);
  });

  it('knows what a provider exports, so the barrel check below can fail', () => {
    expect(concrete.has('GraderClient')).toBe(true);
    expect(concrete.has('parseGraderComment')).toBe(true);
    expect(barrelValues(`import {\n  parseGraderComment,\n  type Problem,\n} from '../grader';`)).toEqual(['parseGraderComment']);
    expect(barrelValues(`import type { Problem } from '../grader';`)).toEqual([]);
  });

  it('no consumer imports a provider file by path', () => {
    expect(consumers.filter((f) => byPath.test(readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('no consumer takes provider code through the barrel', () => {
    const found = consumers.flatMap((f) => barrelValues(readFileSync(f, 'utf8')).filter((n) => concrete.has(n)).map((n) => `${f}: ${n}`));
    expect(found).toEqual([]);
  });

  it('the concrete class appears only in the factory', () => {
    expect(consumers.filter((f) => /\bGraderClient\b/.test(readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('the interface file does not depend on a provider', () => {
    expect(readFileSync('src/grader/provider.ts', 'utf8')).not.toMatch(/providers\//);
  });

  it('the cafe-grader provider satisfies the interface and declares capabilities', () => {
    const p: GraderProvider = new GraderClient({ baseUrl: 'https://example.test' });
    expect(Object.keys(p.capabilities).sort()).toEqual(['attachments', 'pdfStatement', 'penaltyHtml', 'rawSumScores', 'testcases']);
    expect(p.parseVerdicts('P-').map((v) => v.ok)).toEqual([true, false]);
  });
});
