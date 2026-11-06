import type { ServerCheck } from '../grader';
import { DEFAULT_BASE_URL, LIMITS } from '../shared/constants';
import type { ServerView } from '../shared/messages';
import { isInsecure, normalizeServerUrl } from '../shared/serverUrl';
import { S } from '../shared/strings';

export interface ServerDeps {
  /** Addresses a login has already accepted. */
  verified(): readonly string[];
  saveVerified(list: string[]): Promise<void>;
  check(url: string): Promise<ServerCheck>;
  /** Ask before a password goes over plain `http://`. */
  confirmInsecure(url: string): Promise<boolean>;
  changed(): void;
}

export type ServerGate = { ok: true; url: string } | { ok: false };

/** The default server and accepted addresses are never checked: a false failure can't lock those users out. */
export function needsCheck(url: string, verified: readonly string[]): boolean {
  return url !== DEFAULT_BASE_URL && !verified.includes(url);
}

const IDLE: ServerView = { draft: null, status: 'idle', message: null };

/**
 * The address typed at login: what it is, what the check said, and whether a
 * password may go there. Nothing here writes the setting or touches a saved
 * password, so trying an address costs nothing.
 */
export class ServerFlow {
  private shown: ServerView = IDLE;
  private readonly results = new Map<string, ServerCheck>();
  private readonly inFlight = new Map<string, Promise<ServerCheck>>();
  /** The address the user last asked about: an older answer doesn't replace it. */
  private latest: string | null = null;

  constructor(private readonly deps: ServerDeps) {}

  view(): ServerView {
    return this.shown;
  }

  reset(): void {
    this.latest = null;
    this.shown = IDLE;
    this.deps.changed();
  }

  /** Check what was typed and show the result. */
  async inspect(raw: string): Promise<void> {
    const url = normalizeServerUrl(raw);
    this.latest = raw;
    if (!url) return this.show({ draft: raw, status: 'bad', message: S.account.serverInvalid });
    if (!needsCheck(url, this.deps.verified())) return this.show({ draft: raw, status: 'idle', message: null });
    if (!this.results.has(url)) this.show({ draft: raw, status: 'checking', message: null });
    const result = await this.run(url);
    if (this.latest === raw) this.showResult(raw, url, result);
  }

  /** May a password go to this address? `raw` undefined means the current one. */
  async gate(raw: string | undefined, current: string): Promise<ServerGate> {
    const url = raw === undefined ? current : normalizeServerUrl(raw);
    const draft = raw ?? current;
    this.latest = draft;
    if (!url) {
      this.show({ draft, status: 'bad', message: S.account.serverInvalid });
      return { ok: false };
    }
    if (!needsCheck(url, this.deps.verified())) return { ok: true, url };
    this.show({ draft, status: 'checking', message: null });
    const result = await this.run(url);
    this.showResult(draft, url, result);
    if (result.status !== 'compatible') return { ok: false };
    if (isInsecure(url) && !(await this.deps.confirmInsecure(url))) return { ok: false };
    await this.deps.saveVerified([url, ...this.deps.verified()].slice(0, LIMITS.verifiedServers));
    return { ok: true, url };
  }

  private run(url: string): Promise<ServerCheck> {
    const known = this.results.get(url);
    if (known) return Promise.resolve(known);
    let running = this.inFlight.get(url);
    if (!running) {
      running = this.deps.check(url).then((r) => {
        // "Try again" has to try again; the other two answers don't change within a session.
        if (r.status !== 'unreachable') this.results.set(url, r);
        return r;
      }).finally(() => this.inFlight.delete(url));
      this.inFlight.set(url, running);
    }
    return running;
  }

  private showResult(draft: string, url: string, r: ServerCheck): void {
    if (r.status === 'compatible') this.show({ draft, status: 'ok', message: null });
    else if (r.status === 'unreachable') this.show({ draft, status: 'unreachable', message: S.account.serverUnreachable(new URL(url).host) });
    else this.show({ draft, status: 'bad', message: S.account.serverIncompatible });
  }

  private show(v: ServerView): void {
    this.shown = v;
    this.deps.changed();
  }
}
