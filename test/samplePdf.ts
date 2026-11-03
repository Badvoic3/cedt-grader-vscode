/**
 * A tiny hand-built statement PDF for "Load sample cases" tests: a ruled
 * Word-style table (borders as thin filled rects) with a header row in
 * Helvetica and the cases in Courier. Standard 14 fonts, nothing embedded.
 */
export interface PdfText {
  str: string;
  x: number;
  y: number;
  font: 'F1' | 'F2';
}

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** Thin filled rects for every row line and column line of a grid. */
export function ruledGrid(xs: number[], ys: number[]): string {
  const ops: string[] = [];
  const [x0, x1] = [xs[0], xs[xs.length - 1]];
  const [top, bottom] = [ys[0], ys[ys.length - 1]];
  for (const y of ys) ops.push(`${x0} ${y - 0.25} ${x1 - x0} 0.5 re f`);
  for (const x of xs) ops.push(`${x - 0.25} ${bottom} 0.5 ${top - bottom} re f`);
  return `q 0 0 0 rg\n${ops.join('\n')}\nQ`;
}

export function buildPdf(pages: { draw?: string; texts: PdfText[] }[]): Uint8Array {
  const objs: string[] = [];
  const add = (body: string) => objs.push(body) && objs.length;
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const kids: number[] = [];
  for (const pg of pages) {
    const text = pg.texts.map((t) => `BT /${t.font} 11 Tf ${t.x} ${t.y} Td (${esc(t.str)}) Tj ET`).join('\n');
    const stream = `${pg.draw ?? ''}\n${text}\n`;
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** A statement page with a 2-case sample table (Input / Output). */
export function sampleStatementPdf(): Uint8Array {
  return buildPdf([
    {
      draw: ruledGrid([50, 250, 450], [700, 680, 630, 595]),
      texts: [
        { str: 'Write a program that adds the numbers.', x: 50, y: 760, font: 'F1' },
        { str: 'Input', x: 60, y: 686, font: 'F1' },
        { str: 'Output', x: 260, y: 686, font: 'F1' },
        { str: '3', x: 60, y: 665, font: 'F2' },
        { str: '1 2 3', x: 60, y: 652, font: 'F2' },
        { str: '6', x: 260, y: 665, font: 'F2' },
        { str: '1', x: 60, y: 615, font: 'F2' },
        { str: '5', x: 60, y: 602, font: 'F2' },
        { str: '5', x: 260, y: 615, font: 'F2' },
      ],
    },
  ]);
}
