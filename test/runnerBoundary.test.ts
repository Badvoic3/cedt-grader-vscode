import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('src/runner', () => {
  it('has no vscode import, so every piece is unit tested directly', () => {
    const dir = join(__dirname, '..', 'src', 'runner');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/from 'vscode'|require\('vscode'\)/);
  });
});
