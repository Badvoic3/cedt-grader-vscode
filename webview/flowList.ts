/**
 * The problem list: every row in normal document flow inside one scrolling
 * element. The browser lays the rows out, so a row is always exactly as tall
 * as its content (wrapped tags, a second line or not, compact mode, any
 * width) and can never overlap the next one. No heights are measured or
 * guessed. (It replaced a virtualized list that positioned rows absolutely
 * from one measured height per row kind: rows with more tags overlapped.)
 *
 * - The viewport element is persistent: re-rendering the surrounding section
 *   never resets the scroll position (callers re-insert the same element).
 * - Rows are cached by key (problem id) with a version string (row data:
 *   score, name, tags, link state, ✓). A row is rebuilt only when its version
 *   changed; switching the active file touches just the two rows whose ✓
 *   changed. A new item list (filter keystroke, sort) reuses the cached rows
 *   and moves only the rows that are out of place.
 * - One Tab stop for the whole list (roving tabindex): the current row's
 *   controls are tabbable, every other row's are not; ↑ / ↓ / Home / End move
 *   between rows. Otherwise 300 rows would be 1 800 Tab stops.
 */
export interface FlowListOptions<T> {
  key: (item: T) => string;
  version: (item: T) => string;
  render: (item: T) => HTMLElement;
  /** Viewport height cap (px). */
  maxHeight: number;
  className?: string;
  onScroll?: (scrollTop: number) => void;
}

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]';

export class FlowList<T> {
  readonly viewport: HTMLDivElement;
  private items: T[] = [];
  private readonly cache = new Map<string, { version: string; el: HTMLElement }>();
  /** Key of the row that holds the list's Tab stop. */
  private current: string | null = null;

  constructor(doc: Document, private readonly o: FlowListOptions<T>) {
    this.viewport = doc.createElement('div');
    this.viewport.className = o.className ?? 'flist';
    this.viewport.setAttribute('role', 'list');
    this.viewport.style.maxHeight = `${o.maxHeight}px`;
    this.viewport.addEventListener('scroll', () => o.onScroll?.(this.viewport.scrollTop));
    // A click or Tab into a row makes it the current one.
    this.viewport.addEventListener('focusin', (e) => {
      const key = this.rowOf(e.target)?.dataset.key;
      if (key && key !== this.current) this.setCurrent(key);
    });
    this.viewport.addEventListener('keydown', (e) => this.onKey(e));
  }

  get length(): number {
    return this.items.length;
  }

  /**
   * New item list (order / filter / data). Cached rows with an unchanged version are reused.
   * Rows whose key is in `retain` but not in `items` (filtered out) stay in place, hidden, so
   * clearing a filter only shows them again; other rows are dropped.
   */
  setItems(items: T[], retain?: ReadonlySet<string>): void {
    this.items = items;
    const keys = items.map(this.o.key);
    const keep = new Set(keys);
    for (const k of [...this.cache.keys()]) if (!keep.has(k) && !retain?.has(k)) this.cache.delete(k);
    const wanted = items.map((item, i) => this.row(item, keys[i]));
    const wantedEls = new Set<Element>(wanted);
    // The current row was filtered out: the Tab stop goes to the first row.
    if (this.current === null || !keep.has(this.current)) this.setCurrent(keys[0] ?? null);
    // Skip (hide) or drop rows that aren't wanted; move only wanted rows that are out of place
    // (moving a row would take keyboard focus out of it).
    const pass = (at: Element | null): Element | null => {
      while (at && !wantedEls.has(at)) {
        const next = at.nextElementSibling;
        const key = (at as HTMLElement).dataset.key;
        if (key !== undefined && this.cache.get(key)?.el === at) (at as HTMLElement).hidden = true;
        else at.remove();
        at = next;
      }
      return at;
    };
    let at = pass(this.viewport.firstElementChild);
    for (const el of wanted) {
      if (at === el) at = pass(el.nextElementSibling);
      else this.viewport.insertBefore(el, at);
      if (el.hidden) el.hidden = false;
    }
    pass(at);
  }

  /** The cached row for an item, rebuilt when its version changed. */
  private row(item: T, key: string): HTMLElement {
    const version = this.o.version(item);
    const c = this.cache.get(key);
    if (c && c.version === version) return c.el;
    const el = this.o.render(item);
    el.classList.add('frow');
    el.setAttribute('role', 'listitem');
    el.dataset.key = key;
    this.tabStops(el, key === this.current);
    if (c?.el.parentNode === this.viewport) {
      // Keep keyboard focus on the same control of the rebuilt row (e.g. a button that became busy).
      const doc = this.viewport.ownerDocument;
      const focused = c.el.contains(doc.activeElement) ? [...c.el.querySelectorAll(FOCUSABLE)].indexOf(doc.activeElement!) : -1;
      c.el.replaceWith(el);
      if (focused >= 0) (el.querySelectorAll<HTMLElement>(FOCUSABLE)[focused] ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    }
    this.cache.set(key, { version, el });
    return el;
  }

  private tabStops(row: HTMLElement, on: boolean): void {
    for (const f of row.querySelectorAll<HTMLElement>(FOCUSABLE)) f.tabIndex = on ? 0 : -1;
  }

  private setCurrent(key: string | null): void {
    const old = this.current !== null ? this.cache.get(this.current)?.el : undefined;
    if (old) this.tabStops(old, false);
    this.current = key;
    const el = key !== null ? this.cache.get(key)?.el : undefined;
    if (el) this.tabStops(el, true);
  }

  private rowOf(t: EventTarget | null): HTMLElement | null {
    const row = (t as Element | null)?.closest?.<HTMLElement>('.frow') ?? null;
    return row?.parentNode === this.viewport ? row : null;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const row = this.rowOf(e.target);
    if (!row) return;
    const rows = [...this.viewport.children].filter((r) => !(r as HTMLElement).hidden);
    const i = rows.indexOf(row);
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : -1;
    if (to < 0 || to >= rows.length || to === i) return;
    e.preventDefault();
    const target = rows[to] as HTMLElement;
    this.setCurrent(target.dataset.key!);
    target.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    this.revealNearest(target.dataset.key!);
  }

  /** Row element for a key (only while it is in the list). */
  rowFor(key: string): HTMLElement | undefined {
    const c = this.cache.get(key);
    return c && c.el.parentNode === this.viewport && !c.el.hidden ? c.el : undefined;
  }

  get scrollTop(): number {
    return this.viewport.scrollTop;
  }

  set scrollTop(v: number) {
    this.viewport.scrollTop = v;
  }

  /** Minimal scroll so the row is visible (like block: "nearest"); no-op when already visible. */
  revealNearest(key: string): void {
    const el = this.rowFor(key);
    if (!el) return;
    // The viewport is position: relative, so offsetTop is measured from its top.
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    const h = this.viewport.clientHeight;
    const st = this.viewport.scrollTop;
    if (top < st) this.scrollTop = top;
    else if (bottom > st + h) this.scrollTop = bottom - h;
  }
}
