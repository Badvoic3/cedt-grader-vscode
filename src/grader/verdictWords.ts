import type { Verdict } from './types';
import { G } from '../shared/strings';

/** "Group 2 of 3: 2/3 passed. Tests in a box are …" (passed = tiles with code P, as on the website). */
export function groupLabel(group: number, groupCount: number, members: Pick<Verdict, 'ok'>[]): string {
  return G.groupOf(group, groupCount, members.filter((m) => m.ok).length, members.length, G.groupHint);
}

/** Word for an evaluation `result` kind (`correct` → `Correct`), or the raw kind. */
export function resultWord(kind: string | null | undefined): string {
  return (kind && G.verdict[kind]) || kind || G.unknownVerdict;
}
