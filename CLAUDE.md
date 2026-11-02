# CLAUDE.md — CEDT Grader Submit (VS Code extension)

VS Code extension that submits the active file to a **cafe-grader-web** server (default `https://cedt-grader.nattee.net`) through its HTML forms and shows the verdict in a sidebar. It must coexist with CPH (`DivyanshuAgrawal.competitive-programming-helper`). The full spec is in `claude-code-prompt.md`.

## Commands

```bash
npm test            # vitest (all suites, incl. real sanitized fixtures and a jsdom webview smoke test)
npm run build       # tsc --noEmit + esbuild (dist/extension.js, media/dist/webview.js|css, codicons)
npm run watch       # esbuild watch
npm run package     # production build + vsce package
npx tsx scripts/probe.ts --problem <ID> [--fixtures] [--submit file] [--list]   # needs .env
```

Press F5 to start an Extension Development Host (`.vscode/launch.json` runs `npm: build` first).

## Layout

- `src/grader/`: protocol layer with no `vscode` import (usable from the probe and tests).
  - `client.ts`: `GraderClient`.
  - `http.ts`: fetch, in-memory tough-cookie jar, manual redirects.
  - `parsers.ts`: cheerio parsers.
  - `contest.ts`: `detectContest`.
  - `languages.ts`: file extension → language.
  - `sanitize.ts`: cleans pages before they become fixtures.
  - `redact.ts`: strips secrets from logs.
- `src/controller.ts`: single owner of session and UI state. The commands, the sidebar and the status bar all go through it.
- `src/shared/messages.ts`: typed `ViewState`, `ToWebview` and `FromWebview` messages, shared by host and webview.
- `src/ui/sidebarProvider.ts`: `WebviewViewProvider`; sets the CSP (nonce) and `localResourceRoots: [media]`.
- `src/ui/statusBar.ts`: status bar shortcut that reveals the panel.
- `webview/main.ts`, `webview/style.css`: plain DOM/CSS sidebar, bundled to `media/dist/` (git-ignored).
- `src/mapping/`: `.cedt-grader.json` + workspaceState mapping (`store.ts`, `mappingFile.ts`); read-only CPH `.prob` lookup (`cph.ts`).
- `src/submitGate.ts`: pure contest gate (`allow` / `block` / `confirm`).
- `test/fixtures/`: `*.synthetic.html` files are hand-built from the cafe-grader views. The other files are real pages captured by the probe and sanitized.

## Protocol (cafe-grader-web; verified against the real server, 2026-11-02)

| Step | Request | Notes |
|---|---|---|
| CSRF | `GET /` | `meta[name=csrf-token]` or hidden `authenticity_token`. A `uuid` device cookie is set here; keep all cookies. |
| Login | `POST /login/login` | urlencoded `authenticity_token, login, password, commit=Login` (+`accept_agree` only with explicit consent). Success: 302 → `/main/list`. Failure: 302 → `/main/login` with an `.alert-danger` such as `Wrong password`. |
| List | `GET /main/list` | `table#main_table tbody tr`. Name `.font-monospace`, full name `strong` (strip U+200B). Id from `/submissions/direct_edit_problem/{id}` or `/submissions/prob/{id}` links. `/main/list.json` also exists on this server. |
| Submit page | `GET /submissions/direct_edit_problem/{pid}` | `form[action$=/main/submit]`, `select[name=language_id]` (ids differ per problem; `disabled` = forced). |
| Submit | `POST /main/submit` | multipart `authenticity_token, submission[problem_id], language_id, editor_text, commit`. Success: 302 → `/submissions/{newId}/edit`. Error: 302 → `/main/list` + flash. |
| Poll | `GET /submissions/get_latest_submission_status/{uid}/{pid}` | turbo-stream. Pending shows `Waiting to be graded...` and `data-refresh-delay-value`. Graded has `.verdict-strip[data-comment]` with `.verdict-tile.verdict-*[title]` (groups in `.verdict-group`), or `.grader-comment [Compilation error]`. The server ignores `uid`; the client takes the URL from `a#refresh` on the `/edit` page. |
| Compiler msg | `POST /submissions/{id}/compiler_msg` | `X-CSRF-Token` + `Accept: text/vnd.turbo-stream.html`; `.modal-body pre`. |
| Evaluations | `POST /submissions/{id}/evaluations` | Same headers. Returned **HTTP 500** on the real server: treat as optional. |

Gotchas found in the source and on the real server:
- **Null session:** a POST with a bad or missing CSRF token silently runs logged out. Always use a fresh token.
- **Session bounce:** a 302 → `/main/login` with an alert. Re-login once only for `You need to log in` / `Your session is expired…`. Never re-login for `two different places`, IP or disabled-account alerts.
- **Throttling:** 30 failed logins per 3 min, so never retry a failed login automatically.
- **Self-rescheduling loop:** the real `checkInLoop()` calls `setTimeout(checkInLoop, …)` inside its own body on *every* page. Only a call outside the function bodies (the contest `load` listener) means the loop was started.

## Hard rules

- Never hard-code, log, print or commit credentials, cookies or CSRF tokens.
  - The password lives only in `context.secrets` (key `cedtGrader.password:<baseUrl>:<user>`). The webview sends it once in the `login` message and clears the field; it is never in webview state.
  - The probe reads `GRADER_USER` / `GRADER_PASS` from `.env`, which is git-ignored. Never ask the user to paste a password into chat.
- Be gentle with the server:
  - Poll only after a submission, every `max(3 s, pollIntervalSeconds, server delay)`, stop at 3 min, back off ×2 on errors.
  - One submission at a time. No bulk scraping: `/main/list` is cached for 10 min, and submit pages for 2 min.
- `baseUrl`, `username` and `allowContestSubmissions` are read from **user** settings only (`scope: application` + `inspect().globalValue`), so a workspace cannot redirect credentials or enable contest submits.
- All network calls stay in the extension host; the webview has no network access (CSP `default-src 'none'`). Insert grader text with `textContent` / attributes only, never `innerHTML`.
- Keep dependencies minimal: `cheerio/slim`, `tough-cookie`, Node fetch, esbuild.

## Contest / exam safety (section 2b; overrides convenience)

Exams run as cafe-grader contests. Each page's header renders, in contest mode only:
- `#countdown` (except "ANALYSIS MODE");
- `Date.parse('<stop>')` with a non-empty end time;
- a started `setTimeout(checkInLoop, …)` in a `load` listener.

`/main/list` additionally shows `#contest-table` or the text "system is in contest mode". The website then sends `POST /contests/user_check_in` about every 60 s; contest mode also enables a one-device lock.

1. Run `detectContest()` on the **fresh submit page before every submit**. `GraderClient.submit()` does this itself, and the controller does it again for the UI. A page counts as normal only if it is a logged-in header page (`function checkInLoop` defined) with no marker; anything else, including uncertain or unparseable pages, is a contest.
2. Block by default with: "This problem is part of an active contest/exam. Submit through the website." plus an **Open in browser** button.
3. `cedtGrader.allowContestSubmissions` (default false): even when true, show a modal confirmation about instructor permission **every time**. Never remember it.
4. **Never** call `/contests/*`, imitate check-ins, fake presence or timing, or set or spoof a User-Agent. Never automate anything contest-related. Tests assert that no request touches `/contests`.
5. No polling or status requests during contests, except right after an explicitly confirmed submit. In contest mode the panel does not auto-fetch pages; the user presses **Recheck**.
6. Show a "contest" badge in the panel, the problem list and the result.
7. Login is only ever triggered by a user action, never on activation. The device lock means logging in from VS Code during an exam can lock the student's browser out. The login agreement checkbox (forced on in exam mode) is never auto-ticked: a modal asks first.

## UI

The sidebar (`cedtGrader` Activity Bar container, view `cedtGrader.panel`) is the primary interface.
- **Sections:** Account, Current problem, Result, History, Problems.
- **State flow:** the host pushes full `ViewState` snapshots and the webview posts `FromWebview` actions.
- **Commands:** they remain for keybindings: `cedtGrader.login`, `logout`, `submit`, `chooseProblem`, `showLastResult`, `openStatement`, `refreshProblems`, `focus`.
- **Shortcuts:** the status bar item reveals the panel; the editor-title ☁ button submits.
- **Styling:** only `--vscode-*` theme variables and codicons, so light, dark and high-contrast themes all work.
