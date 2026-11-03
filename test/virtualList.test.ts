// @vitest-environment jsdom
/**
 * The virtualized problem list measures row heights per kind; they are
 * measured again when the list's width changes (a narrow panel hides the
 * second line, so heights taken there must not stick: overlapping rows).
 */
import { describe, expect, it } from 'vitest';
import { VirtualList } from '../webview/virtualList';

describe('VirtualList row heights', () => {
  it('re-measured after a width change, so rows never overlap', () => {
    let rowHeight = 22; // narrow panel: one line
    let width = 180;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => rowHeight });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 });
    const observers: (() => void)[] = [];
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(private cb: () => void) {
        observers.push(() => this.cb());
      }
      observe() {}
    };
    const list = new VirtualList<number>(document, {
      key: String,
      version: () => '1',
      kind: () => 'two-line',
      render: (i) => Object.assign(document.createElement('div'), { textContent: `row ${i}` }),
      fallbackHeight: () => 38,
      maxHeight: 300,
    });
    document.body.append(list.viewport);
    list.setItems([1, 2, 3]);
    const tops = () => [...list.viewport.querySelectorAll<HTMLElement>('.vrow')].map((r) => r.style.top);
    expect(tops()).toEqual(['0px', '22px', '44px']);
    observers.forEach((f) => f()); // first size report
    rowHeight = 40; // wider panel: the second line is back
    width = 320;
    observers.forEach((f) => f());
    expect(tops()).toEqual(['0px', '40px', '80px']);
    width = 0; // collapsed: nothing changes
    rowHeight = 0;
    observers.forEach((f) => f());
    expect(tops()).toEqual(['0px', '40px', '80px']);
  });
});
