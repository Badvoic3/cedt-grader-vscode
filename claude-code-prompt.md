# Build "CEDT Grader Submit": a VS Code extension for cedt-grader.nattee.net

You are working in an empty git repo. Build a VS Code extension (TypeScript) that lets students submit the active source file to the CEDT Grader and see the verdict inside VS Code. It must work alongside the existing **Competitive Programming Helper (CPH)** extension (`DivyanshuAgrawal.competitive-programming-helper`), not replace it.

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
- Unknown verdict tile classes (timeout, crash, etc.) must not break parsing: show the raw `title` text.

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

### Phase 3: Problem mapping and CPH integration
- First inspect how CPH stores problems: look at its source (https://github.com/agrawal-d/cph) and any `.cph/*.prob` files in my workspace. Do not assume the format; confirm it.
- Mapping order for the active file: (1) our own mapping stored in workspace state / a `.cedt-grader.json` file, (2) a problem URL or name in the CPH `.prob` file if it matches the grader, (3) a quick-pick of problems from `/main/list` (searchable by name), saved for next time.
- Optional: when the Testcases page exists for a problem, offer a command to import its sample cases into the CPH `.prob` file so CPH can run them locally. Only write to `.prob` files in the documented format and back up the original first.

### Phase 4: Sidebar GUI (primary interface)
Instead of relying on the command palette, build a sidebar GUI like the CPH and Claude extensions.

- Add an Activity Bar view container "CEDT Grader" with its own icon (SVG, monochrome so it follows the theme) containing one webview view, using a `WebviewViewProvider`.
- The webview is the main interface. Sections:
  1. **Account:** login form (username + password) when logged out; username and a Log out button when logged in. The password goes straight to `context.secrets` and is never kept in webview state or logged.
     - "Remember password on this computer" checkbox (default on). On: password in `context.secrets` (macOS Keychain). Off: only the token, in memory.
     - When the token expires (401), log in again silently with the stored password; show the login form only if that fails. Never retry a failed login automatically.
     - Normal password input (`autocomplete="current-password"`) so password managers can fill it, and pasting works. Hint under the field: "Tip: copy it from the Passwords app once; it will be remembered securely in your Keychain."
     - "Log out" removes both the token and the stored password.
  2. **Current problem:** shows the active editor's file, the mapped problem (with a searchable picker from `/main/list`), a language dropdown filled from that problem's allowed languages, and a big Submit button.
  3. **Result:** live status while grading, then score, a colored verdict strip (one tile per test, tooltip with the label), compiler message if compilation failed, link to the submission, and Resubmit.
  4. **History:** the last few submissions for this problem.
  5. **Problems:** a searchable list of problems with best score; clicking one maps it to the current file or opens its statement.
- Communication only through `postMessage` with typed messages in a shared types file. All network calls stay in the extension host, never in the webview.
- Follow the active editor: when the user switches files, the panel updates.
- Use VS Code theme CSS variables and `@vscode/codicons`; it must look right in light, dark and high-contrast themes and at narrow sidebar widths.
- Security: strict Content-Security-Policy with a nonce, `localResourceRoots` limited to the extension's `media` folder, escape all HTML from the grader before showing it.
- Keep the commands too (so keyboard shortcuts still work), but the GUI is the primary way to use the extension. Keep the status bar item as a shortcut that reveals the panel.
- Plain TypeScript + HTML/CSS for the webview (no framework), bundled with esbuild into `media/`.
- Notifications stay human readable (wrong password, session expired, language not allowed for this problem, network error).
- Update `CLAUDE.md` and the README with the new UI.
- Plan first and show a sketch of the panel layout, then build it. **CHECKPOINT:** explain how to test it with F5.

### Phase 5: Quality and packaging
- Tests: parsers (fixtures), `GraderClient` with mocked fetch (login, expired session re-login, submit, poll timeout), extension-to-language mapping.
- `README.md` for students: install from `.vsix`, log in, map a file, submit; a note on using it together with CPH; a privacy note (password stays in the OS keychain via VS Code SecretStorage).
- `npx @vscode/vsce package` produces a `.vsix`. Add `CHANGELOG.md` and an MIT `LICENSE`.
- Write a `CLAUDE.md` for this repo summarising the protocol table above, the hard rules, and the build/test commands, so future sessions have context.
- **CHECKPOINT:** list what I should test manually in the F5 Extension Development Host (log in, submit a correct solution, submit a compile error, submit a wrong answer, log out) and wait for my results.

## 4. Done means
- `npm test` passes, `npm run build` passes, `.vsix` builds.
- I can submit the active `.cpp` file in two clicks and see the score and verdict strip without opening a browser.
- CPH still works exactly as before in the same workspace.
- The code never sends contest check-ins or fakes presence.
