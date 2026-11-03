// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildToolbar } from '../webview/statementToolbar';

describe('statement viewer toolbar', () => {
  it('every icon-only button has a tooltip and the same aria-label', () => {
    const noop = () => {};
    const { toolbar } = buildToolbar({ zoomOut: noop, zoomIn: noop, fitWidth: noop, prevPage: noop, nextPage: noop, prevMatch: noop, nextMatch: noop, refresh: noop, openInBrowser: noop, importSamples: noop });
    const buttons = [...toolbar.querySelectorAll('button')];
    expect(buttons.length).toBe(10);
    for (const b of buttons) {
      expect(b.textContent?.trim()).toBe('');
      expect(b.hasAttribute('title')).toBe(false); // custom tooltip, not the native one
      expect(b.dataset.tip).toBeTruthy();
      expect(b.getAttribute('aria-label')).toBe(b.dataset.tip);
    }
    expect(buttons.map((b) => b.dataset.tip)).toContain('Open in browser');
    for (const i of toolbar.querySelectorAll('input')) expect(i.getAttribute('aria-label')).toBeTruthy();
  });
});
