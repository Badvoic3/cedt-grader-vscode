/**
 * Zoom input for the statement viewer (pure, unit tested).
 * Trackpad pinch arrives in Chromium as `wheel` events with `ctrlKey = true`.
 */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 5;

export interface WheelLike {
  ctrlKey: boolean;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages. */
  deltaMode: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}

/** Scale factor for one wheel event: smooth (exponential), symmetric for in/out. */
export function wheelZoomFactor(e: Pick<WheelLike, 'deltaY' | 'deltaMode'>): number {
  const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  return Math.exp(-Math.max(-100, Math.min(100, px)) / 100);
}

/**
 * Handle a wheel event: pinch / Ctrl+wheel zooms around the cursor and is
 * swallowed (so VS Code's own window zoom doesn't react); other wheels scroll.
 */
export function handleZoomWheel(e: WheelLike, zoomAt: (factor: number, origin: [number, number]) => void): boolean {
  if (!e.ctrlKey) return false;
  e.preventDefault();
  zoomAt(wheelZoomFactor(e), [e.clientX, e.clientY]);
  return true;
}

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Cmd/Ctrl + / - / 0 → zoom in / out / reset (fit width). */
export function zoomKey(e: { metaKey: boolean; ctrlKey: boolean; key: string }): 'in' | 'out' | 'reset' | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  if (e.key === '=' || e.key === '+') return 'in';
  if (e.key === '-' || e.key === '_') return 'out';
  if (e.key === '0') return 'reset';
  return null;
}
