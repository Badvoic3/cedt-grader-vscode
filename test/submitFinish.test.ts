import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ window: {}, ProgressLocation: { Notification: 15 } }));

import { SubmitFlow } from '../src/flows/submit';
import { newResult } from '../src/flows/results';

const problem = (id: number, bestScore: number) => ({ id, name: `p${id}`, bestScore, tags: [], list: { cost: 0, rawSum: false } }) as never;
const final = (points: number) => ({ id: 9, points, compileError: false, verdicts: [{ index: 1, ok: points === 100, label: '' }] }) as never;

/** The file `key` submitted problem A, graded to `points`; meanwhile the active file moved to problem B, already full. */
async function finish(points: number, afterScore: number, finished: (...a: unknown[]) => void = () => undefined) {
  const A = problem(1, 40), B = problem(2, 100), fresh = problem(1, afterScore);
  const boundary = vi.fn(), log = vi.fn(), done = vi.fn(finished);
  const host = {
    connectionOk() {},
    data: { recordDetail() {}, afterSubmit: async () => undefined },
    currentProblem: () => B,
    problemById: (id: number) => (id === 1 ? fresh : B),
    fun: { activity() {}, boundary, finished: done },
    cfg: { revealResultAfterSubmit: false },
    folder: { targetUri: () => null },
    focus() {},
    emit() {},
    log,
  };
  const flow = new SubmitFlow(host as never);
  flow.results.set('a.cpp', newResult(A, 'grading', ''));
  const internals = flow as unknown as { poll(): Promise<unknown>; pollAndFinish(k: string, p: unknown, id: number, before: number | null): Promise<void> };
  internals.poll = async () => final(points);
  await internals.pollAndFinish('a.cpp', A, 9, 40);
  return { flow, A, boundary, log, done };
}

describe('a final verdict', () => {
  it('uses the submitted problem\'s score, not the one of the file open now', async () => {
    const { flow, A, done, boundary } = await finish(50, 50);
    expect(done).toHaveBeenCalledWith(A, final(50), 50); // not B's 100: no false first full score
    expect(flow.results.get('a.cpp')!.improvement).toContain('50');
    expect(boundary).toHaveBeenCalledWith('verdict-pass'); // A did improve, from 40 to 50
  });

  it('a failure is no task boundary, whatever the file open now has', async () => {
    const { boundary, done, A } = await finish(10, 40);
    expect(done).toHaveBeenCalledWith(A, final(10), 40);
    expect(boundary).not.toHaveBeenCalled();
  });

  it('an error in the trophy code never touches the graded result', async () => {
    const { flow, log, boundary } = await finish(100, 100, () => { throw new Error('boom'); });
    expect(log).toHaveBeenCalledWith('Trophies: boom');
    expect(flow.results.get('a.cpp')!.message).toBeFalsy();
    expect(boundary).toHaveBeenCalledWith('verdict-pass');
  });
});
