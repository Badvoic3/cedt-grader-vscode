// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTooltips } from '../webview/tooltip';

describe('custom tooltip', () => {
  let root: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"><button id="a" data-tip="Copy problem name" aria-label="Copy problem name">x</button><button id="b" data-tip="Open statement">y</button><span id="c">no tip</span></div>';
    root = document.getElementById('root')!;
  });
  afterEach(() => vi.useRealTimers());
  const over = (el: Element, related: Element | null = null) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: related, clientX: 5, clientY: 5 }));
  const out = (el: Element, to: Element | null) => el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }));

  it('shows on hover after ~300 ms, hides on mouse leave', () => {
    const t = installTooltips(document);
    over(document.getElementById('a')!);
    expect(t.element.hidden).toBe(true);
    vi.advanceTimersByTime(299);
    expect(t.element.hidden).toBe(true);
    vi.advanceTimersByTime(2);
    expect(t.element.hidden).toBe(false);
    expect(t.element.textContent).toBe('Copy problem name');
    expect(document.getElementById('a')!.getAttribute('aria-describedby')).toBe(t.element.id);
    out(document.getElementById('a')!, document.getElementById('c'));
    expect(t.element.hidden).toBe(true);
  });

  it('shows immediately on keyboard focus; hides on blur and Escape', () => {
    const t = installTooltips(document);
    document.getElementById('b')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(t.element.hidden).toBe(false);
    expect(t.element.textContent).toBe('Open statement');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(t.element.hidden).toBe(true);
    document.getElementById('b')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    document.getElementById('b')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(t.element.hidden).toBe(true);
  });

  it('works for elements created later (event delegation) and survives re-renders', () => {
    const t = installTooltips(document);
    root.innerHTML = '<button id="late" data-tip="Refresh history">r</button>';
    const late = document.getElementById('late')!;
    over(late);
    vi.advanceTimersByTime(300);
    expect(t.element.textContent).toBe('Refresh history');
    // Re-render replaces the hovered element with an equivalent one under the pointer.
    root.innerHTML = '<button id="late2" data-tip="Refresh history (updated)">r</button>';
    document.elementFromPoint = () => document.getElementById('late2');
    t.refresh();
    expect(t.element.hidden).toBe(false);
    expect(t.element.textContent).toBe('Refresh history (updated)');
    // Nothing with a tooltip under the pointer any more → hidden.
    root.innerHTML = '';
    document.elementFromPoint = () => root;
    t.refresh();
    expect(t.element.hidden).toBe(true);
  });

  it('elements without data-tip show nothing; the tooltip stays inside the viewport', () => {
    const t = installTooltips(document);
    over(document.getElementById('c')!);
    vi.advanceTimersByTime(500);
    expect(t.element.hidden).toBe(true);
    const a = document.getElementById('a')!;
    a.getBoundingClientRect = () => ({ left: 290, right: 300, top: 10, bottom: 20, width: 10, height: 10, x: 290, y: 10, toJSON() {} }) as DOMRect;
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 300 });
    Object.defineProperty(t.element, 'offsetWidth', { configurable: true, value: 120 });
    over(a);
    vi.advanceTimersByTime(300);
    expect(parseInt(t.element.style.left, 10) + 120).toBeLessThanOrEqual(300 - 8);
  });
});
