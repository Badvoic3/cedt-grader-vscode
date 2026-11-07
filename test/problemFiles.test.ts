import { describe, expect, it } from 'vitest';
import { autoAfterDelete, autoAfterRename, type AutoMatch, linkedNotice, mergeProblemFiles, noticeDismissed, noticeSignature } from '../src/mapping/problemFiles';
import { OnceCache } from '../src/mapping/matchIndex';
import { fileStem, normalizeName } from '../src/mapping/match';

const A = '/w/data algo/da68_f2_zero_one_subset_sum.cpp';
const B = '/w/i2cedt/da68_f2_zero_one_subset_sum.cpp';
const NAME = 'da68_f2_zero_one_subset_sum';
const rel = (p: string) => p.replace('/w/', '');
const base = { problemId: 1731, chosen: [] as string[], auto: [] as AutoMatch[], matched: [] as { fsPath: string; how: 'filename' | 'suggested' }[], unlinked: [] as string[], linkedElsewhere: [] as string[], caseInsensitive: false };
/** Name matches as the matcher reports them. */
const N = (...paths: string[]) => paths.map((fsPath) => ({ fsPath, how: 'filename' as const }));
const auto = (fsPath: string, problemId = 1731, how: 'filename' | 'folder' = 'filename'): AutoMatch => ({ fsPath, problemId, how, at: 1 });

describe('files for a problem (one function for notice, row click, submit check)', () => {
  it('chosen + name-matched: both listed, each with how it is linked', () => {
    const files = mergeProblemFiles({ ...base, chosen: [B], auto: [auto(A)] });
    expect(files).toEqual([
      { fsPath: A, how: 'filename' }, // path order: "data algo" before "i2cedt"
      { fsPath: B, how: 'chosen' },
    ]);
  });

  it('a never-opened name match comes from the file search', () => {
    expect(mergeProblemFiles({ ...base, chosen: [B], matched: N(A, B) })).toEqual([
      { fsPath: A, how: 'filename' },
      { fsPath: B, how: 'chosen' }, // the search hit doesn't downgrade a chosen link
    ]);
  });

  it('chosen + suggested: a suggestion (not an exact name) is never in the list', () => {
    // Suggestions aren't recorded and the search only finds exact names, so only B is there.
    const files = mergeProblemFiles({ ...base, chosen: [B], auto: [], matched: N() });
    expect(files).toHaveLength(1);
    expect(linkedNotice(files, B, rel)).toBeNull();
  });

  it('explicit "not linked" files and files linked to another problem are excluded', () => {
    expect(mergeProblemFiles({ ...base, auto: [auto(A)], matched: N(A, B), unlinked: [A] })).toEqual([{ fsPath: B, how: 'filename' }]);
    expect(mergeProblemFiles({ ...base, matched: N(A, B), linkedElsewhere: [B] })).toEqual([{ fsPath: A, how: 'filename' }]);
    // auto-matches of other problems don't count
    expect(mergeProblemFiles({ ...base, auto: [auto(A, 999)] })).toEqual([]);
  });

  it('the notice appears from BOTH files\' views (the reported repro)', () => {
    // i2cedt/… chosen; data algo/… matched by file name.
    const fromA = linkedNotice(mergeProblemFiles({ ...base, chosen: [B], auto: [auto(A)], matched: N(A, B) }), A, rel)!;
    expect(fromA.text).toBe('Another file with the same name also matches this problem.');
    expect(fromA.files.map((f) => [f.path, f.current, f.how])).toEqual([
      ['data algo/da68_f2_zero_one_subset_sum.cpp', true, 'filename'],
      ['i2cedt/da68_f2_zero_one_subset_sum.cpp', false, 'chosen'],
    ]);
    // From i2cedt/… even though data algo/… was never opened (search hit only).
    const fromB = linkedNotice(mergeProblemFiles({ ...base, chosen: [B], matched: N(A, B) }), B, rel)!;
    expect(fromB.text).toBe('Another file with the same name also matches this problem.');
    expect(fromB.files[0]).toMatchObject({ path: 'data algo/da68_f2_zero_one_subset_sum.cpp', how: 'filename', current: false });
    expect(fromB.files[1]).toMatchObject({ path: 'i2cedt/da68_f2_zero_one_subset_sum.cpp', current: true });
  });

  it('two name-matched files in different folders → same-name wording; different names → "N files are linked"', () => {
    expect(linkedNotice(mergeProblemFiles({ ...base, matched: N(A, B) }), A, rel)!.text).toBe('Another file with the same name also matches this problem.');
    const C = '/w/i2cedt/subset_sum_v2.cpp';
    expect(linkedNotice(mergeProblemFiles({ ...base, chosen: [C], matched: N(A) }), A, rel)!.text).toBe('2 files are linked to this problem');
  });
});

describe('confident suggestions count like links', () => {
  it('included by default (notice, row click, submit check); can be left out explicitly', () => {
    const S1 = '/w/hw/subset_sum_draft.cpp';
    const sug = { fsPath: S1, problemId: 1731, how: 'suggested' as const, at: 1 };
    expect(mergeProblemFiles({ ...base, chosen: [B], auto: [sug], includeSuggested: false })).toEqual([{ fsPath: B, how: 'chosen' }]);
    expect(linkedNotice(mergeProblemFiles({ ...base, chosen: [B], auto: [sug] }), S1, rel)!.text).toBe('2 files are linked to this problem');
    expect(mergeProblemFiles({ ...base, chosen: [B], auto: [sug], matched: N(A), includeSuggested: true })).toEqual([
      { fsPath: A, how: 'filename' },
      { fsPath: S1, how: 'suggested' },
      { fsPath: B, how: 'chosen' },
    ]);
    // "not linked" wins over a suggestion too
    expect(mergeProblemFiles({ ...base, auto: [sug], unlinked: [S1], includeSuggested: true })).toEqual([]);
  });
});

describe('dismissing the notice', () => {
  it('stays hidden for that problem until the set of files (or how they are linked) changes', () => {
    const two = mergeProblemFiles({ ...base, chosen: [B], matched: N(A) });
    const dismissed = { '1731': noticeSignature(two) };
    expect(noticeDismissed(dismissed, 1731, two)).toBe(true);
    expect(noticeDismissed(dismissed, 1731, [...two].reverse())).toBe(true); // order doesn't matter
    expect(noticeDismissed(dismissed, 9999, two)).toBe(false); // other problems unaffected
    // a new file appears → shown again
    const three = mergeProblemFiles({ ...base, chosen: [B], matched: N(A, '/w/hw/da68_f2_zero_one_subset_sum.cpp') });
    expect(noticeDismissed(dismissed, 1731, three)).toBe(false);
    // the name match gets linked (chosen) → shown again
    const linked = mergeProblemFiles({ ...base, chosen: [A, B] });
    expect(noticeDismissed(dismissed, 1731, linked)).toBe(false);
    // nothing to hide with fewer than two files
    expect(noticeDismissed({ '1731': noticeSignature([two[0]]) }, 1731, [two[0]])).toBe(false);
  });
});

describe('stable order', () => {
  it('switching the active file between the listed files keeps the row order identical', () => {
    const C = '/w/HW10/da68_f2_zero_one_subset_sum.cpp';
    const D = '/w/hw9/da68_f2_zero_one_subset_sum.cpp';
    const files = mergeProblemFiles({ ...base, chosen: [B], auto: [auto(A)], matched: N(C, D) });
    const orders = [A, B, C, D].map((cur) => linkedNotice(files, cur, rel)!.files.map((f) => f.path));
    for (const o of orders) expect(o).toEqual(orders[0]);
    // natural, case-insensitive: "data algo" < "hw9" < "HW10" < "i2cedt"
    expect(orders[0]).toEqual([rel(A), rel(D), rel(C), rel(B)]);
    // only the "this file" mark moves
    expect([A, B, C, D].map((cur) => linkedNotice(files, cur, rel)!.files.findIndex((f) => f.current))).toEqual([0, 3, 2, 1]);
  });
});

describe('remembered auto-matches follow renames and deletes', () => {
  // The matcher's answer for a path (here: exact name match only).
  const name = (fsPath: string, id: number) => id === 1731 && normalizeName(fileStem(fsPath)) === normalizeName(NAME);

  it('renamed to a still-matching path (moved folder): kept, path updated', () => {
    expect(autoAfterRename([auto(A)], '/w/data algo', '/w/algo', name, false)).toEqual([auto('/w/algo/da68_f2_zero_one_subset_sum.cpp')]);
  });

  it('renamed to a non-matching name: dropped', () => {
    expect(autoAfterRename([auto(A)], A, '/w/data algo/scratch.cpp', name, false)).toEqual([]);
  });

  it('unrelated entries untouched; deleted file or folder removes them', () => {
    expect(autoAfterRename([auto(B)], A, '/w/z.cpp', name, false)).toEqual([auto(B)]);
    expect(autoAfterDelete([auto(A), auto(B)], A, false)).toEqual([auto(B)]);
    expect(autoAfterDelete([auto(A), auto(B)], '/w/i2cedt', false)).toEqual([auto(A)]);
  });
});

describe('match index: computed once until a file event', () => {
  it('one findFiles for all problems; invalidate() (file created / deleted / renamed) computes again', async () => {
    let builds = 0;
    const c = new OnceCache(async () => {
      builds++;
      return new Map([[1731, [{ fsPath: A, how: 'filename' as const }]]]);
    }, () => new Map());
    expect(c.peek()).toBeUndefined();
    await Promise.all([c.get(), c.get()]); // concurrent → one build
    await c.get();
    expect(builds).toBe(1);
    expect((await c.peek())!.get(1731)).toHaveLength(1);
    c.invalidate();
    await c.get();
    expect(builds).toBe(2);
  });

  it('a failed build counts as empty (and is cached until the next file event)', async () => {
    let n = 0;
    const c = new OnceCache<Map<number, unknown>>(async () => {
      n++;
      throw new Error('boom');
    }, () => new Map());
    expect((await c.get()).size).toBe(0);
    await c.get();
    expect(n).toBe(1);
  });
});
