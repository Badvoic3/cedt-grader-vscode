import * as vscode from 'vscode';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Problem } from '../grader';
import { badgeView } from '../mapping/explorerBadge';
import { matchFile } from '../mapping/matchIndex';
import type { LinkHow } from '../mapping/problemFiles';
import { TIMING } from '../shared/constants';
import type { Host } from './host';

/**
 * Badges in the Explorer. VS Code asks only about rows it draws, so each answer
 * comes from the link table and the one matcher on that path: no file search,
 * no match index, no network, and a badge agrees with what opening the file shows.
 *
 * A package is one item, as in `src/mapping/problemFiles.ts`: the folder has the
 * badge, the files in it have none unless they have a link of their own.
 */
export class ExplorerBadges implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private ready = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastList: unknown;
  private lastKey = '';

  constructor(private readonly host: Host) {}

  /** `init` has read the links and the login: answers are right from now on. */
  start(): void {
    this.ready = true;
    this.refresh();
  }

  /** Called on every state change; only a change to what badges depend on redraws them. */
  sync(): void {
    const h = this.host;
    const list = h.data.problemList();
    const key = JSON.stringify([h.canShowScores(), h.cfg.baseUrl, h.cfg.explorerBadge, h.cfg.explorerColors, h.cfg.fileNamePattern.pattern, h.cfg.displayLanguage, h.languages.length]);
    if (list === this.lastList && key === this.lastKey) return;
    this.lastList = list;
    this.lastKey = key;
    this.refresh();
  }

  /** Redraw once for a burst of changes. Only drawn rows are asked again, so "everything" stays cheap. */
  refresh(): void {
    if (!this.ready) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.changed.fire(undefined), TIMING.badgeRefreshMs);
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    const h = this.host;
    try {
      if (!this.ready || uri.scheme !== 'file' || h.cfg.explorerBadge === 'off' || !h.canShowScores()) return undefined;
      const list = h.data.problemList();
      if (!list?.problems.length) return undefined;
      const found = await this.problemFor(uri, list.problems);
      const view = found && badgeView(found.problem, found.how, h.cfg.explorerBadge, h.cfg.explorerColors, list.topics?.map((t) => t.name));
      return view ? new vscode.FileDecoration(view.badge, view.tooltip, view.color ? new vscode.ThemeColor(view.color) : undefined) : undefined;
    } catch (err) {
      // A bad row must not cost the rest of the Explorer its badges.
      h.log(`Explorer badge failed: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }

  private async problemFor(uri: vscode.Uri, problems: Problem[]): Promise<{ problem: Problem; how: LinkHow } | null> {
    const h = this.host;
    const { baseUrl, fileNamePattern } = h.cfg;
    const byId = (id: number, how: LinkHow) => {
      const problem = problems.find((p) => p.id === id);
      return problem ? { problem, how } : null;
    };
    const own = await h.mapping.get(uri, baseUrl);
    if (own) return byId(own.problemId, 'chosen');
    if (h.mapping.isUnlinkedHere(uri) || (await h.mapping.resolve(uri, baseUrl))) return null;
    const ext = extname(uri.fsPath).slice(1).toLowerCase();
    if (ext && h.allSourceExts().includes(ext)) {
      const m = matchFile(h.links.sourceFile(uri.fsPath), problems, baseUrl, fileNamePattern.pattern);
      return m && m.how !== 'folder' ? byId(m.problemId, m.how) : null;
    }
    // A folder: only its exact name counts, or `week1` and the like would all be suggestions. The whole name is
    // the stem, dots included, and the disk is asked last, for the few paths that match.
    const m = matchFile({ fsPath: `${uri.fsPath}.folder`, folders: [] }, problems, baseUrl, fileNamePattern.pattern);
    if (m?.how !== 'filename' || !(await stat(uri.fsPath).catch(() => null))?.isDirectory()) return null;
    return byId(m.problemId, 'folder');
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.changed.dispose();
  }
}
