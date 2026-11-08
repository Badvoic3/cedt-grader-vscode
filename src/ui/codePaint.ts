import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CodePaint } from '../shared/breakData';
import { customRules, type Rule, semanticContext, semanticRules, semanticStyle, themeBlocks } from '../shared/codePaint';
import { collectTheme, parseJsonc, type ThemeJson } from '../shared/themeTokens';
import type { GrammarInfo, SemanticSpan } from './textmatePaint';

/**
 * The editor's colours for the break tab: finds the active theme, the language's grammar and its bracket pairs in
 * the installed extensions, asks for semantic tokens, and runs src/ui/textmatePaint.ts (imported on first use, so
 * the grammar engine never loads at activation). Null when anything can't be read: the tab then uses its own lexer.
 */

/** Lines tokenized before the visible ones (for the grammar state and the bracket depth); more starts fresh. */
const LOOK_BACK = 3000;

interface Contributes {
  themes?: { id?: string; label?: string; path?: string }[];
  grammars?: (Omit<GrammarInfo, 'file'> & { path?: string })[];
  languages?: { id?: string; configuration?: string }[];
  semanticTokenScopes?: { language?: string; scopes?: Record<string, string[]> }[];
}
const contributes = (ext: vscode.Extension<unknown>) => ((ext.packageJSON as { contributes?: Contributes }).contributes ?? {});

export interface ActiveTheme {
  names: string[];
  rules: Rule[];
  colors: Record<string, string>;
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, unknown>;
}

/** The active colour theme, read from its extension's JSON (following `include`). */
export function activeTheme(): ActiveTheme | null {
  const wb = vscode.workspace.getConfiguration('workbench');
  let label = wb.get<string>('colorTheme') ?? '';
  if (vscode.workspace.getConfiguration('window').get<boolean>('autoDetectColorScheme')) {
    const k = vscode.window.activeColorTheme.kind;
    label = wb.get<string>(k === vscode.ColorThemeKind.Light ? 'preferredLightColorTheme' : k === vscode.ColorThemeKind.HighContrast ? 'preferredHighContrastColorTheme' : k === vscode.ColorThemeKind.HighContrastLight ? 'preferredHighContrastLightColorTheme' : 'preferredDarkColorTheme') ?? label;
  }
  const norm = (s: string) => s.replace(/^Default /, '');
  for (const ext of vscode.extensions.all) {
    const t = (contributes(ext).themes ?? []).find((x) => x.path && (norm(x.id ?? x.label ?? '') === norm(label) || x.label === label));
    if (!t?.path) continue;
    const file = path.join(ext.extensionPath, t.path);
    const files = new Map<ThemeJson, string>();
    const read = (f: string): ThemeJson | null => {
      const j = parseJsonc(readFileSync(f, 'utf8'));
      if (j) {
        files.set(j, f);
        // tokenColors may name a JSON file of rules.
        if (typeof j.tokenColors === 'string' && j.tokenColors.endsWith('.json')) {
          const r = parseJsonc(readFileSync(path.join(path.dirname(f), j.tokenColors), 'utf8')) as unknown;
          j.tokenColors = Array.isArray(r) ? r : ((r as ThemeJson | null)?.tokenColors as ThemeJson['tokenColors']);
        }
      }
      return j;
    };
    const first = read(file);
    if (!first) return null;
    const theme = collectTheme(first, (inc, from) => read(path.join(path.dirname(files.get(from) ?? file), inc)));
    return { names: [label, t.id ?? '', t.label ?? ''].filter(Boolean), ...theme };
  }
  return null;
}

function grammarsOf(): GrammarInfo[] {
  const out: GrammarInfo[] = [];
  for (const ext of vscode.extensions.all) {
    for (const g of contributes(ext).grammars ?? []) if (g.scopeName && g.path) out.push({ ...g, file: path.join(ext.extensionPath, g.path) });
  }
  return out;
}

/** The language's bracket pairs (`colorizedBracketPairs`, else `brackets`, else the usual three). */
function bracketPairs(languageId: string): [string, string][] {
  for (const ext of vscode.extensions.all) {
    const l = (contributes(ext).languages ?? []).find((x) => x.id === languageId && x.configuration);
    if (!l?.configuration) continue;
    try {
      const conf = parseJsonc(readFileSync(path.join(ext.extensionPath, l.configuration), 'utf8')) as { colorizedBracketPairs?: [string, string][]; brackets?: [string, string][] } | null;
      const pairs = conf?.colorizedBracketPairs ?? conf?.brackets;
      if (Array.isArray(pairs)) return pairs.filter((p) => Array.isArray(p) && p.length === 2 && p[0].length === 1 && p[1].length === 1);
    } catch {
      // fall through to the usual pairs
    }
  }
  return [['(', ')'], ['[', ']'], ['{', '}']];
}

function contributedSemanticScopes(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const ext of vscode.extensions.all) {
    for (const c of contributes(ext).semanticTokenScopes ?? []) {
      for (const [sel, scopes] of Object.entries(c.scopes ?? {})) if (Array.isArray(scopes)) out[c.language ? `${sel}:${c.language}` : sel] = scopes;
    }
  }
  return out;
}

async function withTimeout<T>(p: Thenable<T>, ms: number): Promise<T | undefined> {
  return Promise.race([Promise.resolve(p), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

/** Semantic token styles for lines `from`…`to` (null when off, or no provider answers in time). */
async function semanticSpans(doc: vscode.TextDocument, theme: ActiveTheme, rules: Rule[], from: number, to: number): Promise<SemanticSpan[] | null> {
  const setting = vscode.workspace.getConfiguration('editor', doc).get<boolean | string>('semanticHighlighting.enabled', 'configuredByTheme');
  const custom = vscode.workspace.getConfiguration('editor', doc).get<Record<string, unknown>>('semanticTokenColorCustomizations');
  const blocks = themeBlocks(custom, theme.names);
  const userEnabled = blocks.reduce<boolean | undefined>((v, b) => (typeof b.enabled === 'boolean' ? b.enabled : v), undefined);
  const on = setting === true || (setting === 'configuredByTheme' && (userEnabled ?? theme.semanticHighlighting ?? false));
  if (!on) return null;
  const legend = await withTimeout(vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>('vscode.provideDocumentSemanticTokensLegend', doc.uri), 400);
  if (!legend) return null;
  const tokens = await withTimeout(vscode.commands.executeCommand<vscode.SemanticTokens | undefined>('vscode.provideDocumentSemanticTokens', doc.uri), 800);
  if (!tokens?.data) return null;
  const ctx = semanticContext([...semanticRules(theme.semanticTokenColors), ...blocks.flatMap((b) => semanticRules(b.rules))], contributedSemanticScopes(), rules);
  const out: SemanticSpan[] = [];
  const d = tokens.data;
  let line = 0, col = 0;
  for (let i = 0; i + 4 < d.length; i += 5) {
    line += d[i];
    col = d[i] ? d[i + 1] : col + d[i + 1];
    if (line < from) continue;
    if (line > to) break;
    const type = legend.tokenTypes[d[i + 3]];
    if (!type) continue;
    const mods = legend.tokenModifiers.filter((_, b) => (d[i + 4] >>> b) & 1);
    const style = semanticStyle(ctx, type, mods, doc.languageId);
    if (style) out.push({ line, col, len: d[i + 2], style });
  }
  return out;
}

/** The visible lines' colours, or null (no theme file, no grammar, or an error: the caller logs it). */
export async function editorPaint(editor: vscode.TextEditor, first: number, last: number, wasm: string): Promise<CodePaint | null> {
  const doc = editor.document;
  const theme = activeTheme();
  if (!theme) return null;
  const grammars = grammarsOf();
  // Several grammars can name the language (C++ also has its macro grammar): VS Code keeps the last one.
  const main = grammars.filter((g) => g.language === doc.languageId).at(-1);
  if (!main) return null;
  const cfg = vscode.workspace.getConfiguration('editor', doc);
  const rules = [...theme.rules, ...customRules(cfg.get('tokenColorCustomizations'), theme.names)];
  const start = Math.max(0, first - LOOK_BACK);
  const lines: string[] = [];
  for (let i = start; i <= last && i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
  const semantic = await semanticSpans(doc, theme, rules, first, last);
  const { paintCode } = await import('./textmatePaint');
  return paintCode({
    wasm,
    grammars,
    scopeName: main.scopeName,
    rules,
    lines,
    first: first - start,
    semantic: semantic?.map((s) => ({ ...s, line: s.line - start })) ?? null,
    brackets: cfg.get<boolean>('bracketPairColorization.enabled', true) ? { pairs: bracketPairs(doc.languageId), independent: cfg.get<boolean>('bracketPairColorization.independentColorPoolPerBracketType', false) } : null,
  });
}

