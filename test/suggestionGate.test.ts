import { describe, expect, it } from 'vitest';
import { confirmSuggestion, type GateAnswer } from '../src/mapping/suggestionGate';

/** Simulates the active file's link: write actions (submit, load test cases) on a suggestion. */
function harness(answer: GateAnswer) {
  const state = { source: 'suggested', asked: 0, confirmed: 0, picker: 0 };
  const run = () =>
    confirmSuggestion({
      source: state.source,
      ask: async () => {
        state.asked++;
        return answer;
      },
      confirm: async () => {
        state.confirmed++;
        state.source = 'saved'; // the link is saved: "Chosen by you"
      },
      chooseAnother: async () => {
        state.picker++;
      },
    });
  return { state, run };
}

describe('write actions on a suggested match', () => {
  it('submit / load test cases ask once; yes confirms the link and is not asked again', async () => {
    const { state, run } = harness('yes');
    expect(await run()).toBe(true); // e.g. Submit
    expect(await run()).toBe(true); // e.g. Load test cases afterwards
    expect(state).toMatchObject({ asked: 1, confirmed: 1, source: 'saved' });
  });

  it('"Choose another problem" opens the picker and does nothing else', async () => {
    const { state, run } = harness('choose');
    expect(await run()).toBe(false);
    expect(state).toMatchObject({ asked: 1, confirmed: 0, picker: 1, source: 'suggested' });
  });

  it('dismissed (file switched, other question) → nothing written, asked again next time', async () => {
    const { state, run } = harness(undefined);
    expect(await run()).toBe(false);
    expect(await run()).toBe(false);
    expect(state).toMatchObject({ asked: 2, confirmed: 0 });
  });

  it('linked / name-matched problems are never asked', async () => {
    for (const source of ['saved', 'filename', 'cph']) {
      let asked = 0;
      const ok = await confirmSuggestion({ source, ask: async () => (asked++, 'yes'), confirm: async () => {}, chooseAnother: async () => {} });
      expect(ok).toBe(true);
      expect(asked).toBe(0);
    }
  });
});
