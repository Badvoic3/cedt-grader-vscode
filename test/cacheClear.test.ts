import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLEAR_DEFAULTS, CLEAR_ORDER, type ClearCategory, keepIds, planClear } from '../src/data/cacheClear';
import { KEYS } from '../src/shared/stateKeys';

const WS = [
  'cedtGrader.problems.v2:https://g:s',
  'cedtGrader.problems:https://g:old',
  KEYS.mappings,
  KEYS.legacyMapping,
  KEYS.unlinked,
  KEYS.autoMatches,
  KEYS.dismissedNotices,
  KEYS.dismissedReconnects,
  KEYS.recentlyOpened,
  KEYS.languageByFile,
  KEYS.problemFilter,
];
const GL = [KEYS.statementView, KEYS.mappings, KEYS.unlinked, KEYS.lastCleanup, KEYS.rememberPassword, KEYS.backups];
const present = { workspace: WS, global: GL };
const plan = (...c: ClearCategory[]) => planClear(new Set(c), present);

describe('Clear Cached Data: what each checkbox removes', () => {
  it('defaults: downloaded files and lists on; links, login, backups off', () => {
    expect(CLEAR_ORDER.filter((c) => CLEAR_DEFAULTS[c])).toEqual(['files', 'lists']);
  });

  it('your own test cases: off by default, and only that', () => {
    expect(CLEAR_DEFAULTS.custom).toBe(false);
    expect(plan('custom')).toMatchObject({ cacheFiles: false, customCases: true, resetData: false, workspaceKeys: [], globalKeys: [] });
  });

  it('downloaded files: cache files, statement view state, nothing else', () => {
    expect(plan('files')).toEqual({
      cacheFiles: true, customCases: false, resetData: false, staleLinks: false, allLinks: false, logout: false,
      workspaceKeys: [], globalKeys: [KEYS.statementView],
    });
  });

  it('lists: problem lists, auto-matches, "not linked", notices, recently opened, stale links; links kept', () => {
    const p = plan('lists');
    expect(p).toMatchObject({ cacheFiles: false, resetData: true, staleLinks: true, allLinks: false, logout: false });
    expect(p.workspaceKeys).toEqual(
      ['cedtGrader.problems.v2:https://g:s', 'cedtGrader.problems:https://g:old', KEYS.autoMatches, KEYS.dismissedNotices, KEYS.dismissedReconnects, KEYS.recentlyOpened, KEYS.unlinked].sort(),
    );
    expect(p.globalKeys).toEqual([KEYS.unlinked]);
    expect(p.workspaceKeys).not.toContain(KEYS.mappings);
  });

  it('links: every link of this window (the store) and per-file languages', () => {
    const p = plan('links');
    expect(p).toMatchObject({ allLinks: true, staleLinks: false, resetData: false });
    expect(p.workspaceKeys).toEqual([KEYS.languageByFile]);
    expect(p.globalKeys).toEqual([]);
  });

  it('login is a flag only', () => {
    expect(plan('login')).toMatchObject({ logout: true, workspaceKeys: [], globalKeys: [] });
  });

  it('never clears settings-like state (filter, remember, cleanup time, what was imported)', () => {
    const all = plan(...CLEAR_ORDER);
    for (const k of [KEYS.problemFilter, KEYS.linksImported]) expect(all.workspaceKeys).not.toContain(k);
    for (const k of [KEYS.rememberPassword, KEYS.lastCleanup, KEYS.backups]) expect(all.globalKeys).not.toContain(k);
  });

  it('only keys that exist are listed', () => {
    expect(planClear(new Set(['lists']), { workspace: [], global: [] })).toMatchObject({ workspaceKeys: [], globalKeys: [] });
  });

  it('every stored key name comes from stateKeys.ts', () => {
    const src = join(__dirname, '..', 'src');
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts') && !f.endsWith('stateKeys.ts'));
    expect(files.length).toBeGreaterThan(40);
    for (const f of files) {
      expect(readFileSync(join(src, f), 'utf8'), f).not.toMatch(/'cedtGrader\.(mappings?|unlinked|autoMatches|dismissed\w*|recentlyOpened|languageByFile|statementView|problems|backups|lastMappingCleanup|testcaseTarget|problemFilter|cphTipDismissed|cphAutoShowDismissed|rememberPassword|lastNewFileLanguage)\b/);
    }
  });
});

describe('statement view state', () => {
  it('keepIds keeps statement view state of cached statements only', () => {
    expect(keepIds({ '1': 'a', '2': 'b', x: 'c' }, new Set([2]))).toEqual({ '2': 'b' });
  });
});
