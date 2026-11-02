import { PANEL } from '../src/shared/constants';
/**
 * One small tooltip for a whole webview (replaces native `title` tooltips,
 * which disappear when the element under the cursor is re-rendered).
 *
 * - Elements opt in with `data-tip="…"` (and keep their `aria-label`).
 * - Shows on hover after `delay` ms and immediately on keyboard focus;
 *   hides on mouse leave, blur, Escape, scroll or click.
 * - Event delegation on the document: works for elements created later.
 * - Survives re-renders: after the DOM changes, it re-anchors to the element
 *   now under the pointer (or the focused element) with a `data-tip`.
 * - Positioned below (or above) the anchor, clamped inside the viewport.
 */
export interface TooltipApi {
  /** Call after re-rendering: re-anchors or hides. */
  refresh(): void;
  hide(): void;
  readonly element: HTMLElement;
}

export function installTooltips(doc: Document = document, delay: number = PANEL.tooltipDelayMs): TooltipApi {
  const tip = doc.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.id = 'cedt-tooltip';
  tip.hidden = true;
  doc.body.append(tip);

  let anchor: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pointer: { x: number; y: number } | null = null;

  const tipOf = (t: EventTarget | null): HTMLElement | null => {
    const el = t instanceof doc.defaultView!.Element ? (t as Element).closest<HTMLElement>('[data-tip], [data-tip-title]') : null;
    return el && (el.dataset.tip || el.dataset.tipTitle) ? el : null;
  };

  function place(el: HTMLElement): void {
    const r = el.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth || doc.defaultView!.innerWidth;
    const vh = doc.documentElement.clientHeight || doc.defaultView!.innerHeight;
    tip.style.maxWidth = `${Math.max(120, Math.min(320, vw - 16))}px`;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top = r.bottom + 6;
    if (top + h > vh - 4) top = Math.max(4, r.top - h - 6);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  /** Optional bold first line (`data-tip-title`) above the text (`data-tip`). */
  function fill(el: HTMLElement): void {
    tip.replaceChildren();
    if (el.dataset.tipTitle) {
      const b = doc.createElement('strong');
      b.textContent = el.dataset.tipTitle;
      tip.append(b);
      if (el.dataset.tip) tip.append(doc.createElement('br'));
    }
    if (el.dataset.tip) tip.append(doc.createTextNode(el.dataset.tip));
  }

  function show(el: HTMLElement): void {
    anchor = el;
    fill(el);
    tip.hidden = false;
    el.setAttribute('aria-describedby', tip.id);
    place(el);
  }

  function hide(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    anchor?.removeAttribute('aria-describedby');
    anchor = null;
    tip.hidden = true;
  }

  function schedule(el: HTMLElement, immediate: boolean): void {
    if (timer) clearTimeout(timer);
    if (anchor === el) return;
    if (immediate) show(el);
    else timer = setTimeout(() => show(el), delay);
  }

  doc.addEventListener('mouseover', (e) => {
    pointer = { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY };
    const el = tipOf(e.target);
    if (el) schedule(el, anchor !== null); // moving between tooltips: no extra delay
    else hide();
  });
  doc.addEventListener('mousemove', (e) => {
    pointer = { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY };
  });
  doc.addEventListener('mouseout', (e) => {
    const to = tipOf((e as MouseEvent).relatedTarget);
    if (!to) hide();
  });
  doc.addEventListener('focusin', (e) => {
    const el = tipOf(e.target);
    if (el) schedule(el, true);
  });
  doc.addEventListener('focusout', () => hide());
  doc.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') hide();
  });
  doc.addEventListener('mousedown', () => hide());
  doc.addEventListener('scroll', () => hide(), true);

  return {
    element: tip,
    hide,
    refresh(): void {
      if (!anchor || anchor.isConnected) {
        if (anchor) {
          fill(anchor);
          place(anchor);
        }
        return;
      }
      // The anchor was replaced by a re-render: follow its replacement.
      const focused = doc.activeElement ? tipOf(doc.activeElement) : null;
      const under = pointer && typeof doc.elementFromPoint === 'function' ? tipOf(doc.elementFromPoint(pointer.x, pointer.y)) : null;
      const next = focused ?? under;
      if (next) show(next);
      else hide();
    },
  };
}
