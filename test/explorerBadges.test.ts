/** The Explorer's provider: which rows get a badge, and that asking never searches or reaches the server. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const v = vi.hoisted(() => ({ findFiles: vi.fn() }));

vi.mock('vscode', () => {
  class FileDecoration {
    constructor(
      public badge?: string,
      public tooltip?: string,
      public color?: { id: string },
    ) {}
  }
  class ThemeColor {
    constructor(public id: string) {}
  }
  class EventEmitter {
    private readonly listeners = new Set<(e: unknown) => void>();
    event = (l: (e: unknown) => void) => {
      this.listeners.add(l);
      return { dispose: () => this.listeners.delete(l) };
    };
    fire(e: unknown) {
      for (const l of this.listeners) l(e);
    }
    dispose() {
      this.listeners.clear();
    }
  }
  return { FileDecoration, ThemeColor, EventEmitter, workspace: { findFiles: v.findFiles } };
});

import type * as vscode from 'vscode';
import { ExplorerBadges } from '../src/flows/explorerBadges';
import type { Host } from '../src/flows/host';
import type { Problem } from '../src/grader/types';
import { placeholder } from '../src/mapping/match';
import { TIMING } from '../src/shared/constants';

const BASE = 'https://grader.example';
const uri = (fsPath: string, scheme = 'file') => ({ fsPath, scheme }) as vscode.Uri;
const problem = (id: number, name: string, extra: Partial<Problem> = {}): Problem => ({ ...placeholder(id, name), submissionCount: 1, bestScore: 70, ...extra });

interface Link { problemId: number; folder?: boolean }

function setup(over: { links?: Record<string, Link>; above?: Record<string, Link>; unlinked?: string[]; problems?: Problem[]; loggedIn?: boolean; mode?: string; colors?: boolean } = {}) {
  const state = {
    list: { problems: over.problems ?? [problem(1, 'hw_sum'), problem(2, 'hw_prime', { bestScore: 100 }), problem(3, 'package_vector')], topics: null } as { problems: Problem[]; topics: null } | undefined,
    loggedIn: over.loggedIn ?? true,
    cfg: { baseUrl: BASE, explorerBadge: over.mode ?? 'score', explorerColors: over.colors ?? true, fileNamePattern: { pattern: '{name}.{ext}' }, displayLanguage: 'en' },
  };
  const client = new Proxy({}, { get: (_t, k) => { throw new Error(`the client was used: ${String(k)}`); } });
  const log = vi.fn();
  const host = {
    get cfg() { return state.cfg; },
    client,
    data: { problemList: () => state.list },
    languages: [],
    log,
    canShowScores: () => state.loggedIn,
    allSourceExts: () => ['cpp', 'py', 'h'],
    links: { sourceFile: (fsPath: string) => ({ fsPath, folders: fsPath.split('/').slice(1, -1) }) },
    mapping: {
      get: async (u: vscode.Uri) => over.links?.[u.fsPath],
      resolve: async (u: vscode.Uri) => {
        const own = over.links?.[u.fsPath];
        if (own && !own.folder) return { entry: own };
        const f = Object.keys(over.above ?? {}).find((p) => u.fsPath.startsWith(`${p}/`));
        return f ? { entry: over.above![f], folder: f } : undefined;
      },
      isUnlinkedHere: (u: vscode.Uri) => (over.unlinked ?? []).some((p) => u.fsPath === p || u.fsPath.startsWith(`${p}/`)),
    },
  } as unknown as Host;
  const badges = new ExplorerBadges(host);
  const fired: unknown[] = [];
  badges.onDidChangeFileDecorations((e) => fired.push(e));
  return { badges, state, fired, log };
}

const badge = async (b: ExplorerBadges, u: vscode.Uri) => (await b.provideFileDecoration(u))?.badge;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  v.findFiles.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('which rows get a badge', () => {
  it('a saved link, and it wins over the file name', async () => {
    const { badges } = setup({ links: { '/w/hw_sum.cpp': { problemId: 2 } } });
    badges.start();
    expect(await badge(badges, uri('/w/hw_sum.cpp'))).toBe('✓');
  });

  it('a file named after a problem, never opened', async () => {
    const { badges } = setup();
    badges.start();
    const d = await badges.provideFileDecoration(uri('/w/hw_sum.cpp'));
    expect(d).toMatchObject({ badge: '70', color: { id: 'cedtGrader.explorer.inProgress' } });
    expect(d?.tooltip).toContain('matched by file name');
  });

  it('a suggestion, with its number and no colour', async () => {
    const { badges } = setup();
    badges.start();
    const d = await badges.provideFileDecoration(uri('/w/hw_sum_v2.cpp'));
    expect(d?.badge).toBe('70');
    expect(d?.color).toBeUndefined();
    expect(d?.tooltip).toContain('suggested');
  });

  it('a linked folder has the badge; the files in it do not, unless they have a link of their own', async () => {
    const { badges } = setup({ links: { '/w/pkg': { problemId: 1, folder: true }, '/w/pkg/own.cpp': { problemId: 2 } }, above: { '/w/pkg': { problemId: 1, folder: true } } });
    badges.start();
    expect(await badge(badges, uri('/w/pkg'))).toBe('70');
    expect(await badge(badges, uri('/w/pkg/main.cpp'))).toBeUndefined();
    expect(await badge(badges, uri('/w/pkg/hw_prime.cpp'))).toBeUndefined();
    expect(await badge(badges, uri('/w/pkg/own.cpp'))).toBe('✓');
  });

  it('a file matched only by its folder has no badge of its own', async () => {
    const { badges } = setup();
    badges.start();
    expect(await badge(badges, uri('/w/package_vector/main.cpp'))).toBeUndefined();
  });

  describe('folders by name', () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'badges-'));
      mkdirSync(join(root, 'package_vector'));
      mkdirSync(join(root, 'package_vectors'));
      writeFileSync(join(root, 'hw_sum'), '');
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('only an exact name, and only a real folder', async () => {
      const { badges } = setup();
      badges.start();
      const d = await badges.provideFileDecoration(uri(join(root, 'package_vector')));
      expect(d?.badge).toBe('70');
      expect(d?.tooltip).toContain('matched by folder name');
      expect(await badge(badges, uri(join(root, 'package_vectors')))).toBeUndefined();
      expect(await badge(badges, uri(join(root, 'hw_sum')))).toBeUndefined(); // a compiled program
      expect(await badge(badges, uri(join(root, 'gone')))).toBeUndefined();
    });
  });

  it.each([
    ['marked "not linked"', { unlinked: ['/w/hw_sum.cpp'] }, '/w/hw_sum.cpp'],
    ['inside a folder marked "not linked"', { unlinked: ['/w/old'] }, '/w/old/hw_sum.cpp'],
    ['not a source file', {}, '/w/hw_sum.txt'],
    ['a name that matches nothing', {}, '/w/zzz.cpp'],
    ['a link to a problem no longer in the list', { links: { '/w/hw_sum.cpp': { problemId: 99 } } }, '/w/hw_sum.cpp'],
    ['logged out', { loggedIn: false }, '/w/hw_sum.cpp'],
    ['off', { mode: 'off' }, '/w/hw_sum.cpp'],
    ['an empty problem list', { problems: [] }, '/w/hw_sum.cpp'],
  ])('none: %s', async (_name, over, path) => {
    const { badges } = setup(over);
    badges.start();
    expect(await badges.provideFileDecoration(uri(path))).toBeUndefined();
  });

  it('none: another scheme, no list yet, or before `init` has finished', async () => {
    const a = setup();
    a.badges.start();
    expect(await a.badges.provideFileDecoration(uri('/w/hw_sum.cpp', 'git'))).toBeUndefined();
    a.state.list = undefined;
    expect(await a.badges.provideFileDecoration(uri('/w/hw_sum.cpp'))).toBeUndefined();
    const b = setup();
    expect(await b.badges.provideFileDecoration(uri('/w/hw_sum.cpp'))).toBeUndefined();
  });

  it('tag mode shows the tag', async () => {
    const { badges } = setup({ mode: 'tag', problems: [problem(1, 'hw_sum', { tags: ['Graph'] })] });
    badges.start();
    expect(await badge(badges, uri('/w/hw_sum.cpp'))).toBe('GR');
  });
});

describe('what it never does', () => {
  it('searches files or uses the client: asking about 500 rows touches neither', async () => {
    const { badges } = setup();
    badges.start();
    for (let i = 0; i < 500; i++) await badges.provideFileDecoration(uri(`/w/hw_sum_${i}.cpp`));
    expect(v.findFiles).not.toHaveBeenCalled(); // the client is a Proxy that throws on any use
  });

  it('breaks a row: a failure is logged and the row just has no badge', async () => {
    const { badges, state, log } = setup();
    badges.start();
    state.list = { get problems(): Problem[] { throw new Error('bad list'); }, topics: null };
    expect(await badges.provideFileDecoration(uri('/w/hw_sum.cpp'))).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bad list'));
  });
});

describe('redrawing', () => {
  const settle = () => vi.advanceTimersByTime(TIMING.badgeRefreshMs);

  it('nothing before `init` has finished, then once', () => {
    const { badges, fired } = setup();
    badges.refresh();
    badges.sync();
    settle();
    expect(fired).toEqual([]);
    badges.start();
    settle();
    expect(fired).toEqual([undefined]);
  });

  it('one redraw for a burst of link writes', () => {
    const { badges, fired } = setup();
    badges.start();
    settle();
    fired.length = 0;
    for (let i = 0; i < 50; i++) badges.refresh();
    settle();
    expect(fired).toHaveLength(1);
  });

  it('a state change redraws only when something badges depend on changed', () => {
    const { badges, state, fired } = setup();
    badges.start();
    badges.sync();
    settle();
    fired.length = 0;

    badges.sync(); // a new submission's status, a history load, …
    settle();
    expect(fired).toEqual([]);

    const changes: (() => void)[] = [
      () => { state.list = { ...state.list!, problems: [...state.list!.problems] }; }, // list reloaded, or a score after a submit
      () => { state.loggedIn = false; },
      () => { state.cfg = { ...state.cfg, explorerBadge: 'tag' }; },
      () => { state.cfg = { ...state.cfg, explorerColors: false }; },
      () => { state.cfg = { ...state.cfg, baseUrl: 'https://other.example' }; },
      () => { state.cfg = { ...state.cfg, displayLanguage: 'th' }; },
      () => { state.cfg = { ...state.cfg, fileNamePattern: { pattern: '{id}.{ext}' } }; },
    ];
    for (const change of changes) {
      fired.length = 0;
      change();
      badges.sync();
      settle();
      expect(fired).toHaveLength(1);
    }
  });

  it('stops with the extension', () => {
    const { badges, fired } = setup();
    badges.start();
    badges.dispose();
    settle();
    expect(fired).toEqual([]);
  });
});
