import * as os from 'node:os';
import * as vscode from 'vscode';
import { readConfig } from './config';
import { CRASH } from './shared/constants';
import { belongsToUs, buildReport, CrashGate, type CrashReport, isReportable, looksLikeBug, type SanitizeContext } from './shared/crashReport';
import { S } from './shared/strings';

export interface ReportOptions {
  /** The panel may be what broke: use a notification even when it is showing. */
  notify?: boolean;
  webview?: boolean;
}

/** Who the report must not name. */
export interface PrivateInfo {
  username?: string;
  fullName?: string | null;
  baseUrl?: string;
}

function hostnameOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).hostname : undefined;
  } catch {
    return undefined;
  }
}

function osUser(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined; // no passwd entry
  }
}

/**
 * Offers a prefilled GitHub issue after a bug. Created before anything else
 * in `activate()`, so it works when everything else failed. Nothing leaves
 * the machine unless the user presses the button: `open` is the only way out.
 */
export class CrashReporter implements vscode.Disposable {
  /** The "Grader Submit" channel; it lives here so that it exists when activation fails. */
  readonly output = vscode.window.createOutputChannel('Grader Submit');
  /** Set by the controller. Until then the panel doesn't exist. */
  onChange: () => void = () => {};
  panelReady: () => boolean = () => false;
  privateInfo: () => PrivateInfo = () => {
    const { username, baseUrl } = readConfig();
    return { username, baseUrl };
  };

  private readonly gate = new CrashGate(CRASH.maxPromptsPerSession);
  private pending: { id: number; report: CrashReport } | null = null;
  private seq = 0;

  private readonly onRejection = (reason: unknown): void => this.fromProcess(reason);
  private readonly onException = (err: unknown): void => this.fromProcess(err);

  constructor(private readonly ctx: vscode.ExtensionContext) {
    process.on('unhandledRejection', this.onRejection);
    process.on('uncaughtException', this.onException);
  }

  /** The card in the panel (ViewState.crash). */
  get view(): { id: number; report: string } | null {
    return this.pending ? { id: this.pending.id, report: this.pending.report.report } : null;
  }

  /** An error nothing handled. Never throws: a failure here must not add to the one being reported. */
  report(err: unknown, where: string, opts: ReportOptions = {}): void {
    try {
      if (isReportable(err)) this.offer(err, where, opts);
    } catch (e) {
      this.output.appendLine(`Crash report failed: ${e instanceof Error ? e.name : 'unknown error'}`);
    }
  }

  /** An error the code handled and shows in its own way: offered only when it can only be a bug. */
  caught(err: unknown, where: string): void {
    if (looksLikeBug(err)) this.report(err, where);
  }

  /** The panel's script failed, so the panel may be broken too. */
  panelError(message: unknown, stack: unknown): void {
    const err = new Error(String(message ?? '').slice(0, CRASH.maxPanelErrorChars));
    err.name = 'PanelScriptError';
    err.stack = String(stack ?? '').slice(0, CRASH.maxPanelErrorChars);
    this.report(err, 'panel script', { notify: true, webview: true });
  }

  /** A button on the card. */
  async answer(id: number, action: 'open' | 'dismiss'): Promise<void> {
    const shown = this.pending;
    if (shown?.id !== id) return;
    this.pending = null;
    this.gate.close();
    this.onChange();
    if (action === 'open') await this.open(shown.report);
  }

  dispose(): void {
    process.off('unhandledRejection', this.onRejection);
    process.off('uncaughtException', this.onException);
    this.output.dispose();
  }

  private fromProcess(err: unknown): void {
    if (err instanceof Error && belongsToUs(err.stack, this.ctx.extensionPath)) this.report(err, 'unhandled error');
  }

  private context(): SanitizeContext {
    const info = this.privateInfo();
    return {
      extensionPath: this.ctx.extensionPath,
      workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
      home: os.homedir(),
      terms: [info.username, info.fullName, hostnameOf(info.baseUrl), osUser(), os.hostname()],
    };
  }

  private offer(err: Error, where: string, opts: ReportOptions): void {
    const report = buildReport(
      { name: err.name, message: err.message, stack: err.stack, where, webview: opts.webview },
      {
        extensionVersion: String((this.ctx.extension.packageJSON as { version?: unknown }).version),
        appName: vscode.env.appName,
        appVersion: vscode.version,
        platform: process.platform,
        arch: process.arch,
      },
      this.context(),
    );
    this.output.appendLine(`Unexpected error:\n${report.report}`);
    if (!this.gate.admit(report.signature)) return;
    if (this.panelReady() && !opts.notify) {
      this.pending = { id: ++this.seq, report };
      // Not from here: this can run while the panel's state is being built.
      queueMicrotask(() => this.onChange());
    } else {
      void this.notify(report);
    }
  }

  /** No panel to show it in: a notification, then the exact text in a dialog before anything opens. */
  private async notify(report: CrashReport): Promise<void> {
    try {
      const pick = await vscode.window.showErrorMessage(S.crash.notice, S.crash.review, S.common.notNow);
      if (pick !== S.crash.review) return;
      const send = await vscode.window.showErrorMessage(S.crash.reviewTitle, { modal: true, detail: report.report }, S.crash.report);
      if (send === S.crash.report) await this.open(report);
    } finally {
      this.gate.close();
    }
  }

  /**
   * Given a Uri, VS Code decodes the query before opening it, so an `&` or a
   * `#` in the report would cut it short. A string is opened as it is.
   */
  private async open(report: CrashReport): Promise<void> {
    await vscode.env.openExternal(report.url as unknown as vscode.Uri);
  }
}
