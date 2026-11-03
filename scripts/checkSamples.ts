/*
 * Local check of the experimental sample-table reader on real statement PDFs.
 * Not part of `npm test` (course PDFs are never committed). Reads only local files.
 *
 *   npx tsx scripts/checkSamples.ts <dir with *.pdf> [expected.json]
 *
 * expected.json: { "<pdf file stem>": [{ page, cases: [{ input, output, annotated }] }] }
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractSampleTables } from '../webview/sampleExtract';
import type { SampleTable } from '../webview/sampleTables';

const [dir, expectedPath] = process.argv.slice(2);
if (!dir) {
  console.error('usage: npx tsx scripts/checkSamples.ts <dir> [expected.json]');
  process.exit(2);
}
const expected: Record<string, SampleTable[]> | null = expectedPath ? JSON.parse(readFileSync(expectedPath, 'utf8')) : null;
async function main(): Promise<number> {
  const files = readdirSync(dir!)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort();
  let withCases = 0;
  let cases = 0;
  let mismatches = 0;
  for (const f of files) {
    const doc = await getDocument({ data: new Uint8Array(readFileSync(join(dir!, f))), isEvalSupported: false, verbosity: 0 }).promise;
    const got = await extractSampleTables(doc as never, OPS);
    await doc.destroy();
    const n = got.reduce((a, t) => a + t.cases.length, 0);
    if (n) withCases++;
    cases += n;
    const stem = basename(f, '.pdf');
    let mark = '';
    if (expected) {
      const want = expected[stem] ?? [];
      const same = JSON.stringify(got) === JSON.stringify(want);
      if (!same) mismatches++;
      mark = same ? 'ok' : `MISMATCH (expected ${want.reduce((a, t) => a + t.cases.length, 0)} cases)`;
    }
    console.log(`${stem.padEnd(14)} tables=${got.length} cases=${n} ${mark}`);
  }
  console.log(`\n${withCases}/${files.length} PDFs with sample cases, ${cases} cases${expected ? `, ${mismatches} mismatch(es)` : ''}`);
  return mismatches ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
