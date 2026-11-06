import { KEYS } from '../shared/stateKeys';

const FOCUS_PANEL = 'cedtGrader.panel.focus';
const FOCUS_EDITOR = 'workbench.action.focusActiveEditorGroup';

interface Flags {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * The panel's default place can be a side bar that is closed, with no icon to
 * click, so it is shown once per profile. This only reveals: VS Code keeps
 * wherever the user put the panel. The typing cursor goes back to the editor,
 * and the flag is set after it worked, so a failure tries again next time.
 */
export async function revealPanelOnce(flags: Flags, alreadyVisible: boolean, run: (command: string) => Thenable<unknown>): Promise<void> {
  if (flags.get(KEYS.panelRevealed, false)) return;
  if (!alreadyVisible) {
    await run(FOCUS_PANEL);
    await run(FOCUS_EDITOR);
  }
  await flags.update(KEYS.panelRevealed, true);
}
