/**
 * Secret registry + redaction. Every value that must never appear in logs or
 * error messages (password, CSRF tokens, cookie values) is registered here and
 * replaced with `***` by `redact()`.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  add(value: string | null | undefined): void {
    if (value && value.length >= 4) this.secrets.add(value);
  }

  clear(): void {
    this.secrets.clear();
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join('***');
    return redactPatterns(out);
  }
}

/** Pattern based redaction for things we may not have registered explicitly. */
export function redactPatterns(text: string): string {
  return text
    .replace(/(authenticity_token=)[^&\s"']+/gi, '$1***')
    .replace(/(name=["']authenticity_token["'][^>]*value=["'])[^"']*/gi, '$1***')
    .replace(/(name=["']csrf-token["'][^>]*content=["'])[^"']*/gi, '$1***')
    .replace(/(x-csrf-token:\s*)\S+/gi, '$1***')
    .replace(/(_cafe_grader_session=)[^;\s]+/gi, '$1***')
    .replace(/(uuid=)[^;\s]+/gi, '$1***')
    .replace(/((?:set-)?cookie:\s*)[^\n]+/gi, '$1***')
    .replace(/(password=)[^&\s]+/gi, '$1***');
}
