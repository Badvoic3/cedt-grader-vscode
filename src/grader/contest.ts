import * as cheerio from 'cheerio/slim';
import { cleanText } from './parsers';
import type { ContestDetection } from './types';

/**
 * Decide from page HTML whether the grader is running a contest/exam.
 *
 * Source of truth (cafe-grader-web `app/views/layouts/_header.html.haml`,
 * `app/views/main/_contest_box.html.haml`): the header partial is rendered on
 * every logged-in page and
 *   - renders `#countdown` only in contest / indv-contest / analysis mode,
 *   - starts `setTimeout(checkInLoop, ...)` only while a contest is running,
 *   - fills `Date.parse('<contest stop>')` whenever system.mode == contest
 *     and the user has an enabled contest.
 * `/main/list` additionally shows `#contest-table` / the "system is in
 * contest mode" text in contest mode.
 *
 * Policy: a page is "not a contest" only when it is positively recognised as
 * a normal logged-in page with none of the markers. Anything unexpected is
 * uncertain, and uncertain is treated as a contest.
 *
 * This function only reads HTML. It never contacts the server.
 */
export function detectContest(html: string, now: Date = new Date()): ContestDetection {
  const $ = cheerio.load(html);
  const scripts = $('script')
    .map((_, s) => $(s).html() ?? '')
    .get()
    .join('\n');
  const signals: string[] = [];
  let contest = false;

  const headerPresent = /function\s+checkInLoop\s*\(/.test(scripts);
  if (headerPresent) signals.push('header-script');

  // 1. #countdown element.
  const countdown = $('#countdown').first();
  let analysis = false;
  if (countdown.length) {
    const text = cleanText(countdown.text());
    if (/^ANALYSIS MODE$/i.test(text)) {
      analysis = true;
      signals.push('countdown:analysis-mode');
    } else {
      contest = true;
      signals.push(`countdown:${text ? text : '(running)'}`);
    }
  }

  // 2. Check-in loop started. `checkInLoop()` reschedules itself with
  // `setTimeout(checkInLoop, ...)` (several times) inside its own body on
  // every page, so the bodies of the header functions are removed first; a
  // remaining call can only be the start from the contest `load` listener.
  const outside = stripFunctionBodies(scripts, ['checkInLoop', 'updateRemainingTime']);
  if (/setTimeout\(\s*checkInLoop\b|setInterval\(\s*updateRemainingTime\b/.test(outside)) {
    contest = true;
    signals.push('check-in-loop-started');
  }

  // 3. Contest end time in the page script.
  let endTime: string | undefined;
  let uncertain = false;
  const endM = /Date\.parse\(\s*'([^']*)'\s*\)/.exec(scripts);
  if (endM && endM[1].trim() !== '') {
    endTime = endM[1].trim();
    const extraM = /const\s+extraTime\s*=\s*(\d+)/.exec(scripts);
    const extraMs = extraM ? Number(extraM[1]) * 1000 : 0;
    const end = Date.parse(endTime);
    // A filled end time only happens in contest mode, whether or not it has passed.
    contest = true;
    if (Number.isNaN(end)) {
      uncertain = true;
      signals.push('contest-end-time:unparseable');
    } else if (now.getTime() < end + extraMs) {
      signals.push('contest-end-time:running');
    } else {
      signals.push('contest-end-time:past');
    }
  }

  // 4. /main/list contest box.
  const table = $('#contest-table');
  if (table.length) {
    contest = true;
    signals.push('contest-table');
    table.find('.time-counter').each((_, el) => {
      const $el = $(el);
      const start = Date.parse($el.attr('data-start') ?? '');
      const stop = Date.parse($el.attr('data-stop') ?? '');
      const offset = Number($el.attr('data-start-offset') ?? 0) * 1000 || 0;
      const extra = Number($el.attr('data-extra-time') ?? 0) * 1000 || 0;
      if (!Number.isNaN(start) && !Number.isNaN(stop)) {
        if (now.getTime() >= start - offset && now.getTime() <= stop + extra) {
          signals.push('contest-window:open');
        }
      }
    });
  }
  if (/system is in contest mode/i.test(cleanText($('body').text() || $.root().text()))) {
    contest = true;
    signals.push('contest-mode-text');
  }

  let contestName: string | undefined;
  table.find('tr').each((_, tr) => {
    const row = $(tr);
    if (/\(Active\)/.test(row.text()) && !contestName) {
      const cell = row.children('td').first().clone();
      cell.find('em').remove();
      contestName = cleanText(cell.text()) || undefined;
    }
  });

  const base = { signals, ...(contestName ? { contestName } : {}), ...(endTime ? { endTime } : {}) };

  if (contest) {
    return {
      inContest: true,
      certain: !uncertain,
      reason: contestName
        ? `Contest "${contestName}" is active on the grader.`
        : 'The grader is in contest/exam mode.',
      ...base,
    };
  }
  if (!headerPresent) {
    return {
      inContest: true,
      certain: false,
      reason: 'Could not confirm that this is a normal (non-contest) grader page; treating it as a contest.',
      ...base,
    };
  }
  return {
    inContest: false,
    certain: true,
    reason: analysis ? 'Analysis mode (no running contest).' : 'No contest markers found.',
    ...base,
  };
}

/** Remove `function name(...) { ... }` bodies (brace-matched) from script text. */
export function stripFunctionBodies(js: string, names: string[]): string {
  let out = js;
  for (const name of names) {
    const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(out))) {
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < out.length && depth > 0; i++) {
        if (out[i] === '{') depth++;
        else if (out[i] === '}') depth--;
      }
      out = out.slice(0, m.index) + `function ${name}(){}` + out.slice(i);
      re.lastIndex = m.index + 1;
    }
  }
  return out;
}

/** True when the caller must block (contest or uncertain). */
export function mustBlock(d: ContestDetection): boolean {
  return d.inContest || !d.certain;
}
