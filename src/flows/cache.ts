import * as vscode from 'vscode';
import { CLEAR_DEFAULTS, CLEAR_ORDER, type ClearCategory, keepIds, planClear } from '../data/cacheClear';
import { cleanupCache, clearCacheFiles, enforceLimit, formatBytes, scanCache, statementIds, totalBytes } from '../data/cacheFiles';
import type { CaseSource } from '../runner/types';
import { CACHE, TIMING } from '../shared/constants';
import { KEYS } from '../shared/stateKeys';
import { S } from '../shared/strings';
import type { Host } from './host';

/**
 * Downloaded-file housekeeping (rules in src/data/cacheFiles.ts and
 * src/data/cacheClear.ts): the size limit after every write, the daily
 * cleanup and "Clear Cached Data…". Never touches the workspace.
 */
export class CacheCare {
  /** Size-limit runs, one at a time. */
  private job: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: Host,
    /** Log out (the "Saved login" checkbox). */
    private readonly logout: () => Promise<void>,
    /** After clearing: reset the controller's in-memory state (`resetData`: lists and history were cleared too). */
    private readonly afterClear: (resetData: boolean) => Promise<void>,
  ) {}

  private get root(): string {
    return this.host.ctx.globalStorageUri.fsPath;
  }

  private get maxBytes(): number {
    return this.host.cfg.cacheMaxMB * 1024 * 1024;
  }

  /**
   * At most once a day: stale mappings older than 30 days, downloaded files
   * unused for 30 days, leftover temporary files, then the size limit.
   */
  async dailyCleanup(): Promise<void> {
    const h = this.host;
    const last = h.ctx.globalState.get<number>(KEYS.lastCleanup, 0);
    if (Date.now() - last < TIMING.dailyCleanupMs) return;
    await h.ctx.globalState.update(KEYS.lastCleanup, Date.now());
    const n = await h.mapping.expireStale();
    if (n) {
      h.log(`Removed ${n} mapping(s) whose file has been missing for 30 days.`);
      await h.links.refreshMappedIds(); // runs after the panel's first state
      h.emit();
    }
    const r = await cleanupCache(this.root, { now: Date.now(), maxBytes: this.maxBytes, unusedDays: CACHE.unusedDays, tempDays: CACHE.tempDays });
    if (r.removed) h.log(`Cache cleanup: removed ${r.removed} file(s), ${formatBytes(r.bytes)}.`);
    await this.pruneStatementViews();
  }

  /** A downloaded file was written: keep the cache under `cedtGrader.cacheMaxMB` (one run at a time; the new file stays). */
  written(path: string): void {
    this.job = this.job
      .then(async () => {
        const r = await enforceLimit(this.root, this.maxBytes, [path]);
        if (r.removed) {
          this.host.requestLog(`cache limit: removed ${r.removed} least recently used file(s), ${formatBytes(r.bytes)}`);
          await this.pruneStatementViews();
        }
      })
      .catch((err) => this.host.log(`Cache limit: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Forget the saved page / zoom of statements that are no longer cached. */
  private async pruneStatementViews(): Promise<void> {
    const g = this.host.ctx.globalState;
    const views = g.get<Record<string, unknown>>(KEYS.statementView, {});
    if (!Object.keys(views).length) return;
    const kept = keepIds(views, statementIds(await scanCache(this.root)));
    if (Object.keys(kept).length !== Object.keys(views).length) await g.update(KEYS.statementView, kept);
  }

  /**
   * "Clear Cached Data": shows the size in use, lets the user tick what to
   * clear (`CLEAR_DEFAULTS`), confirms (modal: can't be undone), then clears.
   */
  async clear(): Promise<void> {
    const h = this.host;
    const ws = h.ctx.workspaceState;
    const files = await scanCache(this.root);
    const fileBytes = totalBytes(files);
    const listKeys = ws.keys().filter((k) => k.startsWith(KEYS.problemsPrefix));
    const listBytes = listKeys.reduce((n, k) => n + Buffer.byteLength(JSON.stringify(ws.get(k)) ?? ''), 0);
    const linkCount = (await h.mapping.allEntries()).length;
    const customCount = await h.cases.customCount();
    const rows: Record<ClearCategory, { label: string; detail: string; description?: string; show: boolean }> = {
      files: { label: S.cache.files, detail: S.cache.filesDetail, description: formatBytes(fileBytes), show: true },
      custom: { label: S.cache.custom, detail: S.cache.customDetail, description: String(customCount), show: customCount > 0 },
      lists: { label: S.cache.lists, detail: S.cache.listsDetail, description: formatBytes(listBytes), show: true },
      links: { label: S.cache.links, detail: S.cache.linksDetail, description: linkCount ? String(linkCount) : undefined, show: true },
      login: { label: S.cache.login, detail: S.cache.loginDetail, show: true },
    };
    const items = CLEAR_ORDER.filter((c) => rows[c].show).map((c) => ({
      id: c,
      label: rows[c].label,
      description: rows[c].description,
      detail: rows[c].detail,
      picked: CLEAR_DEFAULTS[c],
    }));
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: S.cache.title(formatBytes(fileBytes + listBytes)),
      placeHolder: S.cache.placeholder,
      ignoreFocusOut: true,
    });
    if (!picked?.length) return;
    const what = picked.map((p) => p.label.toLowerCase()).join(', ');
    if ((await vscode.window.showWarningMessage(S.cache.confirm(what), { modal: true }, S.cache.clear)) !== S.cache.clear) return;

    const plan = planClear(new Set(picked.map((p) => p.id)), { workspace: ws.keys(), global: h.ctx.globalState.keys() });
    let freed = 0;
    if (plan.logout) await this.logout();
    if (plan.cacheFiles) {
      freed += (await clearCacheFiles(this.root)).bytes;
      h.data.forgetDetails();
      await h.tests.refreshStatementKind();
    }
    const cleared: CaseSource[] = [...(plan.cacheFiles ? (['grader', 'sample'] as const) : []), ...(plan.customCases ? (['custom'] as const) : [])];
    if (cleared.length) {
      await h.cases.clear(cleared);
      await h.runner.refresh();
    }
    if (plan.staleLinks) await h.mapping.removeStale();
    if (plan.allLinks) await h.mapping.clearLinks();
    for (const k of plan.workspaceKeys) await ws.update(k, undefined);
    for (const k of plan.globalKeys) await h.ctx.globalState.update(k, undefined);
    if (plan.resetData) freed += listBytes;
    await this.afterClear(plan.resetData);
    void vscode.window.setStatusBarMessage(S.cache.cleared(formatBytes(freed)), TIMING.statusMessageMs * 2);
  }
}
