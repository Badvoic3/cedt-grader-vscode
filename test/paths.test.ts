import { describe, expect, it } from 'vitest';
import { countDuplicateEntries, lookup, parseMappingFile, reverseIndex, serializeMappingFile } from '../src/mapping/mappingFile';
import { reconnectCandidates } from '../src/mapping/mappingOps';
import { normalizeRelPath, pathKey, remapPath } from '../src/mapping/paths';

const samePath = (a: string, b: string, ci: boolean) => pathKey(a, ci) === pathKey(b, ci);

const THAI_NFC = 'โจทย์ข้อ1.cpp'.normalize('NFC');
const THAI_NFD = 'โจทย์ข้อ1.cpp'.normalize('NFD');
// Thai has few decomposable characters; use one that really differs between NFC and NFD too.
const ACCENT_NFC = 'café_ข้อ1.cpp'.normalize('NFC');
const ACCENT_NFD = 'café_ข้อ1.cpp'.normalize('NFD');

describe('one path normalization', () => {
  it('"./x.cpp" vs "x.cpp", "a/./b", "a/../a/b", backslashes, trailing slash', () => {
    expect(normalizeRelPath('./x.cpp')).toBe('x.cpp');
    expect(normalizeRelPath('././x.cpp')).toBe('x.cpp');
    expect(normalizeRelPath('a/./b.cpp')).toBe('a/b.cpp');
    expect(normalizeRelPath('a/../a/b.cpp')).toBe('a/b.cpp');
    expect(normalizeRelPath('a\\b\\c.cpp')).toBe('a/b/c.cpp');
    expect(normalizeRelPath('hw/')).toBe('hw');
  });

  it('Unicode NFD (macOS) and NFC names are the same file', () => {
    expect(ACCENT_NFC).not.toBe(ACCENT_NFD);
    expect(normalizeRelPath(ACCENT_NFD)).toBe(ACCENT_NFC);
    expect(samePath(`hw/${ACCENT_NFD}`, `hw/${ACCENT_NFC}`, false)).toBe(true);
    expect(samePath(`hw/${THAI_NFD}`, `hw/${THAI_NFC}`, false)).toBe(true);
  });

  it('case differences match only on case-insensitive file systems (macOS default)', () => {
    expect(samePath('HW/Sol.cpp', 'hw/sol.cpp', true)).toBe(true);
    expect(samePath('HW/Sol.cpp', 'hw/sol.cpp', false)).toBe(false);
    expect(pathKey('/Users/S/Hw/A.cpp', true)).toBe('/users/s/hw/a.cpp');
  });

  it('remapPath: folder prefixes, NFD and case', () => {
    expect(remapPath('/w/hw/a.cpp', '/w/hw', '/w/homework', false)).toBe('/w/homework/a.cpp');
    expect(remapPath('/w/hw2/a.cpp', '/w/hw', '/w/homework', false)).toBeNull(); // not a prefix match
    expect(remapPath('/w/HW/a.cpp', '/w/hw', '/w/x', true)).toBe('/w/x/a.cpp');
    expect(remapPath('/w/HW/a.cpp', '/w/hw', '/w/x', false)).toBeNull();
    expect(remapPath(`/w/${ACCENT_NFD}`, `/w/${ACCENT_NFC}`, '/w/b.cpp', false)).toBe('/w/b.cpp');
    expect(remapPath('/w/./hw/a.cpp', '/w/hw', '/w/x', false)).toBe('/w/x/a.cpp');
  });
});

describe('.cedt-grader.json uses it everywhere', () => {
  const text = (files: Record<string, number>) => JSON.stringify({ version: 1, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { problemId: v, name: `p${v}` }])) });

  it('"./x.cpp" and "x.cpp" are one entry; cleanup really rewrites to one key', () => {
    const raw = text({ './x.cpp': 1, 'x.cpp': 2 });
    expect(countDuplicateEntries(raw)).toBe(1);
    const cleaned = serializeMappingFile(parseMappingFile(raw));
    expect(Object.keys(JSON.parse(cleaned).files)).toEqual(['x.cpp']);
    expect(JSON.parse(cleaned).files['x.cpp'].problemId).toBe(2); // the later entry wins, like JSON.parse
    expect(countDuplicateEntries(cleaned)).toBe(0); // fixed for real
  });

  it('NFD and NFC Thai/accented names collapse; lookups match either spelling', () => {
    const raw = text({ [`hw/${ACCENT_NFD}`]: 1, [`hw/${ACCENT_NFC}`]: 1 });
    expect(countDuplicateEntries(raw)).toBe(1);
    const d = parseMappingFile(raw);
    expect(Object.keys(d.files)).toEqual([`hw/${ACCENT_NFC}`]);
    expect(lookup(d, `hw/${ACCENT_NFD}`, 'https://x')?.problemId).toBe(1);
  });

  it('case differences collapse on macOS (case-insensitive)', () => {
    const raw = text({ 'HW/Sol.cpp': 1, 'hw/sol.cpp': 2 });
    const ci = process.platform === 'darwin' || process.platform === 'win32';
    expect(countDuplicateEntries(raw)).toBe(ci ? 1 : 0);
    expect(lookup(parseMappingFile(raw), 'hw/SOL.cpp', 'https://x') !== undefined).toBe(ci);
  });

  it('reverse lookup and reconnect use the same normalization', () => {
    const d = parseMappingFile(text({ './a/x.cpp': 7 }));
    expect(reverseIndex(d, 'https://x').get(7)).toEqual(['a/x.cpp']);
  });

  it('reconnect matches a moved NFD-named file by its NFC name', async () => {
    const c = await reconnectCandidates([{ fsPath: `/old/${ACCENT_NFD}`, entry: { problemId: 1, name: 'p' } }], `/new/${ACCENT_NFC}`, async () => false);
    expect(c).toHaveLength(1);
  });
});
