import { describe, expect, it } from 'vitest';
import { confirmSuggestion, submitQuestion, type GateAnswer } from '../src/mapping/suggestionGate';

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

describe('the question before Submit', () => {
  const q = (source: string, confirmBeforeSubmit = true, answered = false) => submitQuestion({ source, confirmBeforeSubmit, answered });

  it('chosen by you (saved file or folder link): never asked, whatever the setting', () => {
    expect(q('saved')).toBeNull();
    expect(q('saved', false)).toBeNull();
  });
  it('automatic matches: asked once while "Confirm Before Submit" is on', () => {
    for (const source of ['filename', 'folder', 'cph']) {
      expect(q(source)).toBe('confirmOnce');
      expect(q(source, false)).toBeNull();
    }
  });
  it('after Submit the link is saved, so the next submit sees "saved" and asks nothing', () => {
    expect(q('filename')).toBe('confirmOnce');
    expect(q('saved')).toBeNull();
  });
  it('suggestions always ask, even with confirmations off or another question answered', () => {
    expect(q('suggested', false)).toBe('suggested');
    expect(q('suggested', true, true)).toBe('suggested');
  });
  it('another question already covered it (exam warning, which file in folder mode): not asked again', () => {
    expect(q('filename', true, true)).toBeNull();
  });
});
