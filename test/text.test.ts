import { describe, expect, it } from 'vitest';
import { menuLabelMax, middleEllipsis } from '../webview/text';

describe('middleEllipsis', () => {
  it('keeps start and end, cuts the middle', () => {
    const s = 'Link to da68_f2_zero_one_subset_sum.cpp';
    const t = middleEllipsis(s, 28);
    expect(t).toHaveLength(28);
    expect(t.startsWith('Link to da68')).toBe(true);
    expect(t.endsWith('_sum.cpp')).toBe(true);
    expect(t).toContain('…');
  });
  it('short text unchanged', () => expect(middleEllipsis('Open statement', 28)).toBe('Open statement'));
  it('menu width follows the panel (260 px → ~28 chars, capped at 420 px)', () => {
    expect(menuLabelMax(260)).toBe(28);
    expect(menuLabelMax(2000)).toBe(menuLabelMax(420));
  });
});
