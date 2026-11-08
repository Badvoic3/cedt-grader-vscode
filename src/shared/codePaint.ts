/**
 * How the editor colours code, for the break tab (src/ui/codePaint.ts does the VS Code part): the theme's
 * TextMate rules with the user's customizations, semantic token styles, and bracket-pair colours. Pure, and
 * written after VS Code's own rules (ColorThemeData, TokenClassificationRegistry, the bracket-pair colorizer)
 * so the break tab's first and last frames look exactly like the editor.
 */

export interface Style {
  foreground?: string;
  /** TextMate font style: any of "italic", "bold", "underline", "strikethrough" (empty = none). */
  fontStyle?: string;
}
export interface Rule {
  scope?: string | string[];
  settings?: Style & { background?: string };
}

// ------------------------------------------------------------- TextMate customizations

/** `editor.tokenColorCustomizations` groups → scopes (VS Code's tokenGroupToScopesMap). */
const GROUPS: Record<string, string[]> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The customization blocks that apply to `theme`: the global one, then `[Theme name]` blocks naming it. */
export function themeBlocks(custom: unknown, themeNames: readonly string[]): Record<string, unknown>[] {
  if (!isObj(custom)) return [];
  const out: Record<string, unknown>[] = [custom];
  for (const [k, v] of Object.entries(custom)) {
    if (!k.startsWith('[') || !k.endsWith(']') || !isObj(v)) continue;
    // One key can name several themes: "[Theme A][Theme *]".
    const patterns = [...k.matchAll(/\[(.+?)\]/g)].map((m) => new RegExp(`^${m[1].split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));
    if (themeNames.some((n) => patterns.some((p) => p.test(n)))) out.push(v);
  }
  return out;
}

/** `editor.tokenColorCustomizations` as TextMate rules, in the order VS Code adds them after the theme's. */
export function customRules(custom: unknown, themeNames: readonly string[]): Rule[] {
  const rules: Rule[] = [];
  for (const block of themeBlocks(custom, themeNames)) {
    for (const [group, scopes] of Object.entries(GROUPS)) {
      const v = block[group];
      const settings = typeof v === 'string' ? { foreground: v } : isObj(v) ? (v as Style) : null;
      if (settings) rules.push({ scope: scopes, settings });
    }
    if (Array.isArray(block.textMateRules)) for (const r of block.textMateRules) if (isObj(r) && r.scope && isObj(r.settings)) rules.push(r as Rule);
  }
  return rules;
}

/** How a space-separated chain of rule scopes matches `probe` (VS Code's `matchesScope` in ColorThemeData): -1 = no match. */
function matchChain(chain: readonly string[], probe: readonly string[]): number {
  if (!chain[0] || probe.length < chain.length) return -1;
  let score = -1;
  for (const part of chain) {
    let hit = -1;
    for (let n = probe.length - 1; n >= 0; n--) {
      if (probe[n] === part || probe[n].startsWith(`${part}.`)) {
        hit = (n + 1) * 65536 + part.length;
        break;
      }
    }
    if (hit < 0) return -1;
    score = hit;
  }
  return score;
}

/**
 * The style of the most specific rule for `scope` (a rule scope matches itself and its dotted children; a parent
 * selector like "source.elixir entity.name.function" only matches when the parent scope is in `scope` too).
 */
export function scopeStyle(rules: readonly Rule[], scope: string): Style | null {
  const probe = scope.trim().split(/\s+/).filter(Boolean);
  if (!probe.length) return null;
  let fg: string | undefined, fs: string | undefined, fgScore = -1, fsScore = -1;
  for (const r of rules) {
    if (!r.settings || r.scope === undefined) continue;
    const list = Array.isArray(r.scope) ? r.scope.flatMap((x) => String(x).split(/[|,]/)) : String(r.scope).split(/[|,]/);
    for (const raw of list) {
      const [pos, ...negs] = raw.replace(/^[LR]:/, '').trim().split(/\s+-\s+/);
      if (!pos || negs.some((neg) => matchChain(neg.trim().split(/\s+/), probe) >= 0)) continue;
      const score = matchChain(pos.trim().split(/\s+/), probe);
      if (score < 0) continue;
      if (r.settings.foreground && score >= fgScore) { fg = r.settings.foreground; fgScore = score; }
      if (r.settings.fontStyle !== undefined && score >= fsScore) { fs = r.settings.fontStyle; fsScore = score; }
    }
  }
  return fg === undefined && fs === undefined ? null : { foreground: fg, fontStyle: fs };
}

// ------------------------------------------------------------- semantic tokens

/** VS Code's default semantic → TextMate scopes (TokenClassificationRegistry), probed in order. */
const SEMANTIC_DEFAULTS: Record<string, string[]> = {
  comment: ['comment'],
  string: ['string'],
  keyword: ['keyword.control'],
  number: ['constant.numeric'],
  regexp: ['constant.regexp'],
  operator: ['keyword.operator'],
  namespace: ['entity.name.namespace'],
  type: ['entity.name.type', 'support.type'],
  struct: ['entity.name.type.struct'],
  class: ['entity.name.type.class', 'support.class'],
  interface: ['entity.name.type.interface'],
  enum: ['entity.name.type.enum'],
  typeParameter: ['entity.name.type.parameter'],
  function: ['entity.name.function', 'support.function'],
  member: ['entity.name.function.member', 'support.function'],
  method: ['entity.name.function.member', 'support.function'],
  macro: ['entity.name.function.preprocessor'],
  variable: ['variable.other.readwrite', 'entity.name.variable'],
  parameter: ['variable.parameter'],
  property: ['variable.other.property'],
  enumMember: ['variable.other.enummember'],
  event: ['variable.other.event'],
  decorator: ['entity.name.decorator', 'entity.name.function'],
  'variable.readonly': ['variable.other.constant'],
  'property.readonly': ['variable.other.constant.property'],
  'type.defaultLibrary': ['support.type'],
  'class.defaultLibrary': ['support.class'],
  'interface.defaultLibrary': ['support.class'],
  'variable.defaultLibrary': ['support.variable', 'support.other.variable'],
  'variable.readonly.defaultLibrary': ['support.constant'],
  'property.defaultLibrary': ['support.variable.property'],
  'property.readonly.defaultLibrary': ['support.constant.property'],
  'function.defaultLibrary': ['support.function'],
  'member.defaultLibrary': ['support.function'],
};

const DEFAULT_SUPER_TYPES: Record<string, string> = { member: 'method' };

export interface SemanticRule {
  selector: string;
  style: Style;
}

/** A theme's `semanticTokenColors` or a customization's `rules` as rules (a value is a colour or a style object). */
export function semanticRules(map: unknown): SemanticRule[] {
  if (!isObj(map)) return [];
  const out: SemanticRule[] = [];
  for (const [selector, v] of Object.entries(map)) {
    if (typeof v === 'string') out.push({ selector, style: { foreground: v } });
    else if (isObj(v)) {
      const st = v as Style & { bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean };
      const parts = st.fontStyle !== undefined ? [st.fontStyle] : (['bold', 'italic', 'underline', 'strikethrough'] as const).filter((k) => st[k]);
      out.push({ selector, style: { foreground: st.foreground, fontStyle: st.fontStyle !== undefined || parts.length ? parts.join(' ') : undefined } });
    }
  }
  return out;
}

/** VS Code's selector score: -1 = no match; language +10, a named type +100 (−1 per superType step), each modifier +100. */
export function selectorScore(selector: string, type: string, modifiers: readonly string[], language: string, superTypes: Record<string, string> = DEFAULT_SUPER_TYPES): number {
  const [main, lang] = selector.split(':');
  const [t, ...mods] = main.split('.');
  let score = 0;
  if (lang !== undefined) {
    if (lang !== language) return -1;
    score += 10;
  }
  if (t !== '*') {
    let cur: string | undefined = type, depth = 0;
    while (cur && cur !== t && depth < 6) { cur = superTypes[cur]; depth++; }
    if (cur !== t) return -1;
    score += 100 - depth;
  }
  for (const m of mods) if (!modifiers.includes(m)) return -1;
  return score + mods.length * 100;
}

export interface SemanticContext {
  /** Theme rules first, then the user's (`editor.semanticTokenColorCustomizations`): later ones win ties. */
  rules: SemanticRule[];
  /** Selector → TextMate scopes to probe: the defaults plus `semanticTokenScopes` from extensions. */
  scopes: Record<string, string[]>;
  textMate: readonly Rule[];
  /** Token type → parent token type (`member` → `method` plus `semanticTokenTypes` from extensions). */
  superTypes: Record<string, string>;
}

export function semanticContext(rules: SemanticRule[], contributed: Record<string, string[]>, textMate: readonly Rule[], superTypes: Record<string, string> = {}): SemanticContext {
  return { rules, scopes: { ...SEMANTIC_DEFAULTS, ...contributed }, textMate, superTypes: { ...DEFAULT_SUPER_TYPES, ...superTypes } };
}

/** The style a semantic token gets (null = keep the TextMate colour). */
export function semanticStyle(ctx: SemanticContext, type: string, modifiers: readonly string[], language: string): Style | null {
  let fg: string | undefined, fs: string | undefined, fgScore = -1, fsScore = -1;
  for (const r of ctx.rules) {
    const s = selectorScore(r.selector, type, modifiers, language, ctx.superTypes);
    if (s < 0) continue;
    if (r.style.foreground && s >= fgScore) { fg = r.style.foreground; fgScore = s; }
    if (r.style.fontStyle !== undefined && s >= fsScore) { fs = r.style.fontStyle; fsScore = s; }
  }
  if (fg === undefined || fs === undefined) {
    // What the theme's semantic rules didn't set comes from the TextMate scopes of the matching default selectors.
    const lockFg = fg !== undefined, lockFs = fs !== undefined;
    let bestFg = -1, bestFs = -1;
    for (const [sel, scopes] of Object.entries(ctx.scopes)) {
      const s = selectorScore(sel, type, modifiers, language, ctx.superTypes);
      if (s < 0) continue;
      for (const scope of scopes) {
        const st = scopeStyle(ctx.textMate, scope);
        if (!st) continue;
        if (!lockFg && st.foreground && s >= bestFg) { fg = st.foreground; bestFg = s; }
        if (!lockFs && st.fontStyle !== undefined && s >= bestFs) { fs = st.fontStyle; bestFs = s; }
        break;
      }
    }
  }
  return fg === undefined && fs === undefined ? null : { foreground: fg, fontStyle: fs };
}

// ------------------------------------------------------------- bracket pairs

/** One bracket character that counts (not in a comment, string or regex, in a balanced-bracket token). */
export interface BracketChar {
  line: number;
  col: number;
  ch: string;
}

/**
 * The colour level of each counted bracket, matched across the text with a stack (VS Code colours level `n` with
 * the n-th non-transparent editorBracketHighlight colour, cycling); -1 = a closer with no opener, or the wrong one.
 * `independent`: one depth per bracket type (editor.bracketPairColorization.independentColorPoolPerBracketType).
 */
export function bracketLevels(brackets: readonly BracketChar[], pairs: readonly (readonly [string, string])[], independent: boolean): Map<string, number> {
  const out = new Map<string, number>();
  const openOf = new Map(pairs.map(([o, c]) => [c, o]));
  const opens = new Set(pairs.map(([o]) => o));
  const stack: { ch: string; level: number }[] = [];
  const depth = new Map<string, number>();
  for (const b of brackets) {
    const key = `${b.line}:${b.col}`;
    if (opens.has(b.ch)) {
      const level = independent ? (depth.get(b.ch) ?? 0) : stack.length;
      if (independent) depth.set(b.ch, level + 1);
      stack.push({ ch: b.ch, level });
      out.set(key, level);
      continue;
    }
    const want = openOf.get(b.ch);
    if (want === undefined) continue;
    const i = stack.map((x) => x.ch).lastIndexOf(want);
    if (i < 0 || (!independent && i !== stack.length - 1)) {
      out.set(key, -1);
      continue;
    }
    const [open] = stack.splice(i, 1);
    if (independent) depth.set(want, open.level);
    out.set(key, open.level);
  }
  return out;
}

/** `fontStyle` text → bits: 1 italic, 2 bold, 4 underline, 8 strikethrough. */
export function fontBits(fontStyle: string | undefined): number {
  if (!fontStyle) return 0;
  return (/italic/.test(fontStyle) ? 1 : 0) | (/bold/.test(fontStyle) ? 2 : 0) | (/underline/.test(fontStyle) ? 4 : 0) | (/strikethrough/.test(fontStyle) ? 8 : 0);
}
