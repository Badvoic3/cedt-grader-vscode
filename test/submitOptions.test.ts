import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { needsSave, shouldRevealResult } from '../src/shared/submitOptions';
import { REPO_URL, TROUBLESHOOTING, troubleshootingUrl, USER_GUIDE, userGuideUrl } from '../src/shared/constants';
import { currentLang, setLanguage } from '../src/shared/i18n';

const openedUris: string[] = [];
vi.mock('vscode', () => ({
  Uri: {
    parse: (s: string) => ({ toString: () => s }),
    joinPath: (...parts: unknown[]) => ({ path: parts.map(String).join('/') }),
  },
  env: {
    openExternal: vi.fn(async (u: { toString(): string }) => {
      openedUris.push(u.toString());
      return true;
    }),
  },
}));
const { SidebarProvider } = await import('../src/ui/sidebarProvider');

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

describe('user guide ("How to use") link and walkthrough removal', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  it('points to USERGUIDE.md / USERGUIDE.th.md on GitHub', () => {
    expect(USER_GUIDE).toEqual({ en: 'USERGUIDE.md', th: 'USERGUIDE.th.md' });
    expect(userGuideUrl('en')).toBe(`${REPO_URL}/blob/main/USERGUIDE.md`);
    expect(userGuideUrl('th')).toBe(`${REPO_URL}/blob/main/USERGUIDE.th.md`);
  });

  it('contributes cedtGrader.openUserGuide in the panel ⋯ menu above Troubleshooting, with no walkthrough left', () => {
    expect(pkg.contributes.walkthroughs).toBeUndefined();
    const cmds = pkg.contributes.commands as { command: string; title: string; icon?: string }[];
    expect(cmds.find((c) => c.command === 'cedtGrader.openWalkthrough')).toBeUndefined();
    expect(cmds.find((c) => c.command === 'cedtGrader.openUserGuide')).toMatchObject({
      command: 'cedtGrader.openUserGuide',
      title: '%command.openUserGuide.title%',
      icon: '$(book)',
    });
    const help = (pkg.contributes.menus['view/title'] as { command: string; group: string }[]).filter((m) => m.group.startsWith('8_help'));
    expect(help).toEqual([
      { command: 'cedtGrader.openUserGuide', when: 'view == cedtGrader.panel', group: '8_help@1' },
      { command: 'cedtGrader.openTroubleshooting', when: 'view == cedtGrader.panel', group: '8_help@2' },
    ]);
  });

  it('dispatches openUserGuide from the panel to controller.openUserGuide and opens the guide for the display language', async () => {
    const vscode = await import('vscode');
    openedUris.length = 0;
    let receive: (m: unknown) => void = () => {};
    const controller = {
      isStarted: true,
      started: Promise.resolve(),
      onState: () => ({ dispose() {} }),
      setPanelVisible: () => {},
      openUserGuide: async () => {
        await vscode.env.openExternal(vscode.Uri.parse(userGuideUrl(currentLang()), true));
      },
      crash: { report: vi.fn() },
    };
    const sidebar = new SidebarProvider({} as never, controller as never);
    sidebar.resolveWebviewView({
      visible: true,
      onDidChangeVisibility: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} }),
      webview: {
        options: {},
        html: '',
        cspSource: 'csp',
        asWebviewUri: (u: unknown) => u,
        postMessage: () => Promise.resolve(true),
        onDidReceiveMessage: (l: (m: unknown) => void) => ((receive = l), { dispose() {} }),
      },
    } as never);

    setLanguage('en');
    receive({ type: 'openUserGuide' });
    await new Promise((r) => setTimeout(r));
    setLanguage('th');
    receive({ type: 'openUserGuide' });
    await new Promise((r) => setTimeout(r));
    setLanguage('en');

    expect(openedUris).toEqual([
      `${REPO_URL}/blob/main/USERGUIDE.md`,
      `${REPO_URL}/blob/main/USERGUIDE.th.md`,
    ]);
  });
});
