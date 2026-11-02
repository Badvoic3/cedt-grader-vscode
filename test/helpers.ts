import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const FIXTURES = resolve(__dirname, 'fixtures');

export function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), 'utf8');
}

/** Real (sanitized) fixture if the probe saved one, else null. */
export function realFixture(name: string): string | null {
  const p = resolve(FIXTURES, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** During the contest window used by the synthetic contest fixtures (13:00–16:00 +07:00). */
export const DURING_CONTEST = new Date('2026-11-02T14:00:00+07:00');
export const AFTER_CONTEST = new Date('2026-11-02T18:00:00+07:00');

/**
 * package.json with every `%key%` replaced from package.nls.json (or
 * package.nls.<lang>.json, falling back to English per key), as VS Code shows it.
 */
export function manifest(lang?: string): Record<string, any> {
  const root = resolve(__dirname, '..');
  const en = JSON.parse(readFileSync(resolve(root, 'package.nls.json'), 'utf8')) as Record<string, string>;
  const local = lang ? (JSON.parse(readFileSync(resolve(root, `package.nls.${lang}.json`), 'utf8')) as Record<string, string>) : {};
  const sub = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = /^%([^%]+)%$/.exec(v);
      return m ? (local[m[1]] ?? en[m[1]] ?? v) : v;
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return sub(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))) as Record<string, any>;
}
