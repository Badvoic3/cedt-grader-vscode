/** Small DOM helpers shared by the webviews. Text goes in as text nodes, never as HTML. */

export type Child = Node | string | null | undefined | false | Child[];
export type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') e.className = String(v);
    // Tooltips use the custom component (native `title` tooltips vanish on re-render).
    else if (k === 'title') e.dataset.tip = String(v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  appendChildren(e, children);
  return e;
}

export function appendChildren(parent: Node & ParentNode, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(parent, c);
    else parent.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export const icon = (name: string, extra = '') => el('span', { class: `codicon codicon-${name} ${extra}`.trim(), 'aria-hidden': 'true' });
