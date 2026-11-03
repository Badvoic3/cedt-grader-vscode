/**
 * Problem attachment (`GET /api/v1/problems/{id}/files/attachment`):
 * `Api::V1::ProblemsController#file` answers with `send_data`, the stored
 * content type and `Content-Disposition: attachment; filename="…";
 * filename*=UTF-8''…`. Pure helpers (no `vscode` import).
 */

export interface Attachment {
  bytes: Uint8Array;
  /** File name from Content-Disposition (base name only), null when missing or unusable. */
  filename: string | null;
  contentType: string | null;
}

/**
 * The file name in a Content-Disposition header: `filename*=UTF-8''…`
 * (RFC 5987, percent-decoded) first, else `filename="…"` / `filename=…`.
 * Directory parts are dropped; a name that is still unusable gives null.
 */
export function parseContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  let name: string | null = null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      name = decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      name = null;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
    // Quoted: backslash escapes (RFC 6266); unquoted: taken as it is.
    if (plain) name = (plain[1] !== undefined ? plain[1].replace(/\\(.)/g, '$1') : (plain[2] ?? '')).trim();
  }
  if (!name) return null;
  name = name.split(/[\\/]/).pop()!.normalize('NFC').trim();
  if (!name || name === '.' || name === '..' || /[:*?"<>|\u0000-\u001f]/.test(name)) return null;
  return name;
}
