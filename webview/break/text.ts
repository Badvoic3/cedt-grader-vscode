/**
 * Where the characters of a line go, without the DOM (tested in test/breakText.test.ts). A "character" is a whole
 * grapheme: a Thai consonant with its vowel and tone marks, or an emoji, is drawn as one, as the editor shows it.
 */

const ASCII = /^[\x20-\x7e\t]*$/;
/** Characters VS Code counts as two columns when it works out tab stops. */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦\u{1f300}-\u{1faff}]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Every character has the font's one width, so columns give the position without measuring. */
export const plainAscii = (line: string): boolean => ASCII.test(line);

export interface PlacedChar {
  ch: string;
  /** UTF-16 offset in the line (colours are per UTF-16 unit). */
  index: number;
  /** Column, for tab stops. */
  col: number;
  /** The text before it with tabs as spaces: its offset in the line as the browser lays it out. */
  before: string;
}

export function* placeLine(line: string, tabSize: number): Generator<PlacedChar> {
  const parts = plainAscii(line) ? line.split('') : Array.from(graphemes.segment(line), (s) => s.segment);
  let index = 0, col = 0, before = '';
  for (const ch of parts) {
    yield { ch, index, col, before };
    index += ch.length;
    if (ch === '\t') {
      const step = tabSize - (col % tabSize);
      col += step;
      before += ' '.repeat(step);
    } else {
      col += ch.length + (WIDE.test(ch) ? 1 : 0);
      before += ch;
    }
  }
}

/** The position right after `line`, for the cursor: as if one more character followed it. */
export function lineEnd(line: string, tabSize: number): { col: number; before: string } {
  let end = { col: 0, before: '' };
  for (const q of placeLine(`${line}x`, tabSize)) end = q;
  return end;
}
