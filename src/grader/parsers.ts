import * as cheerio from 'cheerio/slim';
import type { ListScoreInfo } from './types';

/**
 * HTML parsers for the few things the JSON API does not cover: the web login
 * form and the `/main/list` score column (hint / AI-assist penalties,
 * raw-sum mode).
 */

/** Remove zero-width spaces (cafe-grader inserts `_&ZeroWidthSpace;`) and collapse whitespace. */
export function cleanText(s: string | undefined | null): string {
  return (s ?? '').replace(/[​‌‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

export function extractCsrf(html: string): string | null {
  const $ = cheerio.load(html);
  return (
    $('meta[name="csrf-token"]').attr('content') ??
    $('input[name="authenticity_token"]').first().attr('value') ??
    null
  );
}

export interface LoginForm {
  present: boolean;
  token: string | null;
  /** `accept_agree` checkbox rendered: we never tick it, the user accepts on the website. */
  hasAgreement: boolean;
}

export function hasLoginForm(html: string): boolean {
  const $ = cheerio.load(html);
  return $('form[action$="/login/login"], form[action*="/login/login?"]').length > 0;
}

export function parseLoginForm(html: string): LoginForm {
  const $ = cheerio.load(html);
  const form = $('form[action$="/login/login"]').first();
  return {
    present: form.length > 0,
    token:
      form.find('input[name="authenticity_token"]').attr('value') ??
      $('meta[name="csrf-token"]').attr('content') ??
      null,
    hasAgreement: form.find('input[name="accept_agree"]').length > 0,
  };
}

/** Flash messages rendered by the layout (`.alert`), most important first. */
export function extractAlerts(html: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  $('.alert-danger, .alert-warning, .alert-info, .alert-success').each((_, el) => {
    const $el = $(el).clone();
    $el.find('button').remove();
    const t = cleanText($el.text());
    if (t) out.push(t);
  });
  return out;
}

const PROBLEM_ID_PATTERNS = [
  /\/submissions\/direct_edit_problem\/(\d+)/,
  /\/submissions\/prob\/(\d+)/,
  /\/problems\/(\d+)\/download/,
  /\/testcases\/show_problem\/(\d+)/,
  /\/problems\/(\d+)(?:\/|$)/,
];

function num(s: string | undefined | null): number | null {
  const m = /(-?\d+(?:\.\d+)?)/.exec(s ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Score column of `/main/list` per problem id (`app/views/main/_problem.html.haml`):
 * - `td[data-order]` = raw max points,
 * - raw-sum datasets: a bare `span.fw-semibold` with the raw score,
 * - otherwise `.progress` with the adjusted score (first bar) and the
 *   penalty (red bar), plus "Hint: n, AI Assist: n" and
 *   "Full score reduced by N".
 */
export function parseListScores(html: string): Map<number, ListScoreInfo> {
  const $ = cheerio.load(html);
  let rows = $('table#main_table tbody tr');
  if (rows.length === 0) rows = $('tr');
  const out = new Map<number, ListScoreInfo>();
  rows.each((_, tr) => {
    const row = $(tr);
    const hrefs = row.find('a[href]').map((_, a) => $(a).attr('href') ?? '').get();
    let id: number | null = null;
    for (const re of PROBLEM_ID_PATTERNS) {
      const h = hrefs.find((x) => re.test(x));
      if (h) {
        id = Number(re.exec(h)![1]);
        break;
      }
    }
    if (id === null || out.has(id)) return;
    const cell = row.children('td').eq(2);
    const progress = cell.find('.progress');
    const text = cleanText(cell.text());
    const rawSum = progress.length === 0 && cell.find('span.fw-semibold').length > 0;
    const bars = progress.find('.progress-bar');
    out.set(id, {
      rawMax: num(cell.attr('data-order')),
      adjusted: rawSum ? null : num(bars.eq(0).text()),
      cost: num(/Full score reduced by\s*([\d.]+)/i.exec(text)?.[1]) ?? 0,
      hintCount: num(/Hint:\s*(\d+)/i.exec(text)?.[1]) ?? 0,
      aiCount: num(/AI Assist:\s*(\d+)/i.exec(text)?.[1]) ?? 0,
      rawSum,
    });
  });
  return out;
}
