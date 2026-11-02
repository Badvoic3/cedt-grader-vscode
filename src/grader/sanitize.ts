import * as cheerio from 'cheerio/slim';
import { cleanText } from './parsers';
import { redactPatterns } from './redact';

export interface SanitizeOptions {
  /** Strings to replace everywhere (login name, full name, ...). */
  personal?: string[];
  userId?: number | null;
}

const FAKE_USER_ID = '12345';

/**
 * Strip secrets and personal data from a grader HTML page before saving it
 * as a test fixture: CSRF tokens, the user's login/full name, the numeric
 * user id, e-mail addresses and student-ID-like digit runs.
 */
export function sanitizeHtml(html: string, opts: SanitizeOptions = {}): string {
  const $ = cheerio.load(html, {}, /\bhtml\b/i.test(html.slice(0, 500)));

  $('meta[name="csrf-token"]').attr('content', 'REDACTED');
  $('meta[name="csrf-param"]').attr('content', 'authenticity_token');
  $('input[name="authenticity_token"]').attr('value', 'REDACTED');
  $('input[name="login"], input[name="password"]').attr('value', '');

  // The header shows the user's full name next to the profile / logout icons
  // (`<a href="/main/logout"><span class="mi">exit_to_app</span> Full Name</a>`).
  // Icon spans (`.mi`) hold Material icon names, not personal data.
  const personal = new Set((opts.personal ?? []).filter((s) => s && s.length >= 2));
  $('a[href$="/users/profile"], a[data-user-id], a[href$="/main/logout"], a[href$="/login/logout"]').each((_, a) => {
    const $a = $(a).clone();
    $a.find('.mi, .material-icons, i').remove();
    const t = cleanText($a.text());
    if (t && !/^(log ?out|sign ?out|exit)$/i.test(t)) {
      personal.add(t);
      for (const part of t.split(' ')) if (part.length >= 2) personal.add(part);
    }
    if ($(a).attr('data-user-id') !== undefined) $(a).attr('data-user-id', FAKE_USER_ID);
  });

  let out = $.html();
  out = redactPatterns(out);

  for (const p of [...personal].sort((a, b) => b.length - a.length)) {
    out = out.split(p).join('Student Name');
  }
  if (opts.userId != null) {
    const uid = String(opts.userId);
    out = out
      .replace(new RegExp(`(get_latest_submission_status/)${uid}(/)`, 'g'), `$1${FAKE_USER_ID}$2`)
      .replace(new RegExp(`(data-user-id=["'])${uid}(["'])`, 'g'), `$1${FAKE_USER_ID}$2`)
      .replace(new RegExp(`(/users/)${uid}\\b`, 'g'), `$1${FAKE_USER_ID}`);
  }
  out = out
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'student@example.com')
    // Chula student IDs are 10 digits (e.g. 67xxxxxx21).
    .replace(/\b\d{10}\b/g, '0000000000');
  return out;
}

/**
 * Strip personal data from an API JSON response before saving it as a
 * fixture: user id → 12345, login/full name/e-mail → placeholders, source
 * code removed, and any `personal` strings replaced.
 */
export function sanitizeJson(value: unknown, opts: SanitizeOptions = {}): unknown {
  const personal = (opts.personal ?? []).filter((s) => s && s.length >= 2);
  const scrub = (s: string) => {
    let out = s;
    for (const p of personal) out = out.split(p).join('student');
    return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'student@example.com').replace(/\b\d{10}\b/g, '0000000000');
  };
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x, k);
      return o;
    }
    if (key === 'token') return 'REDACTED';
    if (key === 'user_id' || (key === 'id' && opts.userId != null && v === opts.userId)) return Number(FAKE_USER_ID);
    if (key === 'login') return 'student';
    if (key === 'full_name' && personal.some((p) => String(v).includes(p))) return 'Student Name';
    if (key === 'email') return 'student@example.com';
    if (key === 'source') return v == null ? v : '// source removed';
    if (typeof v === 'string') return scrub(v);
    return v;
  };
  return walk(value);
}
