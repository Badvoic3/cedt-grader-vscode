/** A problem row from `/main/list`. */
export interface Problem {
  id: number;
  /** Short code name, e.g. `DigLo69_Exam2__1`. */
  name: string;
  /** Human title. */
  fullName: string;
  /** Best score so far (0–100), or null when untried / not shown. */
  bestScore: number | null;
  /** Latest submission id shown in the row, if any. */
  latestSubmissionId: number | null;
  /** Relative URLs found in the row (may be absent). */
  statementUrl?: string;
  testcasesUrl?: string;
}

export interface Language {
  id: number;
  /** Pretty name as shown in the `<select>`, e.g. `C++`. */
  name: string;
  selected: boolean;
}

export interface SubmitPage {
  problemId: number;
  problemName: string | null;
  problemFullName: string | null;
  languages: Language[];
  /** `<select>` disabled → only one language allowed, server forces it. */
  languageForced: boolean;
  /** Submit form present (problem open for submissions). */
  canSubmit: boolean;
  csrfToken: string | null;
  /** `isContestPage()` on this page (exam warning only). */
  contestPage: boolean;
}

export interface Verdict {
  /** 1-based test number. */
  index: number;
  ok: boolean;
  /** Raw `title` text, e.g. `Test 10 of 20: Wrong Answer`. */
  label: string;
  /** The verdict-* class suffix, e.g. `correct`, `wrong`, `time_limit` (or `unknown`). */
  kind: string;
  /** Group number when the tile is inside a `.verdict-group`. */
  group?: number;
}

export type SubmissionState = 'none' | 'pending' | 'graded';

export interface SubmissionStatus {
  id: number | null;
  state: SubmissionState;
  /** Score as shown (e.g. 70), null when pending or hidden by the server. */
  score: number | null;
  tries: number | null;
  /** Time text, e.g. `14:03:22`, if present. */
  time: string | null;
  /** `data-comment` of the verdict strip, or the plain grader comment without brackets. */
  comment: string | null;
  verdicts: Verdict[];
  compileError: boolean;
  /** Server-suggested refresh delay in ms (pending only). */
  refreshDelayMs: number | null;
  /** Poll URL rendered by the server (pending only), relative. */
  refreshUrl: string | null;
}

export interface Evaluation {
  num: string;
  time: string | null;
  memory: string | null;
  result: string | null;
  score: string | null;
}
