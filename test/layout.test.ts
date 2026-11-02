import { describe, expect, it } from 'vitest';
import { normalizeSections, SECTION_IDS, visibleSections } from '../src/shared/layout';

describe('panel sections setting', () => {
  it('keeps known ids in the given order, drops unknown and duplicate ones; empty or invalid → all', () => {
    expect(normalizeSections(['problems', 'current', 'bogus', 'current'])).toEqual(['problems', 'current']);
    expect(normalizeSections([])).toEqual([...SECTION_IDS]);
    expect(normalizeSections('current')).toEqual([...SECTION_IDS]);
    expect(normalizeSections(undefined)).toEqual([...SECTION_IDS]);
  });

  it('Account comes back first while logged out; never added twice', () => {
    expect(visibleSections(['current', 'problems'], false)).toEqual(['account', 'current', 'problems']);
    expect(visibleSections(['current', 'problems'], true)).toEqual(['current', 'problems']);
    expect(visibleSections(['current', 'account'], false)).toEqual(['current', 'account']);
  });
});
