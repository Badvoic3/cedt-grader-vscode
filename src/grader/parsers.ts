import * as cheerio from 'cheerio/slim';
import type { Evaluation, Language, Problem, SubmissionStatus, SubmitPage, Verdict } from './types';

type CheerioAPI = cheerio.CheerioAPI;

/** Remove zero-width spaces (cafe-grader inserts `_&ZeroWidthSpace;`) and collapse whitespace. */
export function cleanText(s: string | undefined | null): string {
  return (s ?? '').replace(/[​‌‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

/** Turbo-stream responses wrap the HTML in `<template>`; return the concatenated inner HTML. */
export function unwrapTurboStream(html: string): string {
  if (!/<turbo-stream\b/i.test(html)) return html;
  const parts: string[] = [];
  const re = /<template>([\s\S]*?)<\/template>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) parts.push(m[1]);
  return parts.join('\n');
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
  /** `accept_agree` checkbox rendered (contest/exam mode forces it on). */
  hasAgreement: boolean;
  agreementValue: string;
  agreementText: string;
}

export function hasLoginForm(html: string): boolean {
  const $ = cheerio.load(html);
  return $('form[action$="/login/login"], form[action*="/login/login?"]').length > 0;
}

export function parseLoginForm(html: string): LoginForm {
  const $ = cheerio.load(html);
  const form = $('form[action$="/login/login"]').first();
  const present = form.length > 0;
  const token =
    form.find('input[name="authenticity_token"]').attr('value') ??
    $('meta[name="csrf-token"]').attr('content') ??
    null;
  const agree = form.find('input[name="accept_agree"]').first();
  let agreementText = '';
  if (agree.length) {
    const id = agree.attr('id');
    const label = id ? form.find(`label[for="${id}"]`).text() : '';
    agreementText = cleanText(label || agree.parent().text());
  }
  return {
    present,
    token,
    hasAgreement: agree.length > 0,
    agreementValue: agree.attr('value') ?? '1',
    agreementText,
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

function problemIdFromRow($: CheerioAPI, row: cheerio.Cheerio<any>): number | null {
  const hrefs = row
    .find('a[href]')
    .map((_, a) => $(a).attr('href') ?? '')
    .get();
  for (const re of PROBLEM_ID_PATTERNS) {
    for (const h of hrefs) {
      const m = re.exec(h);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

/** Parse the problem table on `/main/list`. */
export function parseProblemList(html: string): Problem[] {
  const $ = cheerio.load(html);
  let rows = $('table#main_table tbody tr');
  if (rows.length === 0) rows = $('tr');
  const seen = new Map<number, Problem>();

  rows.each((_, tr) => {
    const row = $(tr);
    const id = problemIdFromRow($, row);
    if (id === null || seen.has(id)) return;

    const name = cleanText(row.find('.font-monospace').first().text());
    const fullName = cleanText(row.find('strong').first().text());

    let bestScore: number | null = null;
    const tds = row.children('td');
    const scoreCell = tds.length > 2 ? tds.eq(2) : row.find('.progress').closest('td');
    const order = scoreCell.attr('data-order');
    if (order !== undefined && order !== '' && !Number.isNaN(Number(order))) {
      bestScore = Number(order);
    } else {
      const bar = scoreCell.find('[aria-valuenow]').attr('aria-valuenow');
      const txt = bar ?? cleanText(scoreCell.text());
      const m = /(-?\d+(?:\.\d+)?)/.exec(txt ?? '');
      if (m) bestScore = Number(m[1]);
    }

    let latestSubmissionId: number | null = null;
    row.find('a[href]').each((_, a) => {
      const m = /\/submissions\/(\d+)(?:$|[?#])/.exec($(a).attr('href') ?? '');
      if (m && latestSubmissionId === null) latestSubmissionId = Number(m[1]);
    });

    const statementUrl =
      row.find('a[href*="/download/statement"]').attr('href') ??
      row.find('a[href*="/problems/"][href*="statement"]').attr('href');
    const testcasesUrl = row.find('a[href*="/testcases/show_problem/"]').attr('href');

    seen.set(id, {
      id,
      name: name || fullName || `#${id}`,
      fullName: fullName || name,
      bestScore,
      latestSubmissionId,
      ...(statementUrl ? { statementUrl } : {}),
      ...(testcasesUrl ? { testcasesUrl } : {}),
    });
  });
  return [...seen.values()];
}

/** Parse `/submissions/direct_edit_problem/{id}` (or `/submissions/{id}/edit`). */
export function parseSubmitPage(html: string, problemId: number): SubmitPage {
  const $ = cheerio.load(html);
  const form = $('form[action$="/main/submit"]').first();
  const select = $('select[name="language_id"]').first();
  const languages: Language[] = [];
  select.find('option').each((_, o) => {
    const $o = $(o);
    const id = Number($o.attr('value'));
    if (!Number.isFinite(id)) return;
    languages.push({ id, name: cleanText($o.text()), selected: $o.is('[selected]') });
  });

  const pid = Number(form.find('input[name="submission[problem_id]"]').attr('value'));
  const title = $('h3').first();
  const problemName = cleanText(title.find('span.font-monospace').first().text()) || null;
  const problemFullName =
    cleanText(title.find('span').not('.font-monospace').first().text()) || null;

  return {
    problemId: Number.isFinite(pid) && pid > 0 ? pid : problemId,
    problemName,
    problemFullName,
    languages,
    languageForced: select.is('[disabled]'),
    canSubmit: form.length > 0,
    csrfToken:
      form.find('input[name="authenticity_token"]').attr('value') ??
      $('meta[name="csrf-token"]').attr('content') ??
      null,
  };
}

/** Find the current user's numeric id in page HTML (header link or poll URL). */
export function parseUserId(html: string): number | null {
  const $ = cheerio.load(html);
  const attr = $('[data-user-id]').first().attr('data-user-id');
  if (attr && /^\d+$/.test(attr)) return Number(attr);
  const m = /get_latest_submission_status\/(\d+)\/\d+/.exec(html);
  return m ? Number(m[1]) : null;
}

/** The poll URL rendered by `/submissions/{id}/edit` (`a#refresh` / `turbo-frame#latest_status`). */
export function parsePollUrl(html: string): string | null {
  const $ = cheerio.load(html);
  const href =
    $('a#refresh').attr('href') ??
    $('turbo-frame#latest_status').attr('src') ??
    $('a[href*="get_latest_submission_status"]').first().attr('href');
  if (href) return href;
  const m = /\/submissions\/get_latest_submission_status\/\d+\/\d+/.exec(html);
  return m ? m[0] : null;
}

const VERDICT_KIND_OK = new Set(['correct']);

/** Parse the `get_latest_submission_status` turbo-stream (or the `_submission_short` partial). */
export function parseSubmissionStatus(html: string): SubmissionStatus {
  const inner = unwrapTurboStream(html);
  const $ = cheerio.load(`<div id="__root">${inner}</div>`);
  const root = $('#__root');
  const text = cleanText(root.text());

  const empty: SubmissionStatus = {
    id: null,
    state: 'none',
    score: null,
    tries: null,
    time: null,
    comment: null,
    verdicts: [],
    compileError: false,
    refreshDelayMs: null,
    refreshUrl: null,
  };
  if (text === '' || text === '-') return empty;

  let id: number | null = null;
  root.find('a[href]').each((_, a) => {
    const m = /\/submissions\/(\d+)(?:$|[?#])/.exec($(a).attr('href') ?? '');
    if (m && id === null) id = Number(m[1]);
  });

  const triesM = /(\d+)\s+tr(?:y|ies)\b/i.exec(text);
  const tries = triesM ? Number(triesM[1]) : null;

  const timeEl = root
    .find('span.text-secondary')
    .filter((_, el) => /^\(.*\)$/.test(cleanText($(el).text())))
    .first();
  const time = timeEl.length ? cleanText(timeEl.text()).replace(/^\(|\)$/g, '') : null;

  const pending =
    /Waiting to be graded/i.test(text) ||
    root.find('[data-refresh-target="waitingText"]').length > 0 ||
    root.find('.mi').filter((_, el) => cleanText($(el).text()) === 'hourglass').length > 0;

  const delayAttr = root.find('[data-refresh-delay-value]').attr('data-refresh-delay-value');
  const refreshDelayMs = delayAttr && /^\d+$/.test(delayAttr) ? Number(delayAttr) : null;
  const refreshUrl = root.find('a[href*="get_latest_submission_status"]').attr('href') ?? null;

  // Score: span following the `speed` material icon.
  let score: number | null = null;
  const speed = root.find('.mi').filter((_, el) => cleanText($(el).text()) === 'speed').first();
  if (speed.length) {
    const s = cleanText(speed.nextAll('span').first().text());
    const m = /^(-?\d+(?:\.\d+)?)/.exec(s);
    if (m) score = Number(m[1]);
  }

  // Verdict strip.
  const verdicts: Verdict[] = [];
  const strip = root.find('.verdict-strip').first();
  let comment: string | null = strip.attr('data-comment') ?? null;
  const groups = strip.find('.verdict-group').toArray();
  strip.find('.verdict-tile').each((i, el) => {
    const $el = $(el);
    const classes = ($el.attr('class') ?? '').split(/\s+/);
    const kindClass = classes.find((c) => c.startsWith('verdict-') && c !== 'verdict-tile');
    const kind = kindClass ? kindClass.slice('verdict-'.length) : 'unknown';
    const label = cleanText($el.attr('title') ?? $el.text()) || `Test ${i + 1}`;
    const idxM = /Test\s+(\d+)/i.exec(label);
    const groupEl = $el.closest('.verdict-group');
    const v: Verdict = {
      index: idxM ? Number(idxM[1]) : i + 1,
      ok: VERDICT_KIND_OK.has(kind),
      label,
      kind,
    };
    if (groupEl.length) v.group = (groups as unknown[]).indexOf(groupEl.get(0)) + 1;
    verdicts.push(v);
  });

  if (comment === null) {
    const gc = root.find('.grader-comment').first();
    if (gc.length) comment = cleanText(gc.text()).replace(/^\[|\]$/g, '').trim() || null;
  }

  const compileError =
    /compil(?:ation|e) error/i.test(comment ?? '') ||
    root
      .find('a.link-danger')
      .filter((_, a) => /compiler/i.test($(a).text()))
      .length > 0;

  const graded =
    !pending &&
    (score !== null ||
      strip.length > 0 ||
      comment !== null ||
      root.find('.mi').filter((_, el) => cleanText($(el).text()) === 'calendar_clock').length > 0);

  return {
    id,
    state: pending ? 'pending' : graded ? 'graded' : id !== null ? 'pending' : 'none',
    score,
    tries,
    time,
    comment,
    verdicts,
    compileError,
    refreshDelayMs,
    refreshUrl,
  };
}

/** Compiler message from the `compiler_msg` turbo-stream modal. */
export function parseCompilerMessage(html: string): string {
  const inner = unwrapTurboStream(html);
  const $ = cheerio.load(inner);
  const pre = $('.modal-body pre').first();
  if (pre.length) return pre.text().replace(/\s+$/, '');
  const body = $('.modal-body').first();
  if (body.length) return body.text().trim();
  return $('pre').first().text().trim();
}

/** Per-test rows from the `evaluations` turbo-stream modal (lenient). */
export function parseEvaluations(html: string): Evaluation[] {
  const inner = unwrapTurboStream(html);
  const $ = cheerio.load(inner);
  const out: Evaluation[] = [];
  $('.modal-body .row.mb-1').each((_, row) => {
    const cols = $(row)
      .children()
      .toArray()
      .map((c, i) =>
        // Result column holds a code span + a badge: keep them apart.
        i === 3 && $(c).children().length
          ? cleanText($(c).children().toArray().map((k) => $(k).text()).join(' '))
          : cleanText($(c).text()),
      );
    if (cols.length < 2) return;
    out.push({
      num: cols[0] ?? '',
      time: cols[1] ?? null,
      memory: cols[2] ?? null,
      result: cols[3] ?? null,
      score: cols[4] ?? null,
    });
  });
  return out;
}
