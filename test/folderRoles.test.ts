/**
 * Folder roles (run file / submit file) on synthetic packages shaped like
 * the ones the grader ships (not the course's real files).
 */
import { strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { planZip } from '../src/mapping/attachment';
import { detectFolderRoles, hasMain, includeClosure, submitFor } from '../src/mapping/folderRoles';

const M = (o: Record<string, string>) => new Map(Object.entries(o));
const DRIVER = (inc: string[], extra = '') => `${inc.map((i) => `#include "${i}"`).join('\n')}\n#include <iostream>\n${extra}\nint main() {\n  return 0;\n}\n`;

describe('run file: the program with main()', () => {
  it('finds main( after int / signed / void / auto or alone; ignores comments and strings', () => {
    expect(hasMain('int main() {}')).toBe(true);
    expect(hasMain('signed main(){}')).toBe(true);
    expect(hasMain('  main (void) {}')).toBe(true);
    expect(hasMain('// int main() {}\nvoid f();')).toBe(false);
    expect(hasMain('/* int main() */')).toBe(false);
    expect(hasMain('const char* s = "\\nint main(";')).toBe(false);
    expect(hasMain('int domain(int x);')).toBe(false);
  });

  it('only one → it; several → the one named main*; otherwise ask', () => {
    expect(detectFolderRoles(M({ 'main_dense.cpp': DRIVER(['densegraph.h']), 'densegraph.h': '// Your code here' })).run).toEqual({ file: 'main_dense.cpp', why: 'only-main' });
    expect(detectFolderRoles(M({ 'main.cpp': DRIVER([]), 'gen.cpp': 'int main(){}' })).run).toEqual({ file: 'main.cpp', why: 'main-name' });
    const two = detectFolderRoles(M({ 'main.cpp': DRIVER([]), 'main2.cpp': 'int main(){}' }));
    expect(two).toEqual({ run: null, submit: null, runCandidates: ['main.cpp', 'main2.cpp'] });
    expect(detectFolderRoles(M({ 'student.h': '// your code here' })).run).toBeNull();
  });
});

describe('submit file: the file the student edits', () => {
  it('flat package: student.h next to a provided library header', () => {
    const r = detectFolderRoles(M({ 'main.cpp': DRIVER(['priority_queue.h', 'student.h']), 'priority_queue.h': 'template <class T> class pq {};', 'student.h': '// write your code here' }));
    expect(r.submit).toEqual({ file: 'student.h', why: 'student' });
  });

  it('student.h with no stub comment still wins by name', () => {
    expect(detectFolderRoles(M({ 'main.cpp': DRIVER(['vector.h', 'student.h']), 'vector.h': '#pragma once', 'student.h': 'void f() {}' })).submit?.file).toBe('student.h');
  });

  it('reached only transitively (main.cpp → list.h → student.h)', () => {
    const files = M({ 'main.cpp': DRIVER(['list.h']), 'list.h': '#pragma once\n#include "student.h"', 'student.h': 'void go();' });
    expect(includeClosure(files, 'main.cpp')).toEqual(['list.h', 'student.h']);
    expect(detectFolderRoles(files).submit).toEqual({ file: 'student.h', why: 'student' });
  });

  it('named in the driver\'s comment ("Add your code in …") comes first', () => {
    const files = M({ 'main.cpp': DRIVER(['student.h', 'song.h'], '// Add your code in song.h'), 'student.h': '// helpers', 'song.h': 'struct song {};' });
    expect(detectFolderRoles(files).submit).toEqual({ file: 'song.h', why: 'named-in-run' });
  });

  it('no student.h: the only included file with a stub comment (next to an unstubbed header)', () => {
    const files = M({ 'main.cpp': DRIVER(['priority_queue.h', 'song.h']), 'priority_queue.h': 'class pq {};', 'song.h': 'bool operator<(...) {\n  //  you have to write something below this line\n}' });
    expect(detectFolderRoles(files).submit).toEqual({ file: 'song.h', why: 'stub' });
  });

  it('a stub-like comment in main.cpp does not make main.cpp the submit file', () => {
    const files = M({ 'main.cpp': DRIVER(['densegraph.h'], '// TODO: nothing'), 'densegraph.h': '// Your code here' });
    expect(detectFolderRoles(files).submit).toEqual({ file: 'densegraph.h', why: 'stub' });
  });

  it('two stubbed headers and no hint → ask (null)', () => {
    expect(detectFolderRoles(M({ 'main.cpp': DRIVER(['a.h', 'b.h']), 'a.h': '// your code here', 'b.h': '// your code here' })).submit).toBeNull();
  });

  it('a chosen run file gets its own submit file', () => {
    const files = M({ 'main.cpp': DRIVER(['a.h']), 'main2.cpp': DRIVER(['student.h']), 'a.h': '', 'student.h': '' });
    expect(submitFor(files, 'main2.cpp')?.file).toBe('student.h');
  });

  it('includes resolve relative to the including file, then the folder root', () => {
    const files = M({ 'src/main.cpp': DRIVER(['../lib/student.h']), 'lib/student.h': '' });
    expect(detectFolderRoles(files).submit?.file).toBe('lib/student.h');
  });
});

describe('zip layouts → roles (after planZip)', () => {
  const rolesOf = (z: Record<string, string>) => {
    const zip: Zippable = {};
    for (const [k, v] of Object.entries(z)) zip[k] = strToU8(v);
    const plan = planZip(zipSync(zip));
    const texts = new Map(plan.files.filter((f) => /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(f.rel)).map((f) => [f.rel, new TextDecoder().decode(f.data)]));
    return { rels: plan.files.map((f) => f.rel), roles: detectFolderRoles(texts) };
  };

  it('one wrapping folder, macOS junk, a Code::Blocks project, shipped binaries skipped', () => {
    const { rels, roles } = rolesOf({
      'student/main.cpp': DRIVER(['student.h']),
      'student/student.h': '//write your code here',
      'student/student.cbp': '<CodeBlocks_project_file/>',
      'student/main': '\u007fELF',
      'student/main.o': '\u007fELF',
      '__MACOSX/student/._main.cpp': 'junk',
    });
    expect(rels).toEqual(['main.cpp', 'student.cbp', 'student.h']);
    expect([roles.run?.file, roles.submit?.file]).toEqual(['main.cpp', 'student.h']);
  });

  it('signed main + densegraph.h', () => {
    const { roles } = rolesOf({ 'main_dense.cpp': '#include "densegraph.h"\nsigned main() {}', 'densegraph.h': '// Your code here' });
    expect([roles.run, roles.submit]).toEqual([{ file: 'main_dense.cpp', why: 'only-main' }, { file: 'densegraph.h', why: 'stub' }]);
  });
});
