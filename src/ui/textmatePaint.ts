import { readFileSync } from 'node:fs';
import * as onig from 'vscode-oniguruma';
import * as tm from 'vscode-textmate';
import type { CodePaint } from '../shared/breakData';
import { type BracketChar, bracketLevels, fontBits, type Rule, type Style } from '../shared/codePaint';

/**
 * Colours code the way the editor does: the language's own TextMate grammar (from the extension that contributes
 * it) run by vscode-textmate + vscode-oniguruma, the libraries VS Code uses, with the theme's rules; then semantic
 * token styles and bracket-pair levels on top. No `vscode` import (src/ui/codePaint.ts gathers the inputs).
 */

/** A `contributes.grammars` entry, with its file resolved. */
export interface GrammarInfo {
  scopeName: string;
  file: string;
  language?: string;
  embeddedLanguages?: Record<string, string>;
  tokenTypes?: Record<string, string>;
  injectTo?: string[];
  balancedBracketScopes?: string[];
  unbalancedBracketScopes?: string[];
}

export interface SemanticSpan {
  line: number;
  col: number;
  len: number;
  style: Style;
}

export interface PaintInput {
  /** Path of onig.wasm (packed in dist/). */
  wasm: string;
  grammars: readonly GrammarInfo[];
  scopeName: string;
  /** Theme rules, then the user's customizations. */
  rules: readonly Rule[];
  /** Document lines from where tokenizing starts to the last visible line. */
  lines: readonly string[];
  /** Index in `lines` of the first visible line. */
  first: number;
  /** Semantic token styles, by index in `lines` (null = semantic highlighting off or no provider). */
  semantic: readonly SemanticSpan[] | null;
  /** Bracket-pair colours (null = off). */
  brackets: { pairs: readonly (readonly [string, string])[]; independent: boolean } | null;
  /** Milliseconds for the lines above the visible ones; past it, tokenizing starts fresh at the first visible line. */
  budgetMs?: number;
}

/** Palette entries the webview resolves itself: the editor foreground and the bracket levels (from VS Code's CSS variables). */
export const FG = 'fg';
const DEFAULT_SENTINEL = '#000001';

let wasmReady: Promise<void> | null = null;
function loadOnig(file: string): Promise<void> {
  if (!wasmReady) {
    const b = readFileSync(file);
    wasmReady = onig.loadWASM(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    wasmReady.catch(() => (wasmReady = null));
  }
  return wasmReady;
}

const TOKEN_TYPES: Record<string, number> = { other: 0, comment: 1, string: 2, regex: 3 };

export async function paintCode(input: PaintInput): Promise<CodePaint | null> {
  const byScope = new Map(input.grammars.map((g) => [g.scopeName, g]));
  if (!byScope.has(input.scopeName)) return null;
  await loadOnig(input.wasm);
  const injections = new Map<string, string[]>();
  for (const g of input.grammars) for (const target of g.injectTo ?? []) injections.set(target, [...(injections.get(target) ?? []), g.scopeName]);
  const languageIds = new Map<string, number>();
  const langNum = (id: string) => languageIds.get(id) ?? (languageIds.set(id, languageIds.size + 1), languageIds.size);

  const registry = new tm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p) => onig.createOnigScanner(p), createOnigString: (s) => onig.createOnigString(s) }),
    loadGrammar: async (scope) => {
      const g = byScope.get(scope);
      if (!g) return null;
      return tm.parseRawGrammar(readFileSync(g.file, 'utf8'), g.file);
    },
    getInjections: (scope) => injections.get(scope),
    theme: { settings: [{ settings: { foreground: DEFAULT_SENTINEL } }, ...(input.rules as tm.IRawTheme['settings'])] },
  });
  const main = byScope.get(input.scopeName);
  const embedded: Record<string, number> = {};
  for (const [scope, lang] of Object.entries(main?.embeddedLanguages ?? {})) embedded[scope] = langNum(lang);
  const tokenTypes: Record<string, number> = {};
  for (const [scope, t] of Object.entries(main?.tokenTypes ?? {})) if (t in TOKEN_TYPES) tokenTypes[scope] = TOKEN_TYPES[t];
  const grammar = await registry.loadGrammarWithConfiguration(input.scopeName, langNum(main?.language ?? 'main'), {
    embeddedLanguages: embedded,
    tokenTypes: tokenTypes as tm.ITokenTypeMap,
    balancedBracketSelectors: main?.balancedBracketScopes ?? ['*'],
    unbalancedBracketSelectors: main?.unbalancedBracketScopes ?? [],
  });
  if (!grammar) { registry.dispose(); return null; }
  const colorMap = registry.getColorMap();

  // Per character of the visible lines: palette entry and font bits.
  const palette: string[] = [];
  const pIndex = new Map<string, number>();
  const pal = (c: string) => pIndex.get(c) ?? (pIndex.set(c, palette.length), palette.push(c), palette.length - 1);
  const fg = pal(FG);
  const color: number[][] = [];
  const style: number[][] = [];
  const brackets: BracketChar[] = [];
  const openers = new Set((input.brackets?.pairs ?? []).flat());
  const deadline = Date.now() + (input.budgetMs ?? 400);
  let state: tm.StateStack = tm.INITIAL;
  for (let i = 0; i < input.lines.length; i++) {
    if (i < input.first && Date.now() > deadline) {
      i = input.first;
      state = tm.INITIAL;
      brackets.length = 0;
    }
    const text = input.lines[i];
    const visible = i >= input.first;
    const r = grammar.tokenizeLine2(text, state, 50);
    state = r.ruleStack;
    const cs = visible ? new Array<number>(text.length).fill(fg) : [];
    const fs = visible ? new Array<number>(text.length).fill(0) : [];
    const t = r.tokens;
    for (let k = 0; k < t.length; k += 2) {
      const start = t[k], end = k + 2 < t.length ? t[k + 2] : text.length, meta = t[k + 1];
      const tokenType = (meta >>> 8) & 3, balanced = ((meta >>> 10) & 1) === 1, font = (meta >>> 11) & 15, fgId = (meta >>> 15) & 511;
      if (visible) {
        const c = colorMap[fgId];
        const ci = !c || c.toUpperCase() === DEFAULT_SENTINEL ? fg : pal(c);
        for (let x = start; x < end; x++) { cs[x] = ci; fs[x] = font; }
      }
      if (openers.size && tokenType === 0 && balanced) for (let x = start; x < end; x++) if (openers.has(text[x])) brackets.push({ line: i, col: x, ch: text[x] });
    }
    if (visible) { color.push(cs); style.push(fs); }
  }
  for (const s of input.semantic ?? []) {
    const row = s.line - input.first;
    if (row < 0 || row >= color.length) continue;
    const ci = s.style.foreground ? pal(s.style.foreground) : null;
    const bits = s.style.fontStyle !== undefined ? fontBits(s.style.fontStyle) : null;
    for (let x = s.col; x < s.col + s.len && x < color[row].length; x++) {
      if (ci !== null) color[row][x] = ci;
      if (bits !== null) style[row][x] = bits;
    }
  }
  if (input.brackets) {
    for (const [key, level] of bracketLevels(brackets, input.brackets.pairs, input.brackets.independent)) {
      const [line, col] = key.split(':').map(Number);
      const row = line - input.first;
      if (row >= 0 && row < color.length) color[row][col] = pal(level < 0 ? 'bu' : `b${level}`);
    }
  }
  // Runs per line: [length, palette index, font bits, …].
  const runs = color.map((cs, row) => {
    const out: number[] = [];
    for (let x = 0; x < cs.length; x++) {
      const n = out.length;
      if (n && out[n - 2] === cs[x] && out[n - 1] === style[row][x]) out[n - 3]++;
      else out.push(1, cs[x], style[row][x]);
    }
    return out;
  });
  registry.dispose();
  return { palette, runs };
}
