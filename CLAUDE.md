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
  - `sanitize.ts`: HTML/JSON fixture scrubbing.
  - `redact.ts`: strips secrets from logs.
- `src/controller.ts`: single owner of session and UI state (results per file, history, languages, scores). Commands, sidebar and status bar all go through it.
- `src/shared/messages.ts`: typed `ViewState` / `ToWebview` / `FromWebview`.
- `src/ui/sidebarProvider.ts`: `WebviewViewProvider`; CSP with nonce, `localResourceRoots: [media]`.
- `src/ui/statusBar.ts`: status bar shortcut that reveals the panel.
- `webview/main.ts`, `webview/style.css`: plain DOM sidebar, bundled to `media/dist/` (git-ignored).
- `src/mapping/`: `.cedt-grader.json` + workspaceState mapping; read-only CPH `.prob` lookup.
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
| History | `GET /api/v1/problems/{id}/submissions` | |
| Test cases | `GET /api/v1/problems/{id}/testcases`, `/api/v1/testcases/{id}/input`, `/sol` | Phase 3 import. |

**HTML (only what the API lacks)**, via a cookie session opened at login:
- `GET /` (CSRF) → `POST /login/login` → `GET /main/list`. This page provides:
  - per-problem hint/AI penalty and raw-sum mode (`parseListScores`);
  - the page header for `isContestPage`.
- A POST with a bad CSRF token silently runs logged out (Rails null session).
- The web login form's `accept_agree` checkbox is never ticked automatically.

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
- **Be gentle with the server:**
  - Problems and the `/main/list` page: on login and on Refresh only.
  - Languages: once per session.
  - History: per problem, cached 2 min, refreshed after a submission.
  - Polling: only after a submission, every `max(3 s, pollIntervalSeconds)`, stop at 3 min, ×2 back-off on network errors.
  - One submission at a time.
- **Settings scope:** `baseUrl` and `username` are read from user settings only, so a workspace cannot redirect credentials.
- **Webview isolation:** all network calls stay in the extension host; the webview has CSP `default-src 'none'`. Insert grader text with `textContent` / attributes only, never `innerHTML`.
- **Dependencies:** keep them minimal: `cheerio/slim`, `tough-cookie`, Node fetch, esbuild.

## Exams / contests (section 2b; kept deliberately small)

- `isContestPage(html)` runs on the `/main/list` page fetched at login or refresh: a non-empty `Date.parse('…')` contest end time, or a `#countdown` that isn't "ANALYSIS MODE". There are no extra requests just for detection.
- If it returns true, submit shows a modal ("This problem looks like part of an exam/contest. Submitting from VS Code may not be allowed. Check with your instructor.") with **Open in Browser** / **Submit Anyway**. The choice is never remembered.
- Never call `/contests/user_check_in` or imitate check-ins; nothing contest-related is implemented.

## UI

The sidebar (`cedtGrader` Activity Bar container, view `cedtGrader.panel`) is the primary interface.
- **Account:** login form with remember checkbox and Keychain tip.
- **Current problem:**
  - file name;
  - searchable picker (name or id);
  - counted-score card (counted, best, latest, attempts, penalty, "your best still counts");
  - language dropdown;
  - Submit button.
- **Result** (active file only): live status, points, verdict tiles, compiler message, improvement line, Resubmit.
- **History** (server).
- **Problems:** counted score per problem.

Commands remain for keybindings: `cedtGrader.login`, `logout`, `submit`, `chooseProblem`, `showLastResult`, `openStatement`, `refreshProblems`, `focus`.
