/**
 * Panel layout (settings `cedtGrader.panel.sections`, `cedtGrader.panel.compact`).
 * No `vscode` import: the host validates the setting, the webview applies it.
 */
export const SECTION_IDS = ['account', 'current', 'result', 'history', 'trophies', 'problems'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** Sections to show, in order: known ids only, no duplicates; an empty list means all (default order). */
export function normalizeSections(raw: unknown): SectionId[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: SectionId[] = [];
  for (const x of list) if ((SECTION_IDS as readonly string[]).includes(x) && !out.includes(x as SectionId)) out.push(x as SectionId);
  return out.length ? out : [...SECTION_IDS];
}

/** What the panel shows now: Account always comes back (first) while logged out, since it holds the login form. */
export function visibleSections(sections: readonly SectionId[], loggedIn: boolean): SectionId[] {
  const list = normalizeSections(sections);
  return loggedIn || list.includes('account') ? list : ['account', ...list];
}
