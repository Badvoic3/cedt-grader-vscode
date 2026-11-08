import { describe, expect, it } from 'vitest';
import { lineEnd, placeLine, plainAscii } from '../webview/break/text';

const chars = (line: string, tabSize = 4) => [...placeLine(line, tabSize)];

describe('break tab: where a line\'s characters go', () => {
  it('plain text is one column per character, and a tab goes to the next stop', () => {
    expect(plainAscii('int x;\t// y')).toBe(true);
    expect(chars('a\tb').map((q) => [q.ch, q.col, q.index])).toEqual([['a', 0, 0], ['\t', 1, 1], ['b', 4, 2]]);
    expect(chars('abcd\te').at(-1)!.col).toBe(8);
  });

  it('a Thai consonant with its vowel and tone marks stays one character', () => {
    const q = chars('น้ำ ดี่');
    expect(plainAscii('น้ำ')).toBe(false);
    expect(q.map((x) => x.ch)).toEqual(['น้ำ', ' ', 'ดี่']);
    expect(q[2].before).toBe('น้ำ ');
    expect(q[2].index).toBe('น้ำ '.length); // colours are per UTF-16 unit
  });

  it('an emoji stays whole, and it and CJK take two columns for tab stops', () => {
    const q = chars('😀\tx');
    expect(q[0].ch).toBe('😀');
    expect(q[1]).toMatchObject({ ch: '\t', col: 3, index: 2 });
    expect(q[2].col).toBe(4);
    expect(chars('漢\tx')[1].col).toBe(2);
  });

  it('the cursor\'s place uses the same rules as the characters', () => {
    expect(lineEnd('', 4)).toMatchObject({ col: 0, before: '' });
    expect(lineEnd('a\t', 4)).toMatchObject({ col: 4, before: 'a   ' });
    expect(lineEnd('น้ำ\t', 4).before).toBe('น้ำ '); // three columns for the cluster, so the tab is one space
  });
});
