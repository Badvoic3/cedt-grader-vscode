import { describe, expect, it } from 'vitest';
import { planRename } from '../src/mapping/mappingOps';
import { autoAfterRename } from '../src/mapping/problemFiles';
import { freeName, invalidFileName, nameMatchesProblem, renameProposal, withSuffix } from '../src/mapping/renameToProblem';

describe('rename file to match the problem', () => {
  it('proposes "<clean problem name>.<current extension>"', () => {
    expect(renameProposal('/w/hw/sol.cpp', '00_​Intro_11')).toBe('00_Intro_11.cpp'); // zero-width removed
    expect(renameProposal('/w/main.PY', 'hw03_binary_search')).toBe('hw03_binary_search.PY');
    expect(renameProposal('/w/Makefile', 'p1')).toBe('p1');
  });

  it('Thai and space names: kept (NFC), path characters replaced; matching ignores separators / NFD', () => {
    expect(renameProposal('/w/a.cpp', 'โจทย์ ข้อ 1')).toBe('โจทย์ ข้อ 1.cpp');
    expect(renameProposal('/w/a.cpp', 'a/b: c')).toBe('a_b_ c.cpp');
    const nfd = 'café ข้อ 1'.normalize('NFD');
    expect(renameProposal('/w/a.cpp', nfd)).toBe('café ข้อ 1.cpp'.normalize('NFC'));
    expect(nameMatchesProblem(`/w/${'café_ข้อ-1'.normalize('NFD')}.cpp`, 'café ข้อ 1')).toBe(true);
    expect(nameMatchesProblem('/w/00 intro-11.CPP', '00_Intro_11')).toBe(true); // action hidden: already matches
    expect(nameMatchesProblem('/w/sol.cpp', '00_Intro_11')).toBe(false); // action shown
  });

  it('never overwrites: "<name>_2.<ext>", "_3", … when taken', async () => {
    const taken = new Set(['00_Intro_11.cpp', '00_Intro_11_2.cpp']);
    expect(await freeName('00_Intro_11.cpp', (n) => taken.has(n))).toBe('00_Intro_11_3.cpp');
    expect(await freeName('free.cpp', (n) => taken.has(n))).toBe('free.cpp');
    expect(withSuffix('โจทย์ ข้อ 1.cpp', 2)).toBe('โจทย์ ข้อ 1_2.cpp');
    expect(await freeName('x.cpp', async (n) => n === 'x.cpp')).toBe('x_2.cpp'); // async checks (fs)
  });

  it('typed names: no folders or reserved characters', () => {
    expect(invalidFileName('  ')).toBe('empty');
    expect(invalidFileName('a/b.cpp')).toBe('separator');
    expect(invalidFileName('a:b.cpp')).toBe('reserved');
    expect(invalidFileName('โจทย์ ข้อ 1.cpp')).toBeNull();
  });

  it('the rename keeps the link (WorkspaceEdit.renameFile → onDidRenameFiles → the same move logic)', () => {
    const entries = [{ fsPath: '/w/hw/sol.cpp', entry: { problemId: 1360, name: '00_Intro_11' } }];
    expect(planRename(entries, '/w/hw/sol.cpp', '/w/hw/00_Intro_11.cpp', false)).toEqual([
      { from: '/w/hw/sol.cpp', to: '/w/hw/00_Intro_11.cpp', entry: { problemId: 1360, name: '00_Intro_11' } },
    ]);
    // a remembered suggestion follows only if the matcher agrees for the new name
    const auto = [{ fsPath: '/w/hw/intro11.cpp', problemId: 1360, how: 'suggested' as const, at: 1 }];
    expect(autoAfterRename(auto, '/w/hw/intro11.cpp', '/w/hw/00_Intro_11.cpp', (_p, id) => id === 1360, false)).toEqual([
      { ...auto[0], fsPath: '/w/hw/00_Intro_11.cpp' },
    ]);
  });
});
