const FOCUS_PANEL = 'cedtGrader.panel.focus';

/**
 * The panel's default place is a side bar that starts closed, so it is shown
 * each time a window starts. This only reveals: VS Code keeps wherever the user
 * put the panel, and the typing cursor stays where it is.
 */
export async function revealPanelOnStart(enabled: boolean, alreadyVisible: boolean, run: (command: string, options: { preserveFocus: boolean }) => Thenable<unknown>): Promise<void> {
  if (enabled && !alreadyVisible) await run(FOCUS_PANEL, { preserveFocus: true });
}
