import * as vscode from 'vscode';
import type { DataService } from '../data/dataService';
import { type Attachment, classifyConnectionError, type Problem, ProblemUnavailableError } from '../grader';
import { attachmentKind, AttachmentError, extractedFileToOpen, freeFolderName, ownFolderStem, planZip, writeExtracted, writeNewFile } from '../mapping/attachment';
import { fileNameFor, folderNameFor } from '../mapping/match';
import { pathExists as exists } from '../mapping/newFile';
import { freeName, nameMatchesProblem, renameProposal } from '../mapping/renameToProblem';
import { S } from '../shared/strings';
import type { Host } from './host';

/**
 * The problem's attachment (the website's "File"), only on click: a single
 * file is saved next to the active file (or in the workspace root) and may
 * be renamed to match the problem; a zip is extracted into a NEW folder,
 * after one question that also offers folder mode. Never overwrites.
 * Extraction rules: src/mapping/attachment.ts.
 */
export class Attachments {
  constructor(private readonly host: Host) {}

  async download(problemId?: number): Promise<void> {
    const h = this.host;
    const id = problemId ?? h.currentProblem()?.id;
    const p = id === undefined ? undefined : h.problemById(id);
    if (!p) {
      void vscode.window.showInformationMessage(S.submit.chooseFirst);
      return;
    }
    const dir = (h.fileUri ? vscode.Uri.joinPath(h.fileUri, '..') : undefined) ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!dir) {
      void vscode.window.showInformationMessage(S.files.openFolderFirst);
      return;
    }
    if (!(await h.ensureLoggedIn())) return;
    let a: Awaited<ReturnType<DataService['downloadAttachment']>>;
    try {
      const pending = h.data.downloadAttachment(p.id);
      h.emit(); // busy
      a = await pending;
    } catch (err) {
      if (err instanceof ProblemUnavailableError) h.markUnavailable(p.id);
      if (classifyConnectionError(err)) h.reportError(err, null);
      else await h.tellInline(err, h.describe(err));
      return;
    } finally {
      h.emit();
    }
    if (a.status !== 200) {
      await h.tellInline(null, S.attachment.none(p.name));
      return;
    }
    try {
      if (attachmentKind(a.filename, a.contentType, a.bytes) === 'zip') await this.extract(p, dir, a);
      else await this.saveFile(p, dir, a);
    } catch (err) {
      await h.tellInline(err, err instanceof AttachmentError ? err.message : S.attachment.writeFailed(h.describe(err)));
    }
  }

  /** A single-file attachment: saved under its own name (`_2` if taken), opened, then "Rename to match the problem?". */
  private async saveFile(p: Problem, dir: vscode.Uri, a: Attachment): Promise<void> {
    const h = this.host;
    const pattern = h.cfg.fileNamePattern.pattern;
    const ext = a.filename?.includes('.') ? a.filename.split('.').pop()! : 'txt';
    const desired = a.filename ?? fileNameFor(p.name, ext, pattern, p.id);
    const name = await freeName(desired, (n) => exists(vscode.Uri.joinPath(dir, n).fsPath));
    const target = vscode.Uri.joinPath(dir, name);
    await writeNewFile(target.fsPath, a.bytes);
    const source = h.allSourceExts().includes(ext.toLowerCase());
    if (source) await h.mapping.set(target, { problemId: p.id, name: p.name, baseUrl: h.cfg.baseUrl });
    await this.openDownloaded(target, source);
    if (!source || nameMatchesProblem(target.fsPath, p.name, pattern, p.id)) return;
    const proposal = await freeName(renameProposal(target.fsPath, p.name, pattern, p.id), (n) => exists(vscode.Uri.joinPath(dir, n).fsPath));
    const pick = await h.askInline(S.attachment.renameQ(name, proposal), [
      { id: 'rename', label: S.attachment.rename, primary: true },
      { id: 'keep', label: S.attachment.keepName },
    ]);
    if (pick !== 'rename') return;
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(target, vscode.Uri.joinPath(dir, proposal), { overwrite: false });
    // Links and editors follow (onDidRenameFiles).
    if (!(await vscode.workspace.applyEdit(edit))) void vscode.window.showWarningMessage(S.rename.failed(proposal));
  }

  private async openDownloaded(uri: vscode.Uri, text: boolean): Promise<void> {
    try {
      if (text) await vscode.window.showTextDocument(uri);
      else await vscode.commands.executeCommand('vscode.open', uri);
    } catch {
      await vscode.commands.executeCommand('revealInExplorer', uri);
    }
  }

  /**
   * A zip attachment: checked completely in memory first (paths, sizes), then
   * one question: extract into "<problem name>/" and link it (folder mode),
   * extract under its own name without linking, or cancel. A new folder only.
   */
  private async extract(p: Problem, dir: vscode.Uri, a: Attachment): Promise<void> {
    const h = this.host;
    const plan = planZip(a.bytes);
    const taken = (n: string) => exists(vscode.Uri.joinPath(dir, n).fsPath);
    const linkedName = await freeFolderName(folderNameFor(p.name, h.cfg.fileNamePattern.pattern, p.id), taken);
    const ownName = await freeFolderName(ownFolderStem(plan.topFolder, a.filename), taken);
    const names = plan.files.map((f) => f.rel);
    const pick = await h.askInline(
      S.attachment.extractQ(a.filename ?? 'zip', plan.files.length, vscode.workspace.asRelativePath(dir) || '.'),
      [
        { id: 'link', label: S.attachment.extractAndLink(linkedName), primary: true },
        ...(ownName !== linkedName ? [{ id: 'own', label: S.attachment.extractOnly(ownName) }] : []),
        { id: 'cancel', label: S.common.cancel },
      ],
      { detail: S.attachment.contents(names.slice(0, 6).join(', '), names.length) },
    );
    if (pick !== 'link' && pick !== 'own') return;
    const folder = vscode.Uri.joinPath(dir, pick === 'link' ? linkedName : ownName);
    await writeExtracted(folder.fsPath, plan.files);
    h.onFileEvent();
    if (pick === 'link') {
      await h.mapping.set(folder, { problemId: p.id, name: p.name, baseUrl: h.cfg.baseUrl, folder: true });
      await h.links.refreshMappedIds();
    }
    await vscode.commands.executeCommand('revealInExplorer', folder);
    // Submit / run files are detected from the folder (folderRoles.ts); open the file to edit.
    const open = extractedFileToOpen(plan.files, h.allSourceExts());
    if (open) await this.openDownloaded(vscode.Uri.joinPath(folder, ...open.split('/')), true);
    else h.emit();
  }
}
