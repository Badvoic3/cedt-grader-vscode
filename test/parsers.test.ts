import { describe, expect, it } from 'vitest';
import { cleanText, extractAlerts, extractCsrf, hasLoginForm, parseListScores, parseLoginForm, sanitizeHtml, sanitizeJson } from '../src/grader';
import { fixture, realFixture } from './helpers';

describe('cleanText', () => {
  it('strips zero-width characters and collapses whitespace', () => {
    expect(cleanText(' p01_​sum‌‍﻿ \n x ')).toBe('p01_sum x');
  });
});

describe('web login page', () => {
  it('finds the form, token and alert', () => {
    const html = fixture('login_page.synthetic.html');
    expect(hasLoginForm(html)).toBe(true);
    expect(parseLoginForm(html)).toEqual({ present: true, token: 'REDACTED', hasAgreement: false });
    expect(extractAlerts(html)).toEqual(['Wrong password']);
  });

  const real = realFixture('login_page.html');
  it.runIf(real)('real login page', () => {
    const f = parseLoginForm(real!);
    expect(f.present).toBe(true);
    expect(f.token).toBeTruthy();
    expect(f.hasAgreement).toBe(false);
  });
});

describe('parseListScores (/main/list score column)', () => {
  it('reads penalties, hint/AI counts and raw-sum mode', () => {
    const m = parseListScores(fixture('main_list.penalties.synthetic.html'));
    expect(m.get(201)).toEqual({ rawMax: 100, adjusted: 90, cost: 10, hintCount: 0, aiCount: 2, rawSum: false });
    expect(m.get(202)).toEqual({ rawMax: 40, adjusted: 40, cost: 25, hintCount: 1, aiCount: 1, rawSum: false });
    expect(m.get(203)).toEqual({ rawMax: 137.5, adjusted: null, cost: 0, hintCount: 0, aiCount: 0, rawSum: true });
    expect(m.get(204)).toEqual({ rawMax: 70, adjusted: 70, cost: 0, hintCount: 0, aiCount: 0, rawSum: false });
  });

  const real = realFixture('main_list.html');
  it.runIf(real)('real list: every problem row, raw max matches the green bar when no penalty', () => {
    const m = parseListScores(real!);
    expect(m.size).toBe(292);
    expect(m.get(1360)).toMatchObject({ rawMax: 100, adjusted: 100, cost: 0, rawSum: false });
    for (const v of m.values()) if (!v.rawSum && v.cost === 0 && v.adjusted !== null) expect(v.adjusted).toBe(v.rawMax);
    expect(extractCsrf(real!)).toBeTruthy();
  });
});

describe('sanitizers', () => {
  it('sanitizeHtml removes tokens, names, user id, e-mails and student ids', () => {
    const html = `<html><head><meta name="csrf-token" content="SECRETTOKEN123"></head><body>
      <a data-user-id="4242" href="/users/profile"><span class="mi md-18">settings</span></a>
      <a href="/main/logout"><span class="mi md-18">exit_to_app</span> Somchai Jaidee</a>
      <input type="hidden" name="authenticity_token" value="SECRETTOKEN456">
      <a href="/submissions/get_latest_submission_status/4242/9">x</a>
      Hello Somchai Jaidee (6730123421) somchai@student.chula.ac.th login 6730123421</body></html>`;
    const out = sanitizeHtml(html, { personal: ['6730123421'], userId: 4242 });
    expect(out).not.toMatch(/SECRETTOKEN|Somchai|4242|6730123421|chula/);
    expect(out).toContain('get_latest_submission_status/12345/9');
    expect(out).toContain('>settings<');
  });

  it('sanitizeJson scrubs user fields and source code', () => {
    const out = sanitizeJson(
      { id: 9, user_id: 4242, login: '6730123421', full_name: 'Somchai Jaidee', source: 'int main(){}', token: 'abc', note: 'by 6730123421' },
      { personal: ['6730123421', 'Somchai Jaidee'], userId: 4242 },
    );
    expect(out).toEqual({ id: 9, user_id: 12345, login: 'student', full_name: 'Student Name', source: '// source removed', token: 'REDACTED', note: 'by student' });
  });
});
