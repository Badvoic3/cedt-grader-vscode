import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { needsSave, shouldRevealResult } from '../src/shared/submitOptions';
import { REPO_URL, TROUBLESHOOTING, troubleshootingUrl } from '../src/shared/constants';

const root = join(__dirname, '..');

describe('save before submit', () => {
  it('saves only an edited, saved-before file, and only when the setting is on', () => {
    expect(needsSave({ saveBeforeSubmit: true, isDirty: true, isUntitled: false })).toBe(true);
    expect(needsSave({ saveBeforeSubmit: true, isDirty: false, isUntitled: false })).toBe(false);
    expect(needsSave({ saveBeforeSubmit: false, isDirty: true, isUntitled: false })).toBe(false);
    expect(needsSave({ saveBeforeSubmit: true, isDirty: true, isUntitled: true })).toBe(false);
  });
});

describe('reveal the result', () => {
  it('only for the file that was graded, when the setting is on', () => {
    expect(shouldRevealResult({ revealResultAfterSubmit: true, gradedFile: '/a.cpp', activeFile: '/a.cpp' })).toBe(true);
    expect(shouldRevealResult({ revealResultAfterSubmit: true, gradedFile: '/a.cpp', activeFile: '/b.cpp' })).toBe(false);
    expect(shouldRevealResult({ revealResultAfterSubmit: false, gradedFile: '/a.cpp', activeFile: '/a.cpp' })).toBe(false);
  });

  it('both options are on by default', () => {
    const props = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).contributes.configuration.properties;
    expect(props['cedtGrader.saveBeforeSubmit'].default).toBe(true);
    expect(props['cedtGrader.revealResultAfterSubmit'].default).toBe(true);
  });
});

describe('troubleshooting link', () => {
  /** GitHub's heading anchors: lower case, punctuation dropped, spaces → "-" (Thai letters and marks kept). */
  const slug = (h: string) => h.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s-]/gu, '').replace(/\s/g, '-');
  const headings = (f: string) => [...readFileSync(join(root, f), 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]));

  it('points at a heading that exists in each README', () => {
    for (const lang of ['en', 'th'] as const) {
      const t = TROUBLESHOOTING[lang];
      expect(headings(t.file), `${t.file}#${t.anchor}`).toContain(t.anchor);
    }
  });

  it('is the repository URL with the anchor encoded', () => {
    expect(troubleshootingUrl('en')).toBe(`${REPO_URL}/blob/main/README.md#troubleshooting`);
    expect(troubleshootingUrl('th')).toBe(`${REPO_URL}/blob/main/README.th.md#${encodeURIComponent('การแก้ปัญหาเบื้องต้น')}`);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).repository.url).toBe(`${REPO_URL}.git`);
  });
});
