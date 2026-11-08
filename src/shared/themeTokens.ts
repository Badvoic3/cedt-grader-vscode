/**
 * Token colours for the break tab, read from a colour theme's JSON (no VS Code API gives them). Only the scopes the
 * tab's small lexer uses; semantic token colours are not read. Pure: the caller loads the files.
 */

export interface TokenColors {
  keyword: string | null;
  storage: string | null;
  type: string | null;
  string: string | null;
  number: string | null;
  comment: string | null;
  func: string | null;
  preproc: string | null;
  variable: string | null;
  fg: string | null;
}

interface Rule { scope?: string | string[]; settings?: { foreground?: string; fontStyle?: string } }
export interface ThemeJson { include?: string; colors?: Record<string, string>; tokenColors?: Rule[] | string; semanticHighlighting?: boolean; semanticTokenColors?: Record<string, unknown> }

/** JSON with comments and trailing commas, as theme files often are. Returns null when it can't be read. */
export function parseJsonc(text: string): ThemeJson | null {
  try {
    const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_m, str: string | undefined) => str ?? '');
    const parsed: unknown = JSON.parse(noComments.replace(/,(\s*[}\]])/g, '$1'));
    return parsed && typeof parsed === 'object' ? (parsed as ThemeJson) : null;
  } catch {
    return null;
  }
}

/**
 * The rules and colours of a theme, following `include` (a base theme) through `load(relativePath)`; the
 * including theme wins. At most 5 levels, so a loop can't hang.
 */
export function collectTheme(first: ThemeJson, load: (include: string, from: ThemeJson) => ThemeJson | null): { rules: Rule[]; colors: Record<string, string>; semanticHighlighting?: boolean; semanticTokenColors: Record<string, unknown> } {
  const chain: ThemeJson[] = [];
  for (let t: ThemeJson | null = first; t && chain.length < 5; t = t.include ? load(t.include, t) : null) chain.push(t);
  const rules: Rule[] = [], colors: Record<string, string> = {}, semanticTokenColors: Record<string, unknown> = {};
  let semanticHighlighting: boolean | undefined;
  for (const t of chain.reverse()) {
    if (Array.isArray(t.tokenColors)) rules.push(...t.tokenColors);
    Object.assign(colors, t.colors ?? {});
    Object.assign(semanticTokenColors, t.semanticTokenColors ?? {});
    if (typeof t.semanticHighlighting === 'boolean') semanticHighlighting = t.semanticHighlighting;
  }
  return { rules, colors, semanticHighlighting, semanticTokenColors };
}

/** The foreground of the most specific rule matching `scope` (a rule scope matches itself and its dotted children); later rules win ties. */
export function colorFor(rules: readonly Rule[], scope: string): string | null {
  let best: string | null = null, len = -1;
  for (const r of rules) {
    const fg = r.settings?.foreground;
    if (!fg) continue;
    const scopes = Array.isArray(r.scope) ? r.scope : String(r.scope ?? '').split(',');
    for (const raw of scopes) {
      const s = raw.trim();
      if (s && (scope === s || scope.startsWith(`${s}.`)) && s.length >= len) { best = fg; len = s.length; }
    }
  }
  return best;
}

export function tokenColors(theme: { rules: Rule[]; colors: Record<string, string> }): TokenColors {
  const c = (s: string) => colorFor(theme.rules, s);
  return {
    keyword: c('keyword.control'), storage: c('storage.type'), type: c('entity.name.type'), string: c('string.quoted.double'),
    number: c('constant.numeric'), comment: c('comment.line.double-slash'), func: c('entity.name.function'),
    preproc: c('keyword.control.directive'), variable: c('variable'), fg: theme.colors['editor.foreground'] ?? null,
  };
}

export const NO_COLORS: TokenColors = { keyword: null, storage: null, type: null, string: null, number: null, comment: null, func: null, preproc: null, variable: null, fg: null };
