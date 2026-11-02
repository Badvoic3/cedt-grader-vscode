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
