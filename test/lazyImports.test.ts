import { build, type Metafile } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

/** Packages only the web session and text statements need: they must never load during activation. */
const DEFERRED = /node_modules\/(cheerio|tough-cookie|tldts|tldts-core|markdown-it|linkify-it|htmlparser2|entities|css-select|css-what|domutils|vscode-textmate|vscode-oniguruma)\//;

const reachable = (inputs: Metafile['inputs'], start: string, kinds: string[]): Set<string> => {
  const seen = new Set([start]);
  const todo = [start];
  for (let file = todo.pop(); file !== undefined; file = todo.pop()) {
    for (const i of inputs[file]?.imports ?? []) {
      if (!kinds.includes(i.kind) || seen.has(i.path)) continue;
      seen.add(i.path);
      todo.push(i.path);
    }
  }
  return seen;
};

describe('start path', () => {
  const entry = 'src/extension.ts';
  let inputs: Metafile['inputs'];

  beforeAll(async () => {
    const r = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false, metafile: true, logLevel: 'silent' });
    inputs = r.metafile.inputs;
  });

  it('activation reaches no deferred package through a static import', () => {
    const eager = [...reachable(inputs, entry, ['import-statement', 'require-call'])];
    expect(eager.filter((f) => DEFERRED.test(f))).toEqual([]);
  });

  it('the deferred packages are still in the bundle, behind import()', () => {
    const all = [...reachable(inputs, entry, ['import-statement', 'require-call', 'dynamic-import'])];
    for (const name of ['cheerio', 'tough-cookie', 'markdown-it', 'vscode-textmate', 'vscode-oniguruma']) expect(all.some((f) => f.includes(`node_modules/${name}/`))).toBe(true);
  });
});
