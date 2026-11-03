import { KEYS } from './stateKeys';

/**
 * SecretStorage keys (password and API token per grader address and user)
 * and a list of every key written, kept in globalState, so Log Out and a
 * change of user or grader address remove what earlier users left behind
 * (VS Code 1.90's SecretStorage can't list its keys). No `vscode` import.
 */

export type SecretKind = 'password' | 'token';

export function secretKey(kind: SecretKind, baseUrl: string, username: string): string {
  return `cedtGrader.${kind}:${baseUrl}:${username}`;
}

/** The parts of `vscode.SecretStorage` used here. */
export interface SecretStoreLike {
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

/** The parts of a `vscode.Memento` (globalState) used here. */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export class SecretLedger {
  constructor(
    private readonly secrets: SecretStoreLike,
    private readonly state: MementoLike,
  ) {}

  /** Keys written so far (this version on). */
  written(): string[] {
    const v = this.state.get<unknown>(KEYS.secretKeys, []);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  }

  async store(key: string, value: string): Promise<void> {
    const keys = this.written();
    if (!keys.includes(key)) await this.state.update(KEYS.secretKeys, [...keys, key]);
    await this.secrets.store(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.secrets.delete(key);
    const keys = this.written();
    if (keys.includes(key)) await this.state.update(KEYS.secretKeys, keys.filter((k) => k !== key));
  }

  /** The password and token of one user at one grader address (nothing for an empty user name). */
  async forgetAccount(baseUrl: string, username: string): Promise<void> {
    if (!username) return;
    for (const kind of ['password', 'token'] as const) await this.delete(secretKey(kind, baseUrl, username));
  }

  /** Every key written (any user, any address), plus `also` (keys from before the list existed). */
  async forgetAll(also: string[] = []): Promise<void> {
    for (const k of new Set([...this.written(), ...also])) await this.secrets.delete(k);
    await this.state.update(KEYS.secretKeys, []);
  }
}
