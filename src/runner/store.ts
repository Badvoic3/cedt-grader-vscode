import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from '../data/cacheFiles';
import { pathKey } from '../mapping/paths';
import { caseKey } from './compare';
import type { CaseList, CaseOwner, CaseSource, RunnerCase } from './types';

/**
 * The runner's case lists in `<globalStorage>/runner-cases/`: one file per
 * problem (`<host>/<problemId>.json`), and one per unlinked file
 * (`_unlinked/<hash of the path>.json`, on no server).
 *
 * This folder is the user's work, so it is outside `CACHE_DIRS`: the size
 * limit and the daily cleanup never touch it, and only "Clear Cached Data"
 * removes anything from it. The download cache (`TestcaseStore`) stays as it
 * is; Load reads that and merges the cases in here.
 *
 * Writes to one file run one at a time. An unreadable file counts as an empty
 * list, never as an error.
 */
export const CASES_DIR = 'runner-cases';
/** A host name can't start with `_` here: `:` is the only character that becomes one, and never first. */
export const UNLINKED_DIR = '_unlinked';

/** A case that Load brings: `testcaseId` for grader cases only. */
export type IncomingCase = Pick<RunnerCase, 'input' | 'expected' | 'testcaseId'>;

export interface MergeResult {
  file: CaseList;
  added: number;
  /** Already there: same text, or the same grader case with new text. */
  kept: number;
}

/** A higher rank wins the badge when two sources bring the same case. */
const RANK: Record<CaseSource, number> = { grader: 3, sample: 2, custom: 1 };
const SOURCES = new Set<string>(Object.keys(RANK));

function validCase(c: unknown): c is RunnerCase {
  const x = c as Partial<RunnerCase> | null;
  return !!x && typeof x.id === 'string' && !!x.id && typeof x.input === 'string' && typeof x.expected === 'string' && SOURCES.has(x.source as string);
}

const emptyList = (owner: CaseOwner): CaseList => ({ version: 1, ...owner, cases: [] });

/** Text read from disk → a list; anything unusable is dropped. */
export function parseCases(text: string, owner: CaseOwner): CaseList {
  try {
    const raw = JSON.parse(text) as Partial<CaseList> | null;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.cases)) return emptyList(owner);
    return { ...raw, version: 1, ...owner, cases: raw.cases.filter(validCase) };
  } catch {
    return emptyList(owner);
  }
}

/**
 * Add `incoming` to `cases` (pure). A grader case already in the list by its
 * id takes the new text. A case with the same key stays where it is, and takes
 * the incoming badge when that ranks higher (`Grader` > `PDF Sample` >
 * `Custom`). A case the user deleted isn't in the list, so Load brings it back.
 */
export function mergeCases(cases: readonly RunnerCase[], incoming: readonly IncomingCase[], source: CaseSource, newId: () => string): { cases: RunnerCase[]; added: number; kept: number } {
  const out = cases.map((c) => ({ ...c }));
  let added = 0;
  let kept = 0;
  for (const c of incoming) {
    const sameGrader = source === 'grader' && c.testcaseId !== undefined ? out.find((x) => x.source === 'grader' && x.testcaseId === c.testcaseId) : undefined;
    if (sameGrader) {
      sameGrader.input = c.input;
      sameGrader.expected = c.expected;
      kept++;
      continue;
    }
    const key = caseKey(c);
    const same = out.find((x) => caseKey(x) === key);
    if (same) {
      if (RANK[source] > RANK[same.source]) {
        same.source = source;
        if (c.testcaseId !== undefined && source === 'grader') same.testcaseId = c.testcaseId;
      }
      kept++;
      continue;
    }
    out.push({ id: newId(), source, input: c.input, expected: c.expected, ...(source === 'grader' && c.testcaseId !== undefined ? { testcaseId: c.testcaseId } : {}) });
    added++;
  }
  return { cases: out, added, kept };
}

/** `ids` first, in that order; a case not named keeps its place after them. */
export function reorderCases(cases: readonly RunnerCase[], ids: readonly string[]): RunnerCase[] {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const first = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
  const named = new Set(first.map((c) => c.id));
  return [...first, ...cases.filter((c) => !named.has(c.id))];
}

export class CaseStore {
  /** The last write per file, so writes to one file never overlap. */
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(
    private readonly root: string,
    /** The grader's base URL now: problem lists are kept per server. */
    private readonly baseUrl: () => string,
    private readonly log: (line: string) => void = () => {},
    private readonly newId: () => string = randomUUID,
  ) {}

  private get folder(): string {
    return join(this.root, CASES_DIR);
  }

  private pathOf(owner: CaseOwner): string {
    if ('file' in owner) return join(this.folder, UNLINKED_DIR, `${createHash('sha256').update(pathKey(owner.file)).digest('hex').slice(0, 32)}.json`);
    return join(this.folder, new URL(this.baseUrl()).host.replace(/[^a-z0-9.-]/gi, '_'), `${owner.problemId}.json`);
  }

  private async load(path: string, owner: CaseOwner): Promise<CaseList> {
    try {
      return parseCases(await readFile(path, 'utf8'), owner);
    } catch {
      return emptyList(owner);
    }
  }

  /** Run `job` after any write already waiting on this file. */
  private queued<T>(path: string, job: () => Promise<T>): Promise<T> {
    const next = (this.queue.get(path) ?? Promise.resolve()).catch(() => {}).then(job);
    this.queue.set(path, next);
    return next;
  }

  /** Save what `patch` returns for the current list; null = no change. */
  private change(owner: CaseOwner, patch: (f: CaseList) => CaseList | null): Promise<CaseList> {
    const path = this.pathOf(owner);
    return this.queued(path, async () => {
      const now = await this.load(path, owner);
      const next = patch(now);
      if (next) await writeAtomic(path, JSON.stringify(next));
      return next ?? now;
    });
  }

  async read(owner: CaseOwner): Promise<CaseList> {
    const path = this.pathOf(owner);
    await this.queue.get(path)?.catch(() => {});
    return this.load(path, owner);
  }

  /** Cases from Load, which only a problem has. */
  merge(problemId: number, incoming: readonly IncomingCase[], source: Exclude<CaseSource, 'custom'>): Promise<MergeResult> {
    let added = 0;
    let kept = 0;
    return this.change({ problemId }, (f) => {
      const m = mergeCases(f.cases, incoming, source, this.newId);
      ({ added, kept } = m);
      return { ...f, cases: m.cases };
    }).then((file) => ({ file, added, kept }));
  }

  add(owner: CaseOwner, c: Pick<RunnerCase, 'input' | 'expected'> = { input: '', expected: '' }): Promise<CaseList> {
    return this.change(owner, (f) => ({ ...f, cases: [...f.cases, { id: this.newId(), source: 'custom', input: c.input, expected: c.expected }] }));
  }

  /** The text is now the user's and Load can't restore it, so the case becomes `Custom`. */
  update(owner: CaseOwner, caseId: string, text: Partial<Pick<RunnerCase, 'input' | 'expected'>>): Promise<CaseList> {
    return this.change(owner, (f) => {
      const c = f.cases.find((x) => x.id === caseId);
      if (!c || ((text.input ?? c.input) === c.input && (text.expected ?? c.expected) === c.expected)) return null;
      const edited: RunnerCase = { id: c.id, source: 'custom', input: text.input ?? c.input, expected: text.expected ?? c.expected };
      return { ...f, cases: f.cases.map((x) => (x.id === caseId ? edited : x)) };
    });
  }

  remove(owner: CaseOwner, caseId: string): Promise<CaseList> {
    return this.change(owner, (f) => (f.cases.some((c) => c.id === caseId) ? { ...f, cases: f.cases.filter((c) => c.id !== caseId) } : null));
  }

  reorder(owner: CaseOwner, ids: readonly string[]): Promise<CaseList> {
    return this.change(owner, (f) => ({ ...f, cases: reorderCases(f.cases, ids) }));
  }

  /** The limits and the sample tip's count, kept beside a problem's cases. */
  setMeta(problemId: number, meta: Partial<Pick<CaseList, 'limits' | 'sampleTip'>>): Promise<CaseList> {
    return this.change({ problemId }, (f) => ({ ...f, ...meta }));
  }

  /**
   * Move an unlinked file's cases to `to`, then delete its list: to the new
   * path after a rename, or to the problem once the file is linked. The user's
   * cases must never be left behind. Cases `to` already has are not repeated.
   */
  async moveUnlinked(file: string, to: CaseOwner): Promise<void> {
    const from: CaseOwner = { file };
    const path = this.pathOf(from);
    if (path === this.pathOf(to)) return;
    const { cases } = await this.read(from);
    if (!cases.length) return;
    await this.change(to, (f) => ({ ...f, cases: mergeCases(f.cases, cases, 'custom', this.newId).cases }));
    await this.queued(path, () => rm(path, { force: true }));
  }

  private async allLists(): Promise<{ path: string; owner: CaseOwner }[]> {
    const out: { path: string; owner: CaseOwner }[] = [];
    const hosts = await readdir(this.folder, { withFileTypes: true }).catch(() => []);
    for (const h of hosts) {
      if (!h.isDirectory()) continue;
      for (const name of await readdir(join(this.folder, h.name)).catch(() => [] as string[])) {
        const path = join(this.folder, h.name, name);
        const m = /^(\d+)\.json$/.exec(name);
        if (m && h.name !== UNLINKED_DIR) out.push({ path, owner: { problemId: Number(m[1]) } });
        else if (h.name === UNLINKED_DIR && name.endsWith('.json')) out.push({ path, owner: { file: name } });
      }
    }
    return out;
  }

  /** How many `Custom` cases there are, on every server and in unlinked files ("Clear Cached Data" shows it). */
  async customCount(): Promise<number> {
    let n = 0;
    for (const l of await this.allLists()) n += (await this.load(l.path, l.owner)).cases.filter((c) => c.source === 'custom').length;
    return n;
  }

  /** Remove the cases of these sources from every list. A list left with no cases is deleted. */
  async clear(sources: readonly CaseSource[]): Promise<void> {
    for (const { path, owner } of await this.allLists()) {
      await this.queued(path, async () => {
        const raw = await readFile(path, 'utf8').catch(() => '');
        const f = parseCases(raw, owner);
        const cases = f.cases.filter((c) => !sources.includes(c.source));
        if (!cases.length) await rm(path, { force: true }).catch((err) => this.log(`case list not removed: ${err instanceof Error ? err.message : err}`));
        else if (cases.length !== f.cases.length) await writeAtomic(path, JSON.stringify({ ...JSON.parse(raw), cases }));
      });
    }
  }
}
