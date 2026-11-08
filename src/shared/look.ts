/** The panel's look (setting `cedtGrader.panel.look`, roadmap §7.12): no `vscode` import, so it is tested directly. */

export type LookSetting = 'subtle' | 'plain';

/** What the webviews need: `applyLook` in webview/look.ts turns it into classes on the body. */
export interface LookView {
  /** Motion, pinned headers and raised cards. */
  on: boolean;
  /** Translucent, blurred menus and tooltips. */
  frost: boolean;
  /** How solid they are, in percent (VS Code's own opacity setting). */
  frostOpacity: number;
}

export const PLAIN_LOOK: LookView = { on: false, frost: false, frostOpacity: 80 };

/** The VS Code settings that decide whether its own pop-ups are frosted. */
export interface FrostSettings {
  modernUI: unknown;
  frostedGlass: unknown;
  frostedGlassOpacity: unknown;
  reduceTransparency: unknown;
}

/**
 * Frost follows VS Code's own rule, so our pop-ups match its pop-ups: Modern UI and frosted glass both on (a build
 * without those settings has solid pop-ups, so ours stay solid too), and transparency not reduced. High Contrast and
 * the OS's reduced transparency are handled in the CSS; what a webview can't see is whether the GPU composites,
 * and `plain` is the way out for that.
 */
export function lookView(setting: unknown, vs: FrostSettings): LookView {
  if (setting === 'plain') return PLAIN_LOOK;
  const opacity = vs.frostedGlassOpacity;
  return {
    on: true,
    frost: vs.modernUI === true && vs.frostedGlass === true && vs.reduceTransparency !== 'on',
    frostOpacity: typeof opacity === 'number' && Number.isFinite(opacity) ? Math.min(100, Math.max(50, opacity)) : 80,
  };
}
