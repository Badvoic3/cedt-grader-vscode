import { beforeEach, describe, expect, it, vi } from 'vitest';

const v = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('vscode', () => ({
  Uri: { from: (u: { scheme: string; path: string }) => u },
  commands: { executeCommand: async (...a: unknown[]) => void v.calls.push(a) },
}));

import { CompareDocs } from '../src/ui/compareDocs';

type Doc = { scheme: string; path: string };

describe('CompareDocs', () => {
  beforeEach(() => {
    v.calls = [];
  });

  it('opens the diff editor in the given column, on read-only documents of its own', async () => {
    const d = new CompareDocs();
    await d.open('Case 1', 'want\n', 'got\n', 1);
    const [command, left, right, title, opts] = v.calls[0] as [string, Doc, Doc, string, object];
    expect(command).toBe('vscode.diff');
    expect(left.scheme).toBe('cedt-grader-compare');
    expect(title).toBe('Case 1');
    expect(opts).toEqual({ viewColumn: 1, preview: true });
    expect(d.provideTextDocumentContent(left as never)).toBe('want\n');
    expect(d.provideTextDocumentContent(right as never)).toBe('got\n');
  });

  it('a second compare gets new addresses, so VS Code shows the new text', async () => {
    const d = new CompareDocs();
    await d.open('a', 'one', 'x', 1);
    await d.open('a', 'two', 'x', 1);
    const [first, second] = v.calls.map((c) => c[1] as Doc);
    expect(first.path).not.toBe(second.path);
    expect(d.provideTextDocumentContent(second as never)).toBe('two');
  });

  it('keeps a bounded number of texts, and an unknown address is empty', async () => {
    const d = new CompareDocs();
    for (let i = 0; i < 30; i++) await d.open('a', 'e', 'x', 1);
    expect(d.provideTextDocumentContent(v.calls[0][1] as never)).toBe('');
    expect(d.provideTextDocumentContent(v.calls[29][1] as never)).toBe('e');
  });
});
