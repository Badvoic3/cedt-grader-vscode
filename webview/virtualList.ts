/**
 * Virtualized list: renders only the rows in view (plus a buffer), so
 * thousands of problems stay fast and every one is reachable by scrolling.
 *
 * - The viewport element is persistent: re-rendering the surrounding section
 *   never resets the scroll position (callers re-insert the same element).
 * - Rows are cached by key (problem id) with a version string (row data:
 *   score, name, link state, ✓). A row is rebuilt only when its version
 *   changed; switching the active file touches just the two rows whose ✓
 *   changed.
 * - Heights are per row kind (e.g. with / without a second line), measured
 *   from rendered rows when layout is available, with fallbacks otherwise.
 *   They are measured again whenever the list's width changes (a row's
 *   height depends on it: narrow panels hide the second line), so heights
 *   taken at another width never stick.
 */
export interface VirtualListOptions<T> {
  key: (item: T) => string;
  version: (item: T) => string;
  /** Row kind: rows of one kind share a height. */
  kind: (item: T) => string;
  render: (item: T) => HTMLElement;
  /** Fallback heights per kind (px) until measured. */
  fallbackHeight: (kind: string) => number;
  /** Viewport height cap (px). */
  maxHeight: number;
  /** Extra px rendered above and below the visible area. */
  buffer?: number;
  className?: string;
  onScroll?: (scrollTop: number) => void;
}

export class VirtualList<T> {
  readonly viewport: HTMLDivElement;
  private readonly inner: HTMLDivElement;
  private items: T[] = [];
  private offsets: number[] = [0];
  private readonly cache = new Map<string, { version: string; el: HTMLElement }>();
  private readonly measured = new Map<string, number>();
  private frame = 0;
  private width = 0;

  constructor(doc: Document, private readonly o: VirtualListOptions<T>) {
    this.viewport = doc.createElement('div');
    this.viewport.className = o.className ?? 'vlist';
    this.viewport.setAttribute('role', 'list');
    this.viewport.tabIndex = -1;
    this.inner = doc.createElement('div');
    this.inner.className = 'vlist-inner';
    this.viewport.append(this.inner);
    this.viewport.addEventListener('scroll', () => {
      o.onScroll?.(this.viewport.scrollTop);
      const win = doc.defaultView;
      if (!win?.requestAnimationFrame) return this.update();
      if (this.frame) return;
      this.frame = win.requestAnimationFrame(() => {
        this.frame = 0;
        this.update();
      });
    });
    const RO = doc.defaultView?.ResizeObserver;
    if (RO) {
      new RO(() => {
        const w = this.viewport.clientWidth;
        if (!w || w === this.width) return; // hidden (collapsed section / panel) or only the height changed
        this.width = w;
        this.remeasure();
      }).observe(this.viewport);
    }
  }

  /** Forget measured heights (width, font or layout changed) and lay the rows out again. */
  remeasure(): void {
    if (!this.measured.size) return;
    this.measured.clear();
    this.layout();
    this.update();
  }

  get length(): number {
    return this.items.length;
  }

  private height(item: T): number {
    const k = this.o.kind(item);
    return this.measured.get(k) ?? this.o.fallbackHeight(k);
  }

  /** New item list (order/filter/data). Cached rows with an unchanged version are reused. */
  setItems(items: T[]): void {
    this.items = items;
    this.layout();
    const keep = new Set(items.map(this.o.key));
    for (const k of [...this.cache.keys()]) if (!keep.has(k)) this.cache.delete(k);
    this.update();
  }

  private layout(): void {
    const off = new Array<number>(this.items.length + 1);
    off[0] = 0;
    for (let i = 0; i < this.items.length; i++) off[i + 1] = off[i] + this.height(this.items[i]);
    this.offsets = off;
    const total = off[this.items.length];
    this.inner.style.height = `${total}px`;
    this.viewport.style.height = `${Math.min(total, this.o.maxHeight)}px`;
  }

  private viewHeight(): number {
    return this.viewport.clientHeight || Math.min(this.offsets[this.items.length], this.o.maxHeight);
  }

  /** First index whose bottom is below `y`. */
  private indexAt(y: number): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.offsets[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Render the rows in view (call after scrolling or data changes). */
  update(): void {
    const buffer = this.o.buffer ?? 200;
    const top = this.viewport.scrollTop;
    const from = this.indexAt(Math.max(0, top - buffer));
    const to = Math.min(this.items.length, this.indexAt(top + this.viewHeight() + buffer) + 1);
    const wanted: HTMLElement[] = [];
    let remeasure = false;
    for (let i = from; i < to; i++) {
      const item = this.items[i];
      const key = this.o.key(item);
      const version = this.o.version(item);
      let c = this.cache.get(key);
      if (!c || c.version !== version) {
        const el = this.o.render(item);
        el.classList.add('vrow');
        el.setAttribute('role', 'listitem');
        el.dataset.key = key;
        if (c?.el.parentNode === this.inner) c.el.replaceWith(el);
        c = { version, el };
        this.cache.set(key, c);
      }
      const h = this.height(item);
      c.el.style.top = `${this.offsets[i]}px`;
      c.el.style.height = `${h}px`;
      wanted.push(c.el);
    }
    const keepEls = new Set(wanted);
    for (const child of [...this.inner.children]) if (!keepEls.has(child as HTMLElement)) child.remove();
    for (const el of wanted) if (el.parentNode !== this.inner) this.inner.append(el);
    // Measure real heights once per kind (natural height, before the fixed one applies).
    for (let i = from; i < to; i++) {
      const k = this.o.kind(this.items[i]);
      if (this.measured.has(k)) continue;
      const el = this.cache.get(this.o.key(this.items[i]))!.el;
      const prev = el.style.height;
      el.style.height = '';
      const natural = el.offsetHeight;
      el.style.height = prev;
      if (natural > 0) {
        this.measured.set(k, natural);
        remeasure = true;
      }
    }
    if (remeasure) {
      this.layout();
      this.update();
    }
  }

  /** Rendered row element for a key (only while in view). */
  rowFor(key: string): HTMLElement | undefined {
    const c = this.cache.get(key);
    return c && c.el.parentNode === this.inner ? c.el : undefined;
  }

  get scrollTop(): number {
    return this.viewport.scrollTop;
  }

  set scrollTop(v: number) {
    this.viewport.scrollTop = v;
    this.update();
  }

  /** Minimal scroll so the item is visible (like block: "nearest"); no-op when already visible. */
  revealNearest(key: string): void {
    const i = this.items.findIndex((x) => this.o.key(x) === key);
    if (i < 0) return;
    const top = this.offsets[i];
    const bottom = this.offsets[i + 1];
    const h = this.viewHeight();
    const st = this.viewport.scrollTop;
    if (top < st) this.scrollTop = top;
    else if (bottom > st + h) this.scrollTop = bottom - h;
  }
}
