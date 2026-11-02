import { describe, expect, it } from 'vitest';
import { clampScale, handleZoomWheel, MAX_SCALE, MIN_SCALE, wheelZoomFactor, zoomKey } from '../webview/zoom';

const wheel = (over: Partial<{ ctrlKey: boolean; deltaY: number; deltaMode: number }>) => {
  const e = { ctrlKey: false, deltaY: 0, deltaMode: 0, clientX: 120, clientY: 80, prevented: false, preventDefault() { this.prevented = true; }, ...over };
  return e;
};

describe('pinch zoom (Ctrl+wheel)', () => {
  it('ctrlKey wheel → zoom around the cursor, default prevented (VS Code zoom does not react)', () => {
    const calls: [number, [number, number]][] = [];
    const e = wheel({ ctrlKey: true, deltaY: -10 });
    expect(handleZoomWheel(e, (f, o) => calls.push([f, o]))).toBe(true);
    expect(e.prevented).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeGreaterThan(1); // pinch out → zoom in
    expect(calls[0][1]).toEqual([120, 80]);
  });

  it('plain wheel scrolls (not handled, not prevented)', () => {
    const e = wheel({ ctrlKey: false, deltaY: 30 });
    expect(handleZoomWheel(e, () => { throw new Error('no zoom'); })).toBe(false);
    expect(e.prevented).toBe(false);
  });

  it('smooth and symmetric; line/page delta modes; large deltas capped', () => {
    expect(wheelZoomFactor({ deltaY: 10, deltaMode: 0 }) * wheelZoomFactor({ deltaY: -10, deltaMode: 0 })).toBeCloseTo(1, 10);
    expect(wheelZoomFactor({ deltaY: 1, deltaMode: 1 })).toBeCloseTo(wheelZoomFactor({ deltaY: 16, deltaMode: 0 }), 10);
    expect(wheelZoomFactor({ deltaY: 10_000, deltaMode: 0 })).toBeCloseTo(Math.exp(-1), 10);
  });

  it('scale is clamped', () => {
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(clampScale(0.01)).toBe(MIN_SCALE);
  });
});

describe('zoom keys', () => {
  it('Cmd/Ctrl + / - / 0', () => {
    expect(zoomKey({ metaKey: true, ctrlKey: false, key: '=' })).toBe('in');
    expect(zoomKey({ metaKey: false, ctrlKey: true, key: '+' })).toBe('in');
    expect(zoomKey({ metaKey: true, ctrlKey: false, key: '-' })).toBe('out');
    expect(zoomKey({ metaKey: true, ctrlKey: false, key: '0' })).toBe('reset');
    expect(zoomKey({ metaKey: false, ctrlKey: false, key: '=' })).toBeNull();
  });
});
