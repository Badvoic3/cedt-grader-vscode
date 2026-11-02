# CLAUDE.md — CEDT Grader Submit (VS Code extension)

An unofficial homework tool: a VS Code extension that submits the active file to a **cafe-grader-web** server (default `https://cedt-grader.nattee.net`) and shows the verdict and the *counted* score in a sidebar. It must coexist with CPH (`DivyanshuAgrawal.competitive-programming-helper`). The full spec is in `claude-code-prompt.md`.

## Commands

```bash
npm test            # vitest: grader layer (fake API + web server), scores, verdicts, mapping/CPH, jsdom webview
npm run build       # tsc --noEmit + esbuild (dist/extension.js, media/dist/webview.js|css, codicons)
npm run watch       # esbuild watch
npm run package     # production build + vsce package
npx tsx scripts/probe.ts [--list] [--problem <ID>] [--fixtures] [--submit file]   # read-only unless --submit; needs .env
```

Press F5 to start an Extension Development Host (`.vscode/launch.json` runs `npm: build` first).

## Layout

- `src/grader/`: protocol layer with no `vscode` import (shared with the probe and tests).
  - `client.ts`: `GraderClient`, the facade the rest of the code uses.
  - `api.ts`: `ApiClient`, the JSON API with JWT (primary path).
  - `web.ts`: `WebSession`, cookie login + `/main/list` only.
  - `http.ts`: cookie jar and manual redirects for the web session.
  - `parsers.ts`: web login form, alerts, `parseListScores`.
  - `score.ts`: counted score.
  - `verdicts.ts`: `parseGraderComment`.
  - `languages.ts`: file extension → language.
  - `contest.ts`: `isContestPage`.
  - `connection.ts`: `classifyConnectionError` (banner kinds/messages), `describeSubmitFailure`.
  - `sanitize.ts`: HTML/JSON fixture scrubbing.
  - `redact.ts`: strips secrets from logs.
- `src/data/`: the one shared cache layer (no `vscode` import; request counts are unit tested).
  - `cache.ts`: `RequestCache` (session / TTL / final-only entries, in-flight de-duplication).
  - `dataService.ts`: `DataService` (problems, languages, history, details; debounce, visibility, after-submit refresh, stale-on-error; reports failures to the controller's banner).
  - `statementStore.ts`: statement PDF / description cache in `globalStorage/statements/<host>/<id>.pdf|json`.
  - `testcaseStore.ts`: grader test cases per problem in `globalStorage/testcases/<host>/<id>.json` (downloaded one at a time; truncated cases listed, never imported).
- `src/controller.ts`: session, mapping and UI state (results per file, expanded history entry). All grader data goes through `DataService`. Commands, sidebar and status bar all go through the controller.
- `src/shared/messages.ts`: typed `ViewState` / `ToWebview` / `FromWebview`.
- `src/ui/sidebarProvider.ts`: `WebviewViewProvider`; CSP with nonce, `localResourceRoots: [media]`.
- `src/ui/statusBar.ts`: status bar shortcut that reveals the panel (warning icon while the connection banner is up).
- `src/ui/statementPanel.ts` + `webview/statement.ts`: "Statement: <problem>" editor tabs (bundled pdf.js 4.10 viewer: zoom, fit width, pages, text selection, search; description fallback rendered with markdown-it `html: false`).
- `webview/main.ts`, `webview/style.css`: plain DOM sidebar, bundled to `media/dist/` (git-ignored).
- `src/mapping/` (Phase 3, linking):
  - `match.ts`: `cleanName`, `normalizeName`, `resolveProblem` (saved → CPH → exact file name → suggestions; ambiguous → ask), `fileNameFor`.
  - `store.ts`: workspaceState keyed by `<folder name>/<relative path>` (+ legacy fsPath keys read) and `.cedt-grader.json`; reverse lookup (problem → files), rename, mark deleted (stale), expire, reconnect.
  - `mappingFile.ts`: `.cedt-grader.json` parsing (`staleSince` kept), `reverseIndex`.
  - `mappingOps.ts`: pure move logic (`planRename`, `reconnectCandidates`, `affectedByDelete`, `expired`) and `moveCphProblem`.
  - `cph.ts` / `cphImport.ts`: CPH `.prob` read / import (format below). `newFile.ts`: create without overwriting.
- `test/fixtures/`: `*.synthetic.*` files are hand-built from the cafe-grader views and controllers. The others are real data captured by the probe and sanitized.

## Protocol (cafe-grader-web @ 404d3c5; verified against the live server)

**JSON API (primary)**, JWT in `Authorization: Bearer <token>`:

| Purpose | Request | Notes |
|---|---|---|
| Login | `POST /api/v1/auth/login` `{login,password}` | → `{token, expires_at, user}`, 12 h TTL. 401 wrong password, 429 throttled, 403 disabled/IP. |
| Problems | `GET /api/v1/problems` | `best_score` = max over regular submissions (no penalty), `last_score`, `submission_count`, `last_submission_id`, `permitted_languages` (null = all), `has_testcase`. |
| Problem | `GET /api/v1/problems/{id}` | + `full_score`, `submission_ids` (newest first). |
| Languages | `GET /api/v1/languages` | `id, name` (internal), `pretty_name`, `ext`. |
| Submit | `POST /api/v1/problems/{id}/submissions` `{language_id, source, filename}` | 201 `{id, number, status}`. 422 + `permitted_languages` = language not allowed. |
| Poll | `GET /api/v1/submissions/{id}` | `status`: `done`/`compilation_error`/`grader_error` are final. Also `points`, `grader_comment` (`PP-T[Px]`), `compiler_message`. |
| History | `GET /api/v1/problems/{id}/submissions` | All regular submissions, newest first, incl. website ones. |
| Detail | `GET /api/v1/submissions/{id}` | `source` (own only), `source_filename`, `max_runtime` ms, `peak_memory` KB, `evaluations[{testcase_id, result, score, time ms, memory KB}]`. |
| Test cases | `GET /api/v1/problems/{id}/testcases`, `/api/v1/testcases/{id}/input`, `/sol` | Phase 3 import. |
| Test cases | `GET /api/v1/problems/{id}/testcases` (403 = not allowed), `GET /api/v1/testcases/{id}/input`, `/sol` | text/plain; student `preview` access truncates large files: `X-Testcase-Truncated: true`, `X-Testcase-Byte-Size`. Never import a truncated case. |
| Statement | `GET /api/v1/problems/{id}/files/pdf` | 403 = PDF hidden, 404 = none → fallback `GET /api/v1/problems/{id}/description` `{markdown, description}`. |

**HTML (only what the API lacks)**, via a cookie session opened at login:
- `GET /` (CSRF) → `POST /login/login` → `GET /main/list`. This page provides:
  - per-problem hint/AI penalty and raw-sum mode (`parseListScores`);
  - the page header for `isContestPage`.
- A POST with a bad CSRF token silently runs logged out (Rails null session).
- The web login form's `accept_agree` checkbox is never ticked automatically.

## CPH `.prob` (confirmed in agrawal-d/cph @ ef8c7a7: `src/types.ts`, `src/parser.ts`, `src/webview/editorChange.ts`)

- Path: `<dir of source>/.cph/.<basename>_<md5(full source path)>.prob`, or `<cph.general.saveLocation>/<same name>`.
- JSON `{name, url, interactive, memoryLimit, timeLimit, group, tests:[{input, output, id}], srcPath, local?, customCheckerPath?}`, written by CPH with plain `JSON.stringify`.
- CPH re-reads a `.prob` only on `onDidChangeActiveTextEditor` (no reload command; commands: runTestCases, submitToCodeForces, compileWithoutRunning) and saves its in-memory problem back, so after writing a `.prob` the user must switch to the file before running tests ("Reload in CPH" does that by briefly showing a placeholder tab).
- CPH has no rename/delete handling; a renamed source orphans its `.prob` (we offer to move it).
- Our imported tests: `id = 7e15 + grader testcase id` (marker that survives CPH re-saves); backup `<file>.prob.bak`; own tests first and never removed; duplicates by input+output skipped; line endings `\n`.
- Never modify CPH itself; only write `.prob` files in this exact format.

## Counted score (src/grader/score.ts)

- `counted = max(0, min(best, 100 − min(100, hint_cost + ai_cost)))`.
- Raw-sum datasets show the raw best, uncapped.
- `best` is the max over regular submissions, not the latest.
- Penalties come from `/main/list` and are labelled "from problem list". Without that page (password not remembered and the web session gone), the panel shows best scores and says so.
- Contest-window filtering is not applied (the API doesn't apply it either).
- The README tells students the instructor's final grading may differ.

## Hard rules

- **Secrets:** never hard-code, log, print or commit credentials, tokens, cookies or CSRF tokens.
  - The password is kept in `context.secrets` only when "Remember password on this computer" is on (key `cedtGrader.password:<baseUrl>:<user>`).
  - The API token is kept in `cedtGrader.token:…` only in that case; otherwise it lives in memory only.
  - The webview sends the password once in the `login` message and clears the field.
  - **Log out** deletes both the token and the password.
- **Login throttling:** the server throttles failed logins (pooled API + web, per IP and per account). Never retry a failed login automatically.
  - On a 401, re-login silently once with the stored password, then show the login form.
  - A wrong stored password is deleted.
- **Probe credentials:** the probe reads `GRADER_USER` / `GRADER_PASS` from `.env` (git-ignored). Never ask the user to paste a password into chat.
- **Request discipline** (spec section 1d, tests in `test/dataService.test.ts`):
  - Everything goes through `DataService`; never call `GraderClient` for data from UI code.
  - Problem list (+ `/main/list` page): cached for the session; on login, Refresh, and once after a submit (API only).
  - Languages: once per session.
  - History: per problem, fresh 5 min. Details: cached forever once final, never while pending.
  - File switches: debounced 400 ms, fetch only missing/stale history; no requests while fresh.
  - In-flight dedup by key. Nothing while the panel is hidden; no background polling or prefetching.
  - Polling: only the just-submitted submission, every `max(3 s, pollIntervalSeconds)`, stop at 3 min, ×2 back-off on network errors.
  - GETs retry 429/5xx with back-off (2 s, 4 s / Retry-After); failures show cached data as "may be out of date".
  - One submission at a time.
  - `cedtGrader.debugRequests` → "CEDT Grader: Requests" channel: method, path, status, cache hit/miss/dedup; numbered HTTP lines; never tokens.
- **Settings scope:** `baseUrl` and `username` are read from user settings only, so a workspace cannot redirect credentials.
- **Webview isolation:** all network calls stay in the extension host; webviews have CSP `default-src 'none'`. Insert grader text with `textContent` / attributes only, never `innerHTML`.
  - Single exception: the statement viewer inserts HTML produced *in the host* by markdown-it with `html: false` (raw HTML escaped) or by escaping plain text.
  - The statement CSP adds `worker-src blob:` (pdf.js worker fetched from `media/dist/pdfjs` and started from a blob URL), `connect-src` for the extension's own resources, and `'unsafe-inline'` styles (pdf.js sets inline styles). `isEvalSupported: false`.
- **Messages appear once:** connection problems go to the banner only (sections show "may be out of date", no inline error, no toast). Other errors are inline; a toast is shown only when the sidebar is hidden. A language mismatch is one hint + a disabled Submit with a tooltip.
- **Offline:** no retry loops. Polling stops after 2 consecutive network errors and resumes on Retry or the next successful request (`pendingPoll`). Submit failures say whether anything was sent (`describeSubmitFailure`).
- **Dependencies:** keep them minimal: `cheerio/slim`, `tough-cookie`, Node fetch, esbuild.

## Exams / contests (section 2b; kept deliberately small)

- `isContestPage(html)` runs on the `/main/list` page fetched at login or refresh: a non-empty `Date.parse('…')` contest end time, or a `#countdown` that isn't "ANALYSIS MODE". There are no extra requests just for detection.
- If it returns true, submit shows a modal ("This problem looks like part of an exam/contest. Submitting from VS Code may not be allowed. Check with your instructor.") with **Open in Browser** / **Submit Anyway**. The choice is never remembered.
- Never call `/contests/user_check_in` or imitate check-ins; nothing contest-related is implemented.

## UI

The sidebar (`cedtGrader` Activity Bar container, view `cedtGrader.panel`) is the primary interface.
- **Banner** (top): connection problems with Retry / Log in.
- **Account:** login form with the remember checkbox.
- **Current problem:**
  - file name;
  - searchable picker (name or id), book icon → statement viewer;
  - wrong-language hint ("This problem doesn't accept C++. Wrong problem?" + Change);
  - match source badge (saved / from CPH / from file name / suggested) + Change, copy-name icon, notes for ambiguous / stale mappings;
  - "Load test cases into CPH" (only when `has_testcase` and the file is mapped, not just suggested);
  - counted-score card (counted, best, latest, attempts, penalty, "your best still counts");
  - language dropdown;
  - Submit button.
- **Result** (active file only): live status, points, verdict tiles, compiler message, improvement line, Resubmit.
- **History** (API): every submission with relative/exact time, language, score, mini verdict strip, counted marker; expand for details (per test, runtime, memory, compiler message) and "Open this version" / "Compare with current file" (`cedt-grader-submission:` read-only documents, served from the cache).
- **Problems:** counted score per problem; row actions (on hover/focus): copy name, go to file (mapped) or find file by name, new file for this problem, statement.

Statement viewer (`webview/statement.ts`, `webview/zoom.ts`): pinch (Ctrl+wheel) zooms around the cursor via `PDFViewer.updateScale({origin})` with `preventDefault`; Cmd/Ctrl + / - / 0; page/zoom/scroll kept in webview state (serializer, restart) and globalState (`cedtGrader.statementView`, reopen); `retainContextWhenHidden`; `registerWebviewPanelSerializer('cedtGrader.statement')` reopens tabs after restart from the disk cache (no request).

Phase 5 (not started): cache management (`cedtGrader.cacheMaxMB`, LRU, daily cleanup, "Clear Cached Data" incl. stale mappings) — see spec.

Commands remain for keybindings: `cedtGrader.login`, `logout`, `submit`, `chooseProblem`, `clearMapping`, `loadTestcases`, `showLastResult`, `openStatement`, `refreshProblems`, `refreshHistory`, `showRequestLog`, `focus`.
