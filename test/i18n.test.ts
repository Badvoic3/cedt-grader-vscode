import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentLang, dateLocale, registerLanguage, resolveLang, setLanguage } from '../src/shared/i18n';
import { EN, G, S, type Strings, W } from '../src/shared/strings';
import { TH, TH_REVIEW } from '../src/shared/strings.th';
import { penaltyLabel } from '../src/grader/score';
import { groupLabel, parseGraderComment, verdictLegend } from '../src/grader/verdicts';

const root = join(__dirname, '..');

/** A fake "Thai" table: English with a marker, enough to see the switch. */
function marked(t: unknown): unknown {
  if (typeof t === 'string') return `[th] ${t}`;
  if (typeof t === 'function') return (...a: unknown[]) => `[th] ${(t as (...x: unknown[]) => string)(...a)}`;
  if (t && typeof t === 'object') return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, marked(v)]));
  return t;
}

afterEach(() => {
  registerLanguage('th', TH);
  setLanguage('en');
});

describe('display language', () => {
  it('resolveLang: explicit, follow VS Code, unknown', () => {
    expect(resolveLang('en', 'th')).toBe('en');
    expect(resolveLang('th', 'en-us')).toBe('th');
    expect(resolveLang('auto', 'th')).toBe('th');
    expect(resolveLang('auto', 'TH-th')).toBe('th');
    expect(resolveLang('auto', 'en-gb')).toBe('en');
    expect(resolveLang('auto', 'thx')).toBe('en');
    expect(resolveLang(undefined, 'th')).toBe('en');
  });

  it('setLanguage overwrites the live tables in place (same objects, new texts) and back', () => {
    const sRef = S;
    registerLanguage('th', marked(EN) as Strings);
    setLanguage('th');
    expect(currentLang()).toBe('th');
    expect(S).toBe(sRef);
    expect(S.common.ok).toBe('[th] OK');
    expect(W.username).toBe('[th] Username');
    expect(G.statusBar.submit).toBe('[th] Submit to Grader');
    expect(S.submit.notAccepted('C++')).toBe("[th] This problem doesn't accept C++.");
    setLanguage('en');
    expect(S.common.ok).toBe('OK');
    expect(S.submit.notAccepted('C++')).toBe("This problem doesn't accept C++.");
  });

  it('texts built by helpers follow the language at call time', () => {
    registerLanguage('th', marked(EN) as Strings);
    setLanguage('th');
    expect(parseGraderComment('P-')[1].label).toBe('[th] Test 2 of 2: [th] Wrong Answer');
    expect(verdictLegend()[1].word).toBe('[th] Correct');
    expect(groupLabel(1, 1, [{ ok: true }])).toContain('[th] Group 1 of 1');
    expect(penaltyLabel({ cost: 10, hintCount: 0, aiCount: 1 })).toBe('[th] -10 AI assist');
  });

  it('dates: English keeps the system locale, Thai uses Thai months with Gregorian years', () => {
    expect(dateLocale('en')).toBeUndefined();
    const d = new Date('2026-11-02T12:00:00+07:00').toLocaleDateString(dateLocale('th'), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });
    expect(d).toContain('2026');
    expect(d).toContain('พ.ย.');
  });
});

describe('Thai table (strings.th.ts)', () => {
  type Node = Record<string, unknown>;
  const walk = (en: unknown, th: unknown, path: string, out: { path: string; en: unknown; th: unknown }[]) => {
    if (en && typeof en === 'object') {
      expect(Object.keys(th as Node).sort(), path).toEqual(Object.keys(en as Node).sort());
      for (const k of Object.keys(en as Node)) walk((en as Node)[k], (th as Node)[k], path ? `${path}.${k}` : k, out);
    } else out.push({ path, en, th });
    return out;
  };
  const leaves = walk(EN, TH, '', []);

  it('same keys everywhere, same kind of value, no extra parameters', () => {
    for (const l of leaves) {
      expect(typeof l.th, l.path).toBe(typeof l.en);
      // Thai may ignore trailing parameters English needs for plurals (tsc checks the types).
      if (typeof l.en === 'function') expect((l.th as () => string).length, l.path).toBeLessThanOrEqual((l.en as () => string).length);
    }
  });

  it('no empty text, and every value a text shows in English also shows in Thai', () => {
    const problems: string[] = [];
    for (const l of leaves) {
      if (typeof l.en === 'string') {
        if (!(l.th as string).trim()) problems.push(`${l.path}: empty`);
        continue;
      }
      const fn = l.en as (...a: unknown[]) => string;
      const args = Array.from({ length: fn.length }, (_, i) => `«${i}»`);
      const en = fn(...args);
      const th = (l.th as (...a: unknown[]) => string)(...args);
      if (!th.trim()) problems.push(`${l.path}: empty`);
      for (const a of args) if (en.includes(a) && !th.includes(a)) problems.push(`${l.path}: ${a} missing in "${th}"`);
    }
    expect(problems).toEqual([]);
  });

  it('codicons ($(name)) are kept', () => {
    for (const l of leaves) {
      if (typeof l.en !== 'string') continue;
      for (const m of l.en.matchAll(/\$\([a-z-]+\)/g)) expect(l.th as string, l.path).toContain(m[0]);
    }
  });

  it('review list names real keys', () => {
    const paths = leaves.map((l) => l.path);
    for (const k of TH_REVIEW) expect(paths.some((p) => p === k || p.startsWith(`${k}.`)), k).toBe(true);
  });

  it('switching to Thai changes what callers read', () => {
    setLanguage('th');
    expect(S.common.cancel).toBe('ยกเลิก');
    expect(G.statusBar.submit).toBe('ส่ง');
    expect(W.ago.minAgo(3)).toBe('3 นาทีก่อน');
    setLanguage('en');
    expect(S.common.cancel).toBe('Cancel');
  });
});

describe('VS Code texts (package.nls.json)', () => {
  const pkgText = readFileSync(join(root, 'package.json'), 'utf8');
  const en = JSON.parse(readFileSync(join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
  const used = [...pkgText.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]);

  it('every %key% in package.json has an English text, and every English text is used', () => {
    expect(used.filter((k) => !en[k])).toEqual([]);
    expect(Object.keys(en).filter((k) => !used.includes(k))).toEqual([]);
  });

  it('titles and descriptions are not hard-coded in package.json', () => {
    const pkg = JSON.parse(pkgText);
    for (const c of pkg.contributes.commands) expect(c.title).toMatch(/^%.+%$/);
    for (const p of Object.values<Record<string, string>>(pkg.contributes.configuration.properties)) {
      expect(p.description ?? p.markdownDescription).toMatch(/^%.+%$/);
    }
  });

  it('package.nls.th.json has exactly the English keys, no empty text, and its walkthrough pages exist', () => {
    const th = JSON.parse(readFileSync(join(root, 'package.nls.th.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(th).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(th)) {
      expect(v.trim(), k).not.toBe('');
      if (k.endsWith('.media')) expect(existsSync(join(root, v)), v).toBe(true);
      // Command links in walkthrough steps stay the same.
      expect([...v.matchAll(/\(command:[^)]+\)/g)].map((m) => m[0]), k).toEqual([...en[k].matchAll(/\(command:[^)]+\)/g)].map((m) => m[0]));
    }
  });

  it('the language setting offers English, Thai and Follow VS Code', () => {
    const p = JSON.parse(pkgText).contributes.configuration.properties['cedtGrader.displayLanguage'];
    expect(p.enum).toEqual(['en', 'th', 'auto']);
    expect(p.default).toBe('en');
  });
});

describe('no hard-coded messages outside strings.ts', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  const src = [...files(join(root, 'src')), ...files(join(root, 'webview'))].filter((f) => !/strings(\.\w+)?\.ts$/.test(f));

  it('notifications, progress titles, status bar texts and quick-pick titles come from the string tables', () => {
    const offenders: string[] = [];
    const patterns = [
      /show(Information|Warning|Error)Message\(\s*['"`][A-Za-z]/,
      /title:\s*['"`][A-Za-z][a-z]+ /,
      /placeHolder:\s*['"`][A-Za-z]/,
      /\.text\s*=\s*['"`](\$\([^)]*\)\s*)?[A-Za-z]/,
      /reason\s*=\s*['"`][A-Za-z]/,
    ];
    for (const f of src) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (patterns.some((re) => re.test(line))) offenders.push(`${f.slice(root.length + 1)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('READMEs', () => {
  const read = (f: string) => readFileSync(join(root, f), 'utf8');
  it('each README links to the other language at the top', () => {
    expect(read('README.md').split('\n').slice(0, 4).join('\n')).toContain('[ภาษาไทย](README.th.md)');
    expect(read('README.th.md').split('\n').slice(0, 4).join('\n')).toContain('[English](README.md)');
  });
  it('every picture exists, has alt text, and the Thai README uses the Thai pictures', () => {
    for (const f of ['README.md', 'README.th.md']) {
      const imgs = [...read(f).matchAll(/<img src="([^"]+)"[^>]*alt="([^"]+)"/g)];
      expect(imgs.length, f).toBeGreaterThan(5);
      for (const [, src, alt] of imgs) {
        expect(existsSync(join(root, src)), src).toBe(true);
        expect(alt.length, src).toBeGreaterThan(20);
        expect(src.endsWith('.th.png'), src).toBe(f === 'README.th.md');
      }
    }
  });
  it('both READMEs and the pictures are packaged; links are rewritten to the public GitHub repo (the Marketplace needs web addresses)', () => {
    const ignore = read('.vscodeignore');
    for (const line of ['!README.md', '!README.th.md', '!media/readme/**']) expect(ignore).toContain(line);
    const pkg = JSON.parse(read('package.json'));
    for (const script of [pkg.scripts.package, pkg.scripts.publish]) expect(script).not.toContain('--no-rewrite-relative-links');
    expect(pkg.repository.url).toMatch(/^https:\/\/github\.com\//);
    expect(pkg.private).toBeUndefined();
  });
});
