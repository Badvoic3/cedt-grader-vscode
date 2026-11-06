import type { Attachment } from './attachment';
import type { Redactor } from './redact';
import type { GraderUser, Language, Problem, StoredToken, SubmissionBrief, SubmissionDetail, TestcaseInfo, TopicTag, Verdict } from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Logger = (line: string) => void;

/** What a grader server can do; the UI hides what a provider cannot. */
export interface GraderCapabilities {
  testcases: boolean;
  pdfStatement: boolean;
  attachments: boolean;
  penaltyHtml: boolean;
  rawSumScores: boolean;
}

export interface Credentials {
  username: string;
  password: string;
}

export interface TokenStore {
  load(): Promise<StoredToken | undefined>;
  save(t: StoredToken | undefined): Promise<void>;
}

export interface ProblemList {
  problems: Problem[];
  /** Topic tags shown as filter pills on the website; null when the list page was unavailable (use all tags). */
  topics: TopicTag[] | null;
  /** Penalty data from `/main/list`: 'loaded', or why it is missing. */
  listStatus: 'loaded' | 'no-web-session' | 'failed';
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (s: SubmissionDetail) => void;
}

export interface GraderProviderOptions {
  baseUrl?: string;
  /**
   * Stored credentials for a *silent* re-login after the token expires.
   * Return undefined when the password is not remembered.
   */
  getStoredCredentials?: () => Promise<Credentials | undefined>;
  /** Where the API token is kept (SecretStorage); omit to keep it in memory only. */
  tokenStore?: TokenStore;
  fetch?: FetchLike;
  log?: Logger;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What an address turned out to be, from one anonymous request. */
export type ServerCheck = { status: 'compatible' | 'incompatible' | 'unreachable' };
export type ServerCheckOptions = Pick<GraderProviderOptions, 'fetch' | 'log'>;

/** Final states: the submission will not change any more (safe to cache forever). */
export function isFinalStatus(status: string): boolean {
  return GRADED.has(status);
}
const GRADED = new Set(['done', 'compilation_error', 'grader_error']);

export type StatementPdfResult = { status: 200; bytes: Uint8Array } | { status: 403 | 404; error: string | null };
export type AttachmentResult = ({ status: 200 } & Attachment) | { status: 403 | 404; error: string | null };

/** Everything the controller, DataService and flows may ask of a grader server. */
export interface GraderProvider {
  readonly baseUrl: string;
  readonly redactor: Redactor;
  readonly capabilities: GraderCapabilities;
  user: GraderUser | null;
  readonly isLoggedIn: boolean;
  /** Whether the last list page was an exam/contest page (null if none fetched). */
  readonly contestPage: boolean | null;
  url(path: string): string;
  /** One verdict per test from a submission's comment; `[]` when it is plain text. */
  parseVerdicts(comment: string | null | undefined): Verdict[];
  restore(): Promise<boolean>;
  login(creds?: Credentials): Promise<GraderUser>;
  logout(): Promise<void>;
  me(): Promise<GraderUser>;
  languages(): Promise<Language[]>;
  languagesFor(p: Pick<Problem, 'permittedLanguageIds'>): Promise<Language[]>;
  listProblems(opts?: { penalties?: boolean; previous?: Problem[]; previousTopics?: TopicTag[] | null }): Promise<ProblemList>;
  listTestcases(problemId: number): Promise<TestcaseInfo[] | null>;
  getTestcaseFile(testcaseId: number, which: 'input' | 'sol'): Promise<{ text: string; truncated: boolean; byteSize: number | null }>;
  getStatementPdf(id: number): Promise<StatementPdfResult>;
  getAttachment(id: number): Promise<AttachmentResult>;
  getDescription(id: number): Promise<{ markdown: boolean; description: string } | null>;
  listSubmissions(problemId: number): Promise<SubmissionBrief[]>;
  submit(problemId: number, languageId: number, source: string, filename: string): Promise<{ id: number; number: number | null }>;
  getSubmission(id: number, signal?: AbortSignal): Promise<SubmissionDetail>;
  pollSubmission(id: number, opts?: PollOptions): Promise<SubmissionDetail>;
}
