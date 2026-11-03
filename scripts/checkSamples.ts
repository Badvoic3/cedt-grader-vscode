/*
 * Local check of "Load sample cases" on real statement PDFs, through the host
 * code path (src/data/pdfSamples.ts with the pdf.js files the build copies to
 * dist/pdfjs and media/dist/pdfjs: run `npm run build` first). Not part of `npm test` (course PDFs
 * are never committed). Reads only local files.
 *
 *   npx tsx scripts/checkSamples.ts <dir with *.pdf> [expected.json]
 *
 * expected.json: { "<pdf file stem>": [{ page, cases: [{ input, output, annotated }] }] }
 */
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pdfjsLoader, readSampleTables } from '../src/data/pdfSamples';
import type { SampleTable } from '../src/data/sampleTables';

const [dir, expectedPath] = process.argv.slice(2);
if (!dir) {
  console.error('usage: npx tsx scripts/checkSamples.ts <dir> [expected.json]');
  process.exit(2);
}
const expected: Record<string, SampleTable[]> | null = expectedPath ? JSON.parse(readFileSync(expectedPath, 'utf8')) : null;
async function main(): Promise<number> {
  const pdfjs = await pdfjsLoader(join(__dirname, '..', 'dist', 'pdfjs'), join(__dirname, '..', 'media', 'dist', 'pdfjs'))();
  const files = readdirSync(dir!)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort();
  let withCases = 0;
  let cases = 0;
  let mismatches = 0;
  let slowest = 0;
  const started = Date.now();
  for (const f of files) {
    const t0 = Date.now();
    const got = await readSampleTables(new Uint8Array(readFileSync(join(dir!, f))), pdfjs);
    const ms = Date.now() - t0;
    slowest = Math.max(slowest, ms);
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
    console.log(`${stem.padEnd(14)} tables=${got.length} cases=${n} ${String(ms).padStart(5)} ms ${mark}`);
  }
  console.log(`\n${withCases}/${files.length} PDFs with sample cases, ${cases} cases${expected ? `, ${mismatches} mismatch(es)` : ''}`);
  console.log(`total ${Date.now() - started} ms, slowest PDF ${slowest} ms`);
  return mismatches ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
