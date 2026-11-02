import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentLang, dateLocale, registerLanguage, resolveLang, setLanguage } from '../src/shared/i18n';
import { EN, G, S, type Strings, W } from '../src/shared/strings';
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

afterEach(() => setLanguage('en'));

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

  it('dates: English keeps the system locale, Thai uses th-TH', () => {
    expect(dateLocale('en')).toBeUndefined();
    expect(dateLocale('th')).toBe('th-TH');
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
