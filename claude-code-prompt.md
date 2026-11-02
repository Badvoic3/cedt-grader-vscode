# Build "CEDT Grader Submit": a VS Code extension for cedt-grader.nattee.net

You are working in an empty git repo. Build a VS Code extension (TypeScript) that lets students submit the active source file to the CEDT Grader and see the verdict inside VS Code. It is a standalone grader extension. **Competitive Programming Helper (CPH)** (`DivyanshuAgrawal.competitive-programming-helper`) is optional: everything works without it, and when it is installed the extension stays compatible with it (see "CPH is optional" below).

Work in the phases below. Use plan mode first, show me the plan, then build phase by phase. Commit after each phase with a clear message. Stop and ask me at every **CHECKPOINT**.

---

## 1. Facts about the grader (already inspected; treat as the spec)

The site runs **cafe-grader-web** (rev 4.7.3cu), an open-source Ruby on Rails app: https://github.com/nattee/cafe-grader-web. The table below is the HTML-form protocol (Rails CSRF tokens and a session cookie). The server also has a JSON API (section 1b), which is now the primary path. When something below is unclear, read the Rails routes, controllers and views in that repo instead of guessing.

| Step | Request | Details |
|---|---|---|
| CSRF token | `GET /` | `<meta name="csrf-token" content="...">` or hidden input `authenticity_token`. Keep all cookies (a `uuid` cookie is set before login). |
| Login | `POST /login/login` | `application/x-www-form-urlencoded`: `authenticity_token`, `login`, `password`, `commit=Login`. Success = session cookie + redirect to the problem list. Plain username/password, no SSO. |
| Problem list | `GET /main/list` | HTML table, one row per problem. Links include `/problems/{id}/download/statement`, `/submissions/prob/{id}`, `/submissions/direct_edit_problem/{id}`, `/testcases/show_problem/{id}`. Rows show problem name, best score, latest submission id. |
| Submit page | `GET /submissions/direct_edit_problem/{problemId}` (and `/submissions/{id}/edit`) | Contains the submit form. Read the allowed languages from `<select name="language_id">` here; they differ per problem (e.g. `2 = C++`). |
| Submit | `POST /main/submit` | `multipart/form-data`: `authenticity_token`, `submission[problem_id]`, `language_id`, `editor_text` (the source code as text), optionally `file` (file upload), `commit`. Use a fresh CSRF token from the submit page. |
| Poll result | `GET /submissions/get_latest_submission_status/{userId}/{problemId}` | Returns a `<turbo-stream action="update" target="latest_status">` HTML fragment containing: submission id (`/submissions/{id}`), number of tries, time, score (e.g. `70.0`), and a `.verdict-strip` with `data-comment="PPPPPPPPP----PP-PPP-"` plus one `.verdict-tile` per test with classes like `verdict-correct` / `verdict-wrong` and a title like `Test 10 of 20: Wrong Answer`. |
| Compiler msg | `POST /submissions/{id}/compiler_msg` | Turbo request (needs CSRF header `X-CSRF-Token` and `Accept: text/vnd.turbo-stream.html`). |
| Per-test detail | `POST /submissions/{id}/evaluations` | Same as above. |

Notes:
- `userId` must be discovered after login (it appears in `get_latest_submission_status/{userId}/...` URLs in page HTML, or find it from the Rails views). Do not hard-code it.
- Supported languages in the web editor: C, C++, Python, Java, Rust, Go, PHP, Haskell, Ruby, Pascal, PostgreSQL, Digital. Always use the per-problem `language_id` list; map file extensions to language names (`.cpp/.cc/.cxx` → C++, `.c` → C, `.py` → Python, `.java` → Java, `.rs` → Rust, `.go` → Go, `.php` → PHP, `.hs` → Haskell, `.rb` → Ruby, `.pas` → Pascal, `.sql` → PostgreSQL), and ask with a quick-pick if ambiguous.
- The Testcases page only works for some problems (others redirect to `/main/list`). Treat it as optional.
- Verdict strips follow the website exactly (see Phase 4 "Verdict strip"); anything that isn't a valid strip is shown as plain text.

## 1b. JSON API (primary path)

The live server has cafe-grader's `/api/v1` (JWT). Confirmed from `config/routes.rb` and `app/controllers/api/v1/*`; `GraderClient` uses it first and keeps the HTML client only for what the API lacks.

| Purpose | Request | Notes |
|---|---|---|
| Login | `POST /api/v1/auth/login` `{login, password}` | → `{token, expires_at, user:{id, login, full_name}}`, 12 h TTL. 401 wrong password, 429 throttled (pooled with the web login), 403 disabled/IP. Never retried automatically. |
| Auth | `Authorization: Bearer <token>` | Token only in SecretStorage (if "remember" is on) or memory; never logged. On 401, log in again once with the stored password. |
| Problems | `GET /api/v1/problems` | `id, name, full_name, best_score, last_score, last_result, submission_count, last_submission_id, last_submission_time, permitted_languages (null = all), has_testcase, has_attachment`. |
| Problem | `GET /api/v1/problems/{id}` | Also `full_score`, `submission_ids` (newest first). |
| Languages | `GET /api/v1/languages` | `id, name (internal), pretty_name, ext`. |
| Submit | `POST /api/v1/problems/{id}/submissions` `{language_id, source, filename}` | → 201 `{id, number, status}`. 422 with `permitted_languages` = language not allowed; 403 = not allowed to submit. |
| Poll | `GET /api/v1/submissions/{id}` | `status` (`submitted`, `evaluating`, `compilation_success` → pending; `done`, `compilation_error`, `grader_error` → graded), `points`, `grader_comment`, `compiler_message`, `evaluations`. |
| History | `GET /api/v1/problems/{id}/submissions` | Regular submissions, newest first. |
| Test cases | `GET /api/v1/problems/{id}/testcases`, `GET /api/v1/testcases/{id}/input`, `/sol` | Only when the user may view them (Phase 3 import). |

HTML is still used for: `/main/list` (hint/AI-assist penalties, raw-sum mode, and the `isContestPage` exam hint), through a cookie web session opened at login.

## 1c. The score the server counts

From `MainController#prepare_list_information`, `app/views/main/_problem.html.haml`, `Submission.max_score_report`:
- Counted score = max points over all *regular* submissions (not the latest; test drives and repaired copies are excluded).
- With hints or AI assists: counted = max(0, min(best, 100 − hint_cost − ai_assist_cost)) (cost capped at 100).
- Problems whose live dataset is in "raw sum" mode show the raw best score without this cap.
- In contest mode only submissions inside the contest window count (the API's `best_score` does not apply this filter).
- The API has no hint/AI cost data, so it is read from `/main/list` (green bar = adjusted score, red bar = penalty, "Full score reduced by N", "Hint: n, AI Assist: n") and labelled "from problem list".
- Display: "Counted score" (big), best, latest, attempts, and the penalty ("-10 AI assist"). If the latest is lower, say so ("Latest: 40 — your best 70 still counts"). After each submission, say whether it improved the counted score. The problem list shows the counted score per problem. The README notes that the instructor's final grading may differ.

## 1d. Submission history and request usage

History uses only the API (no `/submissions` HTML), confirmed in `app/controllers/api/v1/submissions_controller.rb`:
- `GET /api/v1/problems/{id}/submissions`: all my regular submissions for the problem, newest first (`id, number, language, submitted_at, points, status, grader_comment`), website submissions included.
- `GET /api/v1/submissions/{id}`: full detail (`source` for own submissions, `source_filename, compiler_message, max_runtime` (ms), `peak_memory` (KB), `points, grader_comment, evaluations[{testcase_id, result, score, time (ms), memory (KB)}]`).

UI (sidebar "History" for the active file's problem):
- Every submission: number, time (relative, exact on hover), language, score, verdict strip from `grader_comment`; the one holding the counted (best) score is marked.
- Clicking one expands details loaded on demand: compiler message, per-test results, runtime, memory, link to `/submissions/{id}`.
- Actions: "Open this version" (new untitled editor, never overwrites the file) and "Compare with current file" (VS Code diff). A Refresh button for the history.

Request discipline (tested):
- One shared cache layer in the extension host (`src/data/`).
  - Problem list: cached for the session, refreshed on demand or after a submit.
  - History per problem: fresh for 5 minutes.
  - Submission details: cached forever once final (graded / compile error), never while in progress.
- Switching files: debounce 400 ms, then show cached data; fetch only if the problem's history is missing or stale. Switching back and forth while the cache is fresh makes no requests.
- Deduplicate in-flight requests (same key → same promise).
- After a submit: poll only that submission until final, then refresh that problem's history and the problem list once (API only).
- No background polling, no prefetching of other problems. Nothing is fetched while the panel is hidden; pending loads run when it becomes visible.
- 401: one silent re-login. 429 / 5xx: GETs retried with back-off (2 s, 4 s, or Retry-After). Offline / still failing: show cached data with a "may be out of date" note.
- `cedtGrader.debugRequests` (off by default) logs method, path, status and cache hit/miss/dedup to the "CEDT Grader: Requests" output channel, never tokens.

## 1e. Statement viewer, messages and connection errors

Statement viewer (read-only):
- `GET /api/v1/problems/{id}/files/pdf` (confirmed in `problems_controller.rb#file`: 403 = PDF hidden for this problem, 404 = none). Fallback: `GET /api/v1/problems/{id}/description` (`{markdown, description}`; Markdown rendered with raw HTML disabled, other descriptions shown as escaped text).
- Shown in a WebviewPanel editor tab "Statement: <problem>" with bundled `pdfjs-dist` (no CDN; strict CSP; worker loaded from the extension's media folder via a blob URL; `isEvalSupported: false`). Zoom in/out, fit width, page navigation, text selection, search (Cmd/Ctrl+F, Enter / Shift+Enter).
- Opened from the book icon next to the problem picker (and in the problem list); "Open in Browser" and Refresh are in the viewer toolbar.
- Cached per problem in the extension's globalStorage (keyed by server host + problem id), refetched only on the viewer's Refresh. Reopening sends no request. Never written into the workspace.
- `cedtGrader.statementBeside` (default true) opens it beside the code.

Messages:
- Each message appears once. When the file's language isn't accepted by the mapped problem, Submit is disabled (tooltip with the reason) and one hint says "This problem doesn't accept C++. Wrong problem?" with a Change button.
- Errors already shown in the panel are not repeated as notifications while the panel is visible.
- The login form has only the "Remember password on this computer" checkbox (no extra tip).

Connection errors:
- A banner at the top of the sidebar with a clear message and Retry (or Log in): no internet / server unreachable, server error (5xx), session expired and re-login failed, too many login attempts / requests (429), timeout.
- Cached data stays visible under the banner, marked "may be out of date". The banner hides automatically when the next request succeeds.
- While offline nothing retries in a loop: polling gives up after 2 consecutive network errors; retries happen on Retry or the next user action.
- Submit failing before reaching the server says nothing was submitted (timeouts / 5xx say it may or may not have been received). Failing after (while polling) says the submission was sent and its result loads when the connection is back (automatically on the next successful request, or Retry).
- The status bar item shows a warning icon while in the error state.
- Tests for each error type → message.

## 1f. CPH is optional; accessibility

CPH is optional (still compatible):
- Everything works with CPH not installed: login, problems, linking, submit, results, history, statement viewer.
- Detect CPH with `vscode.extensions.getExtension('DivyanshuAgrawal.competitive-programming-helper')` (undefined when not installed or disabled); re-check on `vscode.extensions.onDidChange`.
- Reading `.cph/*.prob` for matching happens only if the files exist (works with or without CPH installed, costs nothing otherwise).
- "Load test cases" (renamed from "Load test cases into CPH"): with CPH installed, write into CPH's `.prob` as before ("Saved to CPH"). Without it, offer "Save as files" (writes `<problem>/tests/<n>.in` and `<n>.out` next to the source; asks before creating the folder; existing files are never overwritten) or "Install CPH" (opens its Marketplace page). The "Save as files" choice is remembered per workspace.
- "CPH" is not in the display name, description, command titles or main UI text; it is mentioned only where it is actually used ("Saved to CPH", "Install CPH to run these tests in VS Code", "Matched from CPH data").
- CPH is never declared as a dependency or in an extension pack.
- Tests: all features with CPH absent (getExtension → undefined), test-case import to files, CPH-present path unchanged.

How the problem was chosen: a small icon next to the problem name with a tooltip: "Chosen by you", "Matched by file name", "Matched from CPH data" (only when CPH data was actually used), "Suggested — click to confirm". Only "Suggested" stands out (warning color and a Confirm button); the others are subtle.

Tooltips and accessibility: every icon-only button (sidebar, problem picker, history, results, statement viewer, error banner) has a tooltip (`title`) and the same `aria-label` (e.g. "Copy problem name", "Open statement", "Go to linked file", "Refresh history", "Remove link", "Open in browser", "Compare with current file"). Disabled buttons explain why in the tooltip. A test fails if any icon button lacks them.

## 2. Hard rules

- **Never** hard-code, log, print or commit credentials, cookies or CSRF tokens. Store the password in VS Code `context.secrets`; the username can be a setting.
- For the standalone test script, read credentials from environment variables `GRADER_USER` / `GRADER_PASS` (via a `.env` file). Add `.env` to `.gitignore` before creating it. **Do not ask me to paste my password into the chat**; I will fill `.env` myself.
- Be gentle with the server: poll every 5 seconds (the site's own default), only after a submission, stop when a score appears or after 3 minutes, and back off on errors. No parallel submissions, no bulk scraping.
- Base URL is a setting (`cedtGrader.baseUrl`, default `https://cedt-grader.nattee.net`) so it works with other cafe-grader servers.
- Handle session expiry: if a request redirects to the login page, log in again once and retry.
- Follow the short **Exams / contests** section below.
- Prefer Node 18+ built-in `fetch`; use `tough-cookie` (or a small manual cookie jar) for cookies, `cheerio` for HTML parsing. Keep dependencies minimal and bundle with `esbuild`.

## 2b. Exams / contests (kept deliberately small)

Contests on this grader are only used for exams, and this is an unofficial homework tool, so there is no contest system in the extension.

- `isContestPage(html)`: one cheap check on a page we already fetch (a non-empty contest end time `Date.parse('…')` or a `#countdown` element in the page header). No extra requests just for detection.
- If it returns true, warn before submitting: "This problem looks like part of an exam/contest. Submitting from VS Code may not be allowed. Check with your instructor." with buttons **Open in Browser** and **Submit Anyway**. The choice is not remembered.
- One unit test for `isContestPage` (contest page vs normal page).
- Never call `/contests/user_check_in` or imitate check-ins (not implementing anything contest-related satisfies this).

## 3. Phases

### Phase 1: Protocol proof (standalone script)
- Create `scripts/probe.ts` (run with `npx tsx`) and a `src/grader/` module with a `GraderClient` class: `login()`, `listProblems()`, `getLanguages(problemId)`, `submit(problemId, languageId, source)`, `pollLatest(problemId)`, `getCompilerMessage(submissionId)`.
- Parse everything with cheerio into typed objects (`Problem`, `Language`, `SubmissionStatus { id, score, tries, verdicts: {index, ok, label}[] }`).
- Save sample HTML responses I fetch into `test/fixtures/` (strip CSRF tokens, cookies, names and student IDs before saving).
- Add `isContestPage(html)` (see section 2b); the probe prints its result.
- Unit-test every parser against the fixtures with `vitest`.
- **CHECKPOINT:** tell me the exact command to run the probe against the real site with a problem ID I choose, then wait for my output before Phase 2.

### Phase 2: Extension skeleton
- Scaffold a TypeScript extension (equivalent of `yo code`, but hand-written is fine) with `package.json` contributions, `esbuild` bundling, launch config for F5 debugging.
- Commands: `CEDT Grader: Log In`, `CEDT Grader: Log Out`, `CEDT Grader: Submit Current File`, `CEDT Grader: Choose Problem for This File`, `CEDT Grader: Show Last Result`, `CEDT Grader: Open Problem Statement`.
- Settings: `cedtGrader.baseUrl`, `cedtGrader.username`, `cedtGrader.pollIntervalSeconds` (min 3, default 5), `cedtGrader.confirmBeforeSubmit` (default true).
- The submit command runs the `isContestPage` warning from section 2b before submitting.
- The commands stay (so keyboard shortcuts and the command palette keep working), but the **sidebar GUI from Phase 4 is the primary interface**. Build the skeleton with the sidebar in mind: commands and the webview call the same controller.

### Phase 3: Problem linking and CPH integration

1. **Problem cache:** the problem list (`/api/v1/problems` + `/main/list` penalties) is fetched once per session and on Refresh; cached in memory and in workspace state with a timestamp (shown immediately after a restart, still refetched once per session). Never fetched on keystrokes or editor switches. `has_testcase` comes from it.
2. **Name normalization:** file names (without extension) and problem names: zero-width characters (U+200B/C/D, U+FEFF) removed, trimmed, lowercased; spaces, `-`, `_` and `.` are the same separator, repeats collapse.
3. **Matching order** for the active file:
   1. a mapping I saved for this file (always wins; when its problem no longer exists it is shown as unavailable, see item 13);
   2. the CPH `.prob` of this source (format confirmed from agrawal-d/cph `src/types.ts` + `src/parser.ts`): a grader URL or problem name in it;
   3. exact normalized match between file name and problem name;
   4. otherwise a suggestion, by match score (name similarity + a bonus when a parent folder is named like a problem tag; constants `MATCH` in the config module): top score at or above the threshold and clearly ahead → "Suggested" (never saved automatically; the muted "Suggested from the file name · Use this" line stays visible); top candidates close in score → "Several problems could match" with a choice; below the threshold → not used ("Not linked to a problem"), candidates only in the picker.
   - If more than one problem matches equally, don't choose; ask.
   - Mappings live in workspace state keyed by the file's path relative to its workspace folder, plus `.cedt-grader.json` in the workspace root.
4. **Manual control:** searchable picker (name or id); a manual choice is saved and overrides auto-detection. Clear the mapping from the panel ("Remove link") or the command "Clear Problem for This File". An icon next to the problem name shows how it was chosen (section 1f), with a Change button; a suggestion has a Confirm button.
5. **Suggestions work like links, with safety for writes:** every read-only feature (counted score, best/latest/attempts, history, results, statement, problem details, files for this problem, duplicate notice, ✓ in the list) works for a suggestion, with the same caching and request rules (only the top suggestion is loaded). Write actions ask one light, non-modal question while the match is a suggestion: Submit ("Submit to <name> (<full name>)?" [Submit] [Choose another problem]) and Load test cases (same style); answering yes saves the link, so it is not asked again. New file / linking other files unchanged; the dropdown, "Use this" and Auto-detect confirm as before. The exam warning (section 2b) is not affected by mapping.
6. **Load test cases** (replaces the earlier optional import; CPH optional, see section 1f):
   - API (confirmed in `problems_controller.rb#testcases`, `testcases_controller.rb`): `GET /api/v1/problems/{id}/testcases` → `[{id, num, group, group_name, weight, access, input_bytes, sol_bytes}]` (403 = not allowed); `GET /api/v1/testcases/{id}/input` and `/sol` → text/plain. For students (`access: "preview"`) large files are cut off and the response has `X-Testcase-Truncated: true` and `X-Testcase-Byte-Size`. A truncated case is never imported; it is skipped and reported ("Loaded 5 of 8 test cases; 3 were too large to download").
   - The button ("Load test cases", Current problem section) is shown when `has_testcase` is true and the file is linked or suggested (a suggestion asks once first; yes confirms the link). Problems without `has_testcase` are never probed.
   - Downloads one case at a time (input, then sol) with a progress notification; cached per problem in globalStorage, so a second import downloads nothing unless "Download Again" is chosen.
   - CPH file: `.cph/.<basename>_<md5(full source path)>.prob` next to the source (or `cph.general.saveLocation`), JSON `{name, url, interactive, memoryLimit, timeLimit, group, tests:[{input, output, id}], srcPath, local}`, written with plain `JSON.stringify` like CPH. Existing file: backed up to `<file>.prob.bak`, my own tests kept first, grader cases appended; cases whose input+output already exist are skipped. Imported cases are marked through their `id` (7e15 + grader testcase id; CPH keeps ids when it re-saves) so a re-import updates them in place. No file: one is created with the problem name and the grader URL (`/submissions/direct_edit_problem/{id}`).
   - Line endings normalized to `\n`; trailing newlines kept as in the file.
   - CPH only re-reads a `.prob` when the active editor changes and has no reload command; the success message says so and offers "Reload in CPH" (briefly shows a read-only placeholder tab and returns to the file). CPH itself is never modified.
   - Success message: loaded, skipped (truncated), already present. Errors use the connection banner.
7. **Copy problem name:** copy icon next to the problem name (panel, picker, problem list) copies the clean name (zero-width characters removed), so a file named with it is auto-matched exactly.
8. **New file for this problem:** creates `<clean name>.<ext>` in the active file's folder (or workspace root), opens it and saves the mapping. If it exists: Open Existing / Overwrite / Cancel; never overwritten silently.
   - Extension order: the active file's language if permitted; else the last language used for new files if permitted; else `cedtGrader.defaultLanguage` (default C++) if permitted; else a quick pick of the permitted languages.
   - Archive / binary / non-source languages (Archive, Digital, Viva Exam, Text, or anything with a binary extension) are never picked automatically; they are only offered in the quick pick. (cafe-grader marks Archive `binary: true`; the API doesn't expose the flag, so names/extensions are listed.)
   - Tests for each step of that order.
9. **Jump to file:** "go to file" for problems with a mapped file (reverse lookup of saved mappings only, no workspace scan; one `fs.stat` per file when used; missing → offer to remove the stale mapping; several → quick pick).
   - Without a mapping: "Find file by name" runs one `workspace.findFiles`, only when clicked.
   - It includes only source files whose extension belongs to a language permitted for that problem (from the languages list, plus that language's other extensions such as .cc/.cxx), with a case-insensitive match on the clean problem name.
   - It excludes the `files.exclude` and `search.exclude` settings, simple patterns from the workspace `.gitignore`, `node_modules`, `.git`, `bin/`, `build/`, `out/`, `dist/`, `target/`, `*.dSYM/`, `.cph/`, and binary extensions (.bin, .o, .out, .exe, .zip, …).
   - Exactly one result: open it and offer to link it. Several: a quick pick of relative paths, most likely first (same folder as the active file, then most recently modified).
   - Tests with a fixture tree containing .cpp, .bin and a .dSYM folder.
10. **Moved / renamed files (failsafe):**
    - Inside VS Code: `workspace.onDidRenameFiles` updates saved mappings and `.cedt-grader.json` for renamed files and folders (a folder rename moves every file inside it); how the problem was chosen is kept; per-file results and chosen language follow the file.
    - Outside VS Code (Finder, terminal, git): when a file without a mapping is opened, saved mappings whose file is missing (checked with `fs.stat`, only for same-name candidates) and whose file name matches are offered: "This looks like <old path>, linked to <problem>. Keep the link?" (Keep / Not this one; several → pick or skip). Never applied silently; no workspace scanning. "Not this one" is remembered.
    - Deleted files (`workspace.onDidDeleteFiles`): the mapping is marked stale (not removed), so a moved file can reconnect; stale mappings are removed after 30 days (checked at most once a day on startup) or with "Clear Cached Data" (Phase 5).
    - CPH names its `.prob` after the full source path and does not handle renames (no rename/delete listeners in its source). After a rename inside VS Code the extension offers once: "Move CPH test cases to the new file too?" → copies the `.prob` to the name CPH expects for the new path (srcPath, and url when it held the old path, updated), keeps the old one as `.bak`, never overwrites an existing `.prob`.
11. **Auto-detect button** next to the problem selector: re-runs matching for the active file (file name, CPH data, suggestions) and shows the result. If a manual link exists, ask before replacing it.
12. **Duplicate warnings:**
    - Two or more files linked to the same problem: a gentle notice in the panel ("2 files are linked to this problem") with a list to jump to each and "Keep only this file" (unlinks the others; files untouched). Not an error (drafts are normal). Before submitting, if another linked file for the same problem was modified more recently, ask "Submit this file? <other file> was changed more recently."
    - The same file linked twice (old absolute-path key + new key) or duplicate / same-path entries in `.cedt-grader.json`: cleaned up automatically (startup and when the file is saved) with a short message.
13. **Problem no longer available** (missing from `GET /api/v1/problems`, or 404/403 from a problem endpoint, including submit):
    - The link is kept and marked "This problem is no longer available on the grader" with Change problem / Remove link.
    - Submit disabled with that reason. Cached history and the cached statement stay viewable, labeled as possibly out of date.
    - Never a crash or a blank panel. Tests for 404, 403 and missing-from-list.
14. **Problem row click** opens the problem's file(s) — saved links, remembered auto-matches, file-name matches and suggestions (opening never links; a suggested file shows "Suggested · Use this" in Current problem): one → open; several → quick pick (stable path order, labeled linked / matched by file name / suggested); missing → offer to remove the stale link; none → "Link to <current file>" (only with a file open) / "Create a new file" / "Find a file by name" / "Open statement". Never links by itself; linking stays explicit (dropdown, right-click "Link to <file>").
15. **Unlink that sticks:** "Unlink this file" removes the link and stores an explicit "not linked" state (follows renames), so auto-detection doesn't re-link it. The panel shows "Not linked to a problem" with Choose problem / Auto-detect; both clear the state.
16. **One path normalization** for every link path (mappings, `.cedt-grader.json`, renames, reverse lookup, reconnect): NFC, "./" and ".." resolved, "/" separators, workspace-relative, case-insensitive comparison on macOS/Windows. Duplicate cleanup really rewrites `.cedt-grader.json` and reports only real changes, once.
17. **Files for this problem** (one function for the duplicate notice, row click / go to file and the before-submit check): saved links + auto-matches remembered when an open file matched by name or CPH data (never over a manual link or "not linked"; dropped on delete or a rename to a non-matching name) + one cached `findFiles` per problem for the clean name (allowed extensions, "Find file by name" exclusions; only while the panel shows the problem; refreshed on file create/delete/rename, debounced; logged as a file search). Wording: "Another file with the same name also matches this problem." / "N files are linked to this problem"; each file with how it's linked, Open, Unlink (chosen) or "Don't match this file" (name match), and "Unlink the other files". Stable order: workspace-relative path, natural, case-insensitive; the active file is marked in place.
- Tests: normalization, the full matching order, ambiguous matches, stale mappings, `.prob` parsing (sanitized fixture), import never deleting existing cases, truncated cases skipped, backup created, 403 handled, clean-name copy, new file without overwrite, reverse lookup, single file / folder rename, reconnect prompt (one / several candidates), deleted → stale → expired after 30 days, CPH `.prob` moved with backup.
- **CHECKPOINT:** F5 test list (file named like a problem, a file with a CPH .prob, a file with no match, changing the mapping, loading test cases, renames/moves).

### Phase 4: Sidebar GUI (primary interface)
Instead of relying on the command palette, build a sidebar GUI like the CPH and Claude extensions.

- Add an Activity Bar view container "CEDT Grader" with its own icon (SVG, monochrome so it follows the theme) containing one webview view, using a `WebviewViewProvider`.
- The webview is the main interface. Sections:
  1. **Account:** login form (username + password) when logged out; username and a Log out button when logged in. The password goes straight to `context.secrets` and is never kept in webview state or logged.
     - "Remember password on this computer" checkbox (default on). On: password in `context.secrets` (macOS Keychain). Off: only the token, in memory.
     - When the token expires (401), log in again silently with the stored password; show the login form only if that fails. Never retry a failed login automatically.
     - Normal password input (`autocomplete="current-password"`) so password managers can fill it, and pasting works.
     - "Log out" removes both the token and the stored password.
  2. **Current problem:** shows the active editor's file, the mapped problem (with a searchable picker from `/main/list`), a language dropdown filled from that problem's allowed languages, and a big Submit button.
  3. **Result:** live status while grading, then score, a colored verdict strip (one tile per test, tooltip with the label), compiler message if compilation failed, link to the submission, and Resubmit.
  4. **History:** every submission for this problem, expandable (see section 1d).
  5. **Problems:** a searchable list of problems with best score; clicking one maps it to the current file or opens its statement.
- Communication only through `postMessage` with typed messages in a shared types file. All network calls stay in the extension host, never in the webview.
- Follow the active editor: when the user switches files, the panel updates.
- Use VS Code theme CSS variables and `@vscode/codicons`; it must look right in light, dark and high-contrast themes and at narrow sidebar widths.
- Security: strict Content-Security-Policy with a nonce, `localResourceRoots` limited to the extension's `media` folder, escape all HTML from the grader before showing it.
- Keep the commands too (so keyboard shortcuts still work), but the GUI is the primary way to use the extension. Keep the status bar item as a shortcut that reveals the panel.
- Plain TypeScript + HTML/CSS for the webview (no framework), bundled with esbuild into `media/`.
- Notifications stay human readable (wrong password, session expired, language not allowed for this problem, network error).
- Problem list filters (like the website, `app/views/main/list.html.haml`, `main/_problem.html.haml`):
  - Status filter (segmented, persisted per workspace): solved = has a submission and best ≥ 100; inprogress = has a submission and best < 100; untried = no submission. All / Unsolved (untried or inprogress) / In progress / Solved.
  - Topic filter: pill buttons. The website shows only `@primary_tags = Tag.where(kind: 'topic')`; the API's `tags` has no kind, so the topic pills (with descriptions) are read from the `/main/list` page we already fetch (`.topic-badge`); when that page is unavailable, all tags in use are shown. Click again to clear. Persisted.
  - Filters combine with the text search; "127 of 292 problems". No "Random" button.
- Verdict strip, exactly as the website (`app/helpers/grader_comment_helper.rb`, `app/models/evaluation.rb`, `app/javascript/verdict_strip.js`):
  - Codes `? P - s T M x E !` (Judging, Correct, Wrong Answer, Partially Correct, Time Limit Exceed, Memory Limit Exceed, Program Crashed, UNKNOWN ERROR, GRADER ERROR); one tile per test, in order; tile tooltip "Test 5 of 12: Time Limit Exceed".
  - `[...]` groups drawn as a box; box tooltip "Group 2 of 3: 2/3 passed. Tests in a box are scored together — the box earns the lowest score inside it." (passed = P tiles).
  - Only strings matching the website pattern `^(?:[codes]+|\[[codes]+\])+$` become tiles; anything else (nested/unbalanced brackets, unknown letters, free text such as "No testcase") is shown as plain monospace `[text]`.
  - A "?" legend popover ("Reading the results"), like the website's.
  - Tests for every code, groups and the plain-text fallback.
- Problem header:
  - The match source is a small text line with its icon under the problem selector ("Chosen by you", "Matched by file name", "Matched from CPH data"; "Suggested from the file name" in warning color with Confirm).
  - The name isn't repeated: when `full_name` starts with the name followed by ":" ("104_68_1_exam2_P1: Scholarship"), show "104_68_1_exam2_P1 #1643" with "Scholarship" as subtitle (also in the lists).
  - The score pill in problem rows has a tooltip ("Counted score: 70 / 100 (your best submission…) · 3 attempts" or "Not attempted yet") and the same colors as scores elsewhere.
- Tooltips: one custom tooltip component in all webviews instead of native `title` tooltips.
  - It shows on hover after ~300 ms and on keyboard focus, and hides on mouse leave, blur, Escape, scroll or click.
  - It stays inside the sidebar, uses event delegation on the document, and re-anchors after re-renders. `aria-label` is kept.
  - Cause of missing tooltips: every state push re-rendered all sections and replaced the element under the cursor. Sections now re-render only when their own data changed.
  - Tests: the tooltip component and the icon-button check (data-tip == aria-label, no native title).
- Sorting in the problem list: Default (grader order), Name A–Z / Z–A (numeric-aware), Latest submission (newest first), Best score (low to high / high to low), Recently opened. Remembered per workspace; works with search, status and topic filters.
- "Open on the grader website" buttons: for the current problem (its page on the grader) and on each submission in History (`/submissions/{id}`).
- Verdict strips with many tests: the History row strip used to be a single non-wrapping line cut at 40 tiles and clipped by the row (with more than ~10 tests most results vanished). Now every tile is shown, strips wrap at any sidebar width, a group is never split or shrunk (it moves to the next line as one box and only wraps inside when wider than the strip), and 100+ tests work. Tests with 12, 40 and 120 tests and groups.
- Account section: full name from `GET /api/v1/me` (`full_name`, confirmed in `users_controller.rb#me`; the login response carries the same) with the login ID smaller below; Thai names display correctly.
- CPH tip (when CPH is not installed and the problem has test cases): a small dismissible tip "Want to run test cases inside VS Code? Install the Competitive Programming Helper (CPH) extension." with Install / Not now / Don't show again. Never more than once per session. (The Load test cases flow offers it too.)
- Light cleanup of the panel, only where it clearly helps: consistent spacing, alignment and button sizes; one icon-button style; a "…" menu only for rows with more than 4 icons. Don't remove features, move main buttons, or add clicks to common actions (submit, change problem, view result). **Propose the layout changes first and wait for approval.**
- Statement viewer fixes:
  - Pinch zoom: trackpad pinch arrives as `wheel` events with `ctrlKey = true`; zoom the pdf.js view smoothly around the cursor (`preventDefault` so VS Code's own zoom doesn't react). Also Cmd/Ctrl + / - / 0 (reset = fit width), and the toolbar buttons.
  - No PDF refetch when the panel is hidden and shown (retainContextWhenHidden), the tab is closed and reopened (disk cache), or VS Code restarts (panel serializer + disk cache). Verified with the debug request log.
  - Viewer state (page, zoom, scroll) is kept: webview `getState/setState` (restart) and in globalState via the extension (tab closed and reopened).
- Item 9 cleanup (approved) kept: one button style, notice style, spacing, compact result header, legend position. The "…" menus were undone: all icons visible again (header always; problem rows on hover / keyboard focus, Explorer style), and right-click on a row or the header opens the same actions as a context menu (in addition, never instead). Long menu labels are cut in the middle with the full name on hover. **No further layout changes until the user chooses.**
- Problem list: virtualized (no row limit; "292 problems" / "127 of 292 problems"), rows keyed by problem id and updated in place (an editor switch only touches the rows whose ✓ changed), scroll position / search / filters / sort / collapsed sections kept across re-renders, refresh and hide/show; no auto-scroll after a row click, minimal "nearest" reveal when the user opens a file. Tests: click a row near the bottom → scroll unchanged and ✓ shown.
- Calmer dialogs: inline panel questions with plain buttons; modals only for irreversible / data-loss actions (overwrite, clear cached data, exam submit).
- History tile tooltips (strip tiles, group boxes, per-test tiles) use the custom tooltip.
- Scalability: languages and extensions from `GET /api/v1/languages` (table only as fallback); "out of" from `full_score`, with the server's 100 cap as one named constant; timings, limits and URLs in `src/shared/constants.ts`; user-facing text in `src/shared/strings.ts`; no course-specific names in code; "Where to change things" in `CLAUDE.md`.
- Update `CLAUDE.md` and the README with the new UI.
- Plan first and show a sketch of the panel layout, then build it. **CHECKPOINT:** explain how to test it with F5.

### Phase 5: Quality and packaging
- Tests: parsers (fixtures), `GraderClient` with mocked fetch (login, expired session re-login, submit, poll timeout), extension-to-language mapping.
- `README.md` for students: install from `.vsix`, log in, map a file, submit; a note on using it together with CPH; a privacy note (password stays in the OS keychain via VS Code SecretStorage).
- `npx @vscode/vsce package` produces a `.vsix`. Add `CHANGELOG.md` and an MIT `LICENSE`.
- Write a `CLAUDE.md` for this repo summarising the protocol table above, the hard rules, and the build/test commands, so future sessions have context.
- Clear install guide:
  - README "Install" for students who have never installed an extension from a file: get the .vsix; Extensions → "…" → "Install from VSIX…", choose the file, reload if asked; or `code --install-extension cedt-grader-x.y.z.vsix`. Then: open the CEDT Grader icon in the left bar, log in, open a solution file, check the problem, submit. Plus "Optional: install CPH", "Updating to a new version", "Uninstalling".
  - A VS Code Getting Started walkthrough (`contributes.walkthroughs`) with the same steps, opened once after first install.
  - Troubleshooting: can't log in, wrong problem detected, language not allowed, no internet, where my password is stored.
- Cache management for everything the extension stores in globalStorage / workspace state (statement PDFs, test cases, submission details, history, problem list):
  - Size limit (setting `cedtGrader.cacheMaxMB`, default 100): when exceeded, delete the least recently used files first.
  - Auto-cleanup on startup (at most once a day): remove cached items not used for 30 days and leftover temp files / backups older than 30 days.
  - Command and a button in the sidebar's settings/overflow menu: "Clear Cached Data", showing the current size, with checkboxes: cached files (PDFs, test cases, submission details) [on], problem list and history [on], file-to-problem mappings incl. stale ones [off], saved login [off]. Confirm before deleting.
  - Never delete anything in the workspace except the extension's own `.bak` files, and only when selected.
  - Tests: LRU eviction, daily cleanup, selective clear.
- **CHECKPOINT:** list what I should test manually in the F5 Extension Development Host (log in, submit a correct solution, submit a compile error, submit a wrong answer, log out) and wait for my results.

### Phase 6: Language and customization

1. **Thai translation, English by default**
   - Setting `cedtGrader.displayLanguage`: "English" (default), "ไทย (Thai)", "Follow VS Code". Changing it updates the panel without restarting.
   - Translate everything the user sees: sidebar, viewers, error banner, notifications, dialogs, quick picks, tooltips, status bar, walkthrough, command titles and settings descriptions (`vscode.l10n` and `package.nls.json` / `package.nls.th.json`; webviews get their strings from the extension).
   - Grader content (problem names, compiler messages) stays untranslated.
   - Natural, polite Thai a student would use; keep technical words students know in English where that's normal ("Submit", "test case", "compile error"). Mark uncertain strings for review.
   - Test that every key exists in both languages.
2. **Plain language everywhere:** review all user-facing text (English first) and rewrite technical messages into simple, friendly sentences that say what happened and what to do next (e.g. "Couldn't reach the grader. Check your internet, then press Retry." instead of "Network error: fetch failed"). All strings in one place, easy to review and translate.
3. **More customization** (settings with defaults that keep today's behavior):
   - Panel: which sections are shown and their order; compact mode.
   - Problem list: default sort and filters.
   - Submit: confirm before submit, auto-open the result, save the file before submitting.
   - Verdicts: tiles or plain text (the website has the same choice).
   - Statement: beside the code or in the same column.
   - New files: default language and file name pattern (e.g. `{name}.{ext}`).
   - A gear button in the panel header opening the settings filtered to `cedtGrader`.

## 4. Done means
- `npm test` passes, `npm run build` passes, `.vsix` builds.
- I can submit the active `.cpp` file in two clicks and see the score and verdict strip without opening a browser.
- CPH still works exactly as before in the same workspace.
- The code never sends contest check-ins or fakes presence.
