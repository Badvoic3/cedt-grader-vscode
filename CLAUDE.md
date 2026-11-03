# CLAUDE.md — CEDT Grader Submit (VS Code extension)

An unofficial homework tool: a standalone VS Code extension that submits the active file to a **cafe-grader-web** server (default `https://cedt-grader.nattee.net`) and shows the verdict and the *counted* score in a sidebar. CPH (`DivyanshuAgrawal.competitive-programming-helper`) is **optional**: everything works without it; when installed we stay compatible (`src/cphIntegration.ts`). The full spec is in `claude-code-prompt.md`.

## Architecture

```
 VS Code extension host (Node)                                   webviews (sandboxed, CSP default-src 'none')
 ┌──────────────────────────────────────────────────────────┐    ┌───────────────────────────────────────┐
 │ extension.ts  commands, serializer, content provider     │    │ sidebar  webview/main.ts               │
 │ controller.ts GraderController: session, active file,    │◄──►│  sections re-render per ViewState slice│
 │   matching, results, inline questions, submit + poll     │msgs│  virtualized problem list, tooltips    │
 │ ui/ sidebarProvider · statementPanel · statusBar         │    │ statement viewer  webview/statement.ts │
 │ data/ DataService + RequestCache (all grader data),      │    │  bundled pdf.js, zoom, search          │
 │   StatementStore / TestcaseStore (globalStorage)         │    └───────────────────────────────────────┘
 │ mapping/ matching, links (.cedt-grader.json +            │      typed messages: src/shared/messages.ts
 │   workspaceState), files for a problem, CPH .prob        │      texts: src/shared/strings.ts
 │ grader/ GraderClient → ApiClient (JSON API, JWT)         │      tunables: src/shared/constants.ts
 │                      → WebSession (cookie, /main/list)   │
 └──────────────────────────────────────────────────────────┘
```

- **Extension host** owns every network call, all secrets and all state. Webviews only render `ViewState` and post `FromWebview` messages.
- **GraderClient** (`src/grader/client.ts`) is the only way to talk to the server: the JSON API is primary; the cookie web session is used only for `/main/list` (penalties, raw-sum, topic tags, exam hint).
- **DataService** (`src/data/dataService.ts`) is the only cache between UI and client (request discipline below); the controller never calls the client for data directly.
- **Matching**: ONE matcher for both directions (`src/mapping/match.ts` + `src/mapping/matchIndex.ts`, see "Matching" below); links live in `.cedt-grader.json` + workspaceState (`src/mapping/store.ts`).
- `src/grader`, `src/data` and the pure `src/mapping` helpers have no `vscode` import, so they are unit tested directly.

## Commands

```bash
npm test             # vitest: grader layer (fake API + web server), cache/request counts, scores, verdicts, matching/links/CPH, jsdom webviews
npm run build        # tsc --noEmit + esbuild (dist/extension.js, media/dist/webview.js|css, statement viewer, codicons, pdf.js)
npm run typecheck    # tsc --noEmit only (there is no separate linter; strict TS with noUnused* is the lint)
npm run watch        # esbuild watch
npm run package      # vsce package (its vscode:prepublish runs the production build, which empties dist/ + media/dist/ first: no source maps) → cedt-grader-submit-<version>.vsix
npx tsx scripts/probe.ts [--list] [--problem <ID>] [--fixtures] [--submit file]   # read-only unless --submit; needs .env
```

## Debugging

- F5 starts an Extension Development Host (`.vscode/launch.json` runs `npm: build` first).
- Setting `cedtGrader.debugRequests` → output channel "CEDT Grader: Requests": every HTTP request (method, path, status, numbered), cache hit / miss / dedup, file searches (`FILE SEARCH`), never tokens. Command "CEDT Grader: Show Request Log".
- Other errors (e.g. activation) go to the "CEDT Grader" output channel, never to the console.
- The probe (`scripts/probe.ts`) checks the live protocol with `GRADER_USER` / `GRADER_PASS` from `.env` and can save sanitized fixtures (`--fixtures`); review them before committing.

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
  - `attachment.ts`: `parseContentDisposition` (`filename*` UTF-8 first, base name only, unusable → null), `Attachment`.
  - `redact.ts`: strips secrets from logs.
- `src/data/`: the one shared cache layer (no `vscode` import; request counts are unit tested).
  - `cache.ts`: `RequestCache` (session / TTL / final-only entries, in-flight de-duplication).
  - `dataService.ts`: `DataService` (problems, languages, history, details; debounce, visibility, after-submit refresh, stale-on-error; reports failures to the controller's banner). `downloadAttachment` (on click only, never cached, in-flight dedup; errors go to the caller).
  - `statementStore.ts`: statement PDF / description cache in `globalStorage/statements/<host>/<id>.pdf|json`.
  - `testcaseStore.ts`: grader test cases per problem in `globalStorage/testcases/<host>/<id>.json` (downloaded one at a time; truncated cases listed, never imported). `stripGraderKey`: problems with a provided driver end every expected output with `KEY: <token>` (printed by the grader's own main; seen live on an attachment problem, absent on a problem without one); removed when importing (CPH / files) only if every case has the same key and the run file doesn't contain it; the cache keeps the grader's text.
  - `cacheFiles.ts`: downloaded-file housekeeping (see "Cache and storage"): `scanCache`, `touch` (LRU marker = mtime), `writeAtomic`, `pickLru` / `pickExpired`, `enforceLimit`, `cleanupCache`, `clearCacheFiles`.
  - `cacheClear.ts`: "Clear Cached Data" categories (`CLEAR_ORDER`, `CLEAR_DEFAULTS`), `planClear` (which keys / actions per checkbox), backup records (`recordBackup`, `backupsToDelete`).
- `src/controller.ts`: session, mapping and UI state (results per file, expanded history entry). All grader data goes through `DataService`. Commands, sidebar and status bar all go through the controller.
- `src/shared/messages.ts`: typed `ViewState` / `ToWebview` / `FromWebview`.
- `src/shared/i18n.ts`: display language (`cedtGrader.displayLanguage`: `en` / `th` / `auto` = follow VS Code). `setLanguage()` overwrites the live tables of `strings.ts` (`S`, `W`, `G`, `HOW_LINKED`, `PICK_HOW`, `W_SOURCE`, `MATCH_SOURCE`) in place; `EN` is the reference table and `Strings` its type (a translation must have the same keys / function parameters). Changing the setting: `GraderController.applyLanguage()` → tables, statement tabs (`reloadAll`), sidebar (`reload`: new `<html lang>`; webview state keeps scroll / filters). Webview entry points import `webview/lang.ts` first. Never copy a text into a module-level constant (read `S.x` at call time; `test/i18n.test.ts` guards notifications, titles, status bar). VS Code's own texts (commands, settings, walkthrough) are `%key%` in package.json → `package.nls.json` (follows VS Code's display language).
- `src/shared/walkthrough.ts`: Getting Started walkthrough id and the context keys its steps complete on (`walkthroughContext(ViewState)`; `extension.ts` sets them only when they change). Steps in `package.json` `contributes.walkthroughs`, pages in `media/walkthrough/*.md`.
- `src/shared/layout.ts`: `cedtGrader.panel.sections` (`normalizeSections`: known ids, order kept, empty → all) and `visibleSections` (Account forced first while logged out). The webview's `applyLayout` hides / moves the existing section elements only when the order changes, and toggles `body.compact` (`cedtGrader.panel.compact`; CSS at the end of `webview/style.css`, approved mockup; problem rows count as one line, so the virtual list is laid out again).
- `src/shared/submitOptions.ts`: `needsSave` (`cedtGrader.saveBeforeSubmit`, default on: save after the confirmation, before sending; save failed → nothing sent) and `shouldRevealResult` (`cedtGrader.revealResultAfterSubmit`, default on: when grading finishes for the active file, the host sends `focus: 'result'`; the webview opens and scrolls to Result without taking keyboard focus).
- `src/shared/stateKeys.ts`: `KEYS`, every workspaceState / globalState key (one list; a test fails if a key literal appears elsewhere).
- `src/ui/sidebarProvider.ts`: `WebviewViewProvider`; CSP with nonce, `localResourceRoots: [media]`.
- `src/ui/statusBar.ts`: status bar shortcut that reveals the panel (warning icon while the connection banner is up).
- `src/ui/statementPanel.ts` + `webview/statement.ts`: "Statement: <problem>" editor tabs (bundled pdf.js 4.10 viewer: zoom, fit width, pages, text selection, search; description fallback rendered with markdown-it `html: false`).
- `webview/main.ts`, `webview/style.css`: plain DOM sidebar, bundled to `media/dist/` (git-ignored).
  - Sections re-render only when their slice of `ViewState` changed (`sectionKeys`); `forceRender()` after local UI changes.
  - `webview/tooltip.ts`: the one custom tooltip (`data-tip`; `el()` maps `title` → `data-tip`). Never use native `title`.
  - `webview/filters.ts`: problem list status/topic/text filter (website rules).
  - `webview/virtualList.ts`: the virtualized problem list (only visible rows + buffer; rows keyed by problem id, rebuilt only when their data/✓ changed; measured heights; `revealNearest`).
  - `webview/text.ts`: `middleEllipsis` / `menuLabelMax` for right-click menu labels.
- `src/mapping/` (Phase 3, linking):
  - `match.ts`: `cleanName`, `normalizeName`, `resolveProblem` (saved → CPH → exact file name → confident suggestion; ties → ask), `scoreCandidates` / `decideSuggestion`, `fileNameFor`.
  - `matchIndex.ts`: `matchFile` (file → problem) and `buildMatchIndex` (problem → files, the same function over all source files), `OnceCache`.
  - `namePattern.ts`: `cedtGrader.fileNamePattern` (`{name}` / `{id}` / `{ext}`, must end with `.{ext}`; `checkPattern` → invalid falls back to `{name}.{ext}` with a warning). Used by `fileNameFor` (New file), `renameProposal` / `nameMatchesProblem`, and `resolveProblem`'s exact-name step (`namePattern`), so both matcher directions agree; changing it rebuilds the match index.
  - `suggestionGate.ts`: `confirmSuggestion` (write actions on a suggestion ask once).
  - `renameToProblem.ts`: "Rename file to match the problem" helpers (proposal, conflicts, validation).
  - `paths.ts`: the one path normalization for links (NFC, `./`/`..` resolved, `/` separators; `pathKey` lower-cases on macOS/Windows). Used by mappings, `.cedt-grader.json`, renames, reverse lookup, reconnect.
  - `store.ts`: workspaceState keyed by `<folder name>/<pathKey(relative path)>` (+ legacy fsPath keys read) and `.cedt-grader.json`; reverse lookup (problem → files), rename, mark deleted (stale), expire, reconnect; explicit "not linked" set (`cedtGrader.unlinked`, follows renames); remembered auto-matches (`cedtGrader.autoMatches`).
  - `problemFiles.ts`: "files for this problem" (`mergeProblemFiles`: chosen links + remembered auto-matches + match-index files, minus "not linked" and files linked elsewhere), `linkedNotice` wording, `noticeSignature` / `noticeDismissed`, `comparePaths`, auto-match rename/delete rules.
  - `mappingFile.ts`: `.cedt-grader.json` parsing (`staleSince` kept), `reverseIndex`.
  - `mappingOps.ts`: pure move logic (`planRename`, `reconnectCandidates`, `affectedByDelete`, `expired`) and `moveCphProblem`.
  - `cph.ts` / `cphImport.ts`: CPH `.prob` read / import (format below). `newFile.ts`: create without overwriting.
  - `folderRoles.ts`: folder mode's two files, pure: `detectFolderRoles` → run file (the only C/C++ source with `main(` at a line start, comments/strings removed, `int|signed|void|auto`; else the only one named `main*`; else ask) and submit file (`submitFor`: in the run file's transitive `#include "…"` closure, relative to the includer then the folder root, run file excluded: named in a stub-like comment of the run file → `student.*` → the only file matching `STUB` → ask). Checked against all 47 zip packages on the live grader (47/47 = the file the statement says to submit, 0 asks).
  - `attachment.ts`: attachments (fflate `unzipSync`): `attachmentKind` (zip = name/type says zip AND `PK\3\4` bytes), `planZip` (all checks in memory before writing: `entryPath` rejects absolute / drive / `..` / reserved characters, duplicate paths (pathKey) rejected, `__MACOSX` / `.DS_Store` / `._*` and shipped build output (`BINARY_EXTS` except `.pdf`, extensionless ELF / Mach-O / PE) skipped, `ATTACHMENT.maxEntries` / `maxTotalBytes` on declared and real sizes, one shared top folder stripped), `submitCandidates`, `fileToOpen` (`int main` first), `freeFolderName` (`_2`), `writeExtracted` (new folder only, `wx`, stays inside), `writeNewFile` (`wx`).
  - `newFileLanguage.ts`: extension order for "New file" (active file → last used → `cedtGrader.defaultLanguage` → quick pick; never archive/binary automatically).
  - `findByName.ts`: `sourceGlob` / `excludeGlob` / `filterSourceFiles` (which files the matcher looks at: source extensions, no binaries / build output / `.cph` / `node_modules` / `*.dSYM`, plus `files.exclude`, `search.exclude`, `.gitignore`) and `rankCandidates`.
- `src/cphIntegration.ts`: optional CPH detection, test-case target choice, "Save as files" writer.
- `test/fixtures/`: `*.synthetic.*` files are hand-built from the cafe-grader views and controllers. The others are real data captured by the probe and sanitized.

## Protocol (cafe-grader-web @ 404d3c5; verified against the live server)

**JSON API (primary)**, JWT in `Authorization: Bearer <token>`:

| Purpose | Request | Notes |
|---|---|---|
| Login | `POST /api/v1/auth/login` `{login,password}` | → `{token, expires_at, user}`, 12 h TTL. 401 wrong password, 429 throttled, 403 disabled/IP. |
| Problems | `GET /api/v1/problems` | `best_score` = max over regular submissions (no penalty), `last_score`, `submission_count`, `last_submission_id`, `permitted_languages` (null = all), `has_testcase`. |
| Languages | `GET /api/v1/languages` | `id, name` (internal), `pretty_name`, `ext`. |
| Submit | `POST /api/v1/problems/{id}/submissions` `{language_id, source, filename}` | 201 `{id, number, status}`. 422 + `permitted_languages` = language not allowed. |
| Poll | `GET /api/v1/submissions/{id}` | `status`: `done`/`compilation_error`/`grader_error` are final. Also `points`, `grader_comment` (`PP-T[Px]`), `compiler_message`. |
| History | `GET /api/v1/problems/{id}/submissions` | All regular submissions, newest first, incl. website ones. |
| Detail | `GET /api/v1/submissions/{id}` | `source` (own only), `source_filename`, `max_runtime` ms, `peak_memory` KB, `evaluations[{testcase_id, result, score, time ms, memory KB}]`. |
| Test cases | `GET /api/v1/problems/{id}/testcases` (403 = not allowed), `GET /api/v1/testcases/{id}/input`, `/sol` | text/plain; student `preview` access truncates large files: `X-Testcase-Truncated: true`, `X-Testcase-Byte-Size`. Never import a truncated case. Driver problems: last line `KEY: <token>` (see `stripGraderKey`). |
| Statement | `GET /api/v1/problems/{id}/files/pdf` | 403 = PDF hidden, 404 = none → fallback `GET /api/v1/problems/{id}/description` `{markdown, description}`. |
| Attachment | `GET /api/v1/problems/{id}/files/attachment` | The website's "File" (`has_attachment`). `send_data` with the stored `Content-Type` and `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`. 404 = none. Seen live: `.dig` (`application/xml`), `.cpp` (`text/x-c++src`), `.zip` packages (`application/zip`: flat or one top folder, `__MACOSX` junk, `.cbp`, sometimes binaries/PDFs; stored/deflate). Only on click; capped at 20 MB. Probe: `--problem <id> --attachment` (headers + zip entry names, never the body). |
| Me | `GET /api/v1/me` | `full_name` for the Account section, once per session after a token restore. |

**HTML (only what the API lacks)**, via a cookie session opened at login:
- `GET /` (CSRF) → `POST /login/login` → `GET /main/list`. This page provides:
  - per-problem hint/AI penalty and raw-sum mode (`parseListScores`);
  - the page header for `isContestPage`.
- A POST with a bad CSRF token silently runs logged out (Rails null session).
- The web login form's `accept_agree` checkbox is never ticked automatically.

## CPH is optional

- Detection only in `src/cphIntegration.ts` (`CphPresence`: `vscode.extensions.getExtension(id)`, re-checked on `extensions.onDidChange`). Never add CPH to `extensionDependencies` / `extensionPack` (a test checks).
- Grader, data, sidebar and statement code must not import CPH modules (a test scans `src/grader`, `src/data`, `src/ui`, `webview`).
- Reading `.prob` files for matching only when they exist.
- "Load test cases": CPH installed → CPH `.prob` ("Saved to CPH" + "Reload in CPH"); not installed → ask once per workspace: "Save as files" (`<source dir>/<clean problem name>/tests/<n>.in|out`, folder creation confirmed, existing files never overwritten) or "Install CPH" (`extension.open`).
- No "CPH" in display name, description, command titles or main UI text; only where it's used.

## Accessibility

Every icon-only button (`iconButton()` in `webview/main.ts`, `btn()` in `webview/statementToolbar.ts`) has a tooltip (`data-tip`, shown by `webview/tooltip.ts`) and an identical `aria-label`; disabled buttons explain why in the tooltip (`iconButton(..., { disabledReason })`, `button(..., { title })`). `test/webview.test.ts` ("accessibility") and `test/statementToolbar.test.ts` fail otherwise.

## CPH `.prob` (confirmed in agrawal-d/cph @ ef8c7a7: `src/types.ts`, `src/parser.ts`, `src/webview/editorChange.ts`)

- Path: `<dir of source>/.cph/.<basename>_<md5(full source path)>.prob`, or `<cph.general.saveLocation>/<same name>`.
- JSON `{name, url, interactive, memoryLimit, timeLimit, group, tests:[{input, output, id}], srcPath, local?, customCheckerPath?}`, written by CPH with plain `JSON.stringify`.
- CPH re-reads a `.prob` only on `onDidChangeActiveTextEditor` (no reload command; commands: runTestCases, submitToCodeForces, compileWithoutRunning) and saves its in-memory problem back, so after writing a `.prob` the user must switch to the file before running tests ("Reload in CPH" does that by briefly showing a placeholder tab).
- CPH has no rename/delete handling; a renamed source orphans its `.prob` (we offer to move it).
- Our imported tests: `id = 7e15 + grader testcase id` (marker that survives CPH re-saves); backup `<file>.prob.bak`; own tests first and never removed; duplicates by input+output skipped; line endings `\n`.
- Never modify CPH itself; only write `.prob` files in this exact format.
- CPH's `cph.general.autoShowJudge` (default on) opens CPH's panel on every switch to a source file and can cover ours. `maybeAskCphAutoShow` (after `setActiveFile` and when the panel becomes visible; only while visible, CPH installed, no other prompt) asks once per session inline: **Turn it off** (`cphAutoShowScope`: updated at the level where it is on — folder / workspace / user), **Keep it** (this session), **Don't ask again** (`cedtGrader.cphAutoShowDismissed`). A question cancelled by a file switch or another prompt comes back later. This is the only CPH setting we ever change, and only on that click.

## Folder mode and attachments

- **Folder link:** a `.cedt-grader.json` / workspaceState entry keyed by the folder's path with `folder: true` and optional `submitFile` / `runFile` = the user's choices (relative to the folder, `/` separators; parse drops one outside the folder; kept in the link, not a separate state key, so they travel with `.cedt-grader.json` and follow renames). Without a choice both are detected (`folderRoles.ts`) on every file switch and after file events in the folder (`onFileEvent` → `setActiveFile`). `MappingStore.resolve(uri)`: the file's own entry wins, else `nearestFolderLink` (deepest non-stale folder entry above it); a "not linked" file or folder → none. `linksFor` marks folder links; `filesFor` / `mappedProblemIds` include them. Old versions see a "file" entry nobody opens (harmless).
- **Renames / deletes:** `planRename` / `affectedByDelete` already remap the folder path (folder rename moves the link). `submitFileAfterMove` (rename inside → new relative path; moved out → cleared) and `submitFileDeleted` (cleared → detected again) for both `submitFile` and `runFile` in `MappingStore.rename` / `markDeleted`. A renamed folder orphans CPH files (named after the old full path): `cphFilesAfterFolderRename` finds them (in the moved `.cph/` folders, or CPH's save location, by `srcPath`) and the existing "Move CPH test cases too?" question moves them (`moveCphProblem(…, fromPath)`, `.bak` kept).
- **Roles** (`folderRole('submit' | 'run')`: choice → detection (a chosen run file re-runs `submitFor`) → the only source file → null). Card: **Submits** / **Runs** dropdowns ("Automatic: <file>" first, why in the tooltip, picking Automatic forgets the choice; `setFolderRole` message).
- **Test cases / Run tests:** in folder mode "Load test cases" always targets the run file (`runUri()`: CPH `.prob` of `main.cpp`; files → `<folder>/tests`). **Run tests** (card button + `cedtGrader.runTests`, only when CPH is installed; disabled "load the test cases first" while the run file's `.prob` has no tests): saves dirty files of the folder (or the file), shows the run file (`reloadCph` when it is already active, since CPH re-reads `.prob` only on an editor change), then `cph.runTestCases` (`CPH_RUN_COMMAND`, no arguments: CPH runs the active editor; CPH compiles only that file, and `main.cpp` includes the submit file from the folder). Outside folder mode it runs the active file's own CPH tests.
- **Matched by folder name = folder mode, unsaved** (`folderMatched`): a file whose problem comes from its folder's name (`source: 'folder'`, no folder link) gets the same folder mode (`loadFolder(dirname)`: Submits / Runs detected, Submit sends the submit file, test cases go to the run file), with the match line "Matched by folder name", the toggle offering "Link the whole folder" and ✕ "Don't match this folder". Nothing is saved until the user chooses: `saveFolderRole` (Submits / Runs pick, the which-file question) saves the folder link with that choice. Without this, a package opened in another workspace (links are per workspace root) would submit the open `main.cpp`.
- **Submit file or open file** (`askSubmitFileOrOpen`, above Submit): when another source file of the folder is open (e.g. `main.cpp`), Submit asks "Submit student.h" / "Submit main.cpp (open file)" / Cancel. Asked while the submit file is only detected (the answer is saved as the folder's `submitFile`, so it is asked once) and every time with `confirmBeforeSubmit` on (it then replaces the confirm question). Not asked when the open file is the submit file.
- **Submit target** (`GraderController.targetUri()`): folder mode → `<folder>/<submit file>` (choice / detected / only source file, else null = ask on submit: inline buttons up to `ATTACHMENT.maxInlineChoices`, else QuickPick; saved with the link); otherwise the active file. Language guess / mismatch / per-file language, results, reveal, last result, compare and save-before-submit all use the target. The API takes one `source` + `filename`, so only that file is sent (said in the card and the confirm question).
- **Switch** (`toggleFolderMode`: header icon `folder`/`file`, header menu, command `cedtGrader.toggleFolderMode`): file → folder links the active file's parent (never a workspace root or a folder outside the workspace: disabled reason) with `submitFile` = the active file, removes file links to the same problem inside it, asks before replacing another problem's folder link; folder → file removes the folder link and links the submit file (else the active file).
- **Files for this problem** (`mergeProblemFiles`): files matched by their folder name (`how: 'folder'`) and chosen folder links are ONE item each (`folder: true`, fsPath = folder); files inside a folder item are covered by it (unless chosen on their own); "not linked" and links elsewhere block by prefix. A folder item opens its stand-in file (`folderItemFile`: submit file, else `int main`, else first source); the newer-file check treats the current folder as "this one".
- **Download** (`downloadAttachment`: header icon `cloud-download` and row icon/menu only when `hasAttachment`, command `cedtGrader.downloadAttachment`): target folder like New file. Single file: own name (fallback `fileNameFor`), `freeName` + `wx`, opened, linked when it has a source extension, then inline "Rename it to <proposal>?" (WorkspaceEdit rename, Undo works). Zip: `planZip` first (errors inline, nothing written; roles detected from the planned files, the submit file is opened afterwards), then ONE inline question = folder-creation confirm + link question: **Extract to `<folderNameFor(problem)>/` and link it** (folder mode; `submitFile` set when there is one source file) / **Extract to `<top folder or zip stem>/` only** / Cancel; `freeFolderName`, then reveal in Explorer and open the `int main` file.

## Problem links: auto-detect, duplicates, unavailable problems

(Matching rules and states: see "Matching" above.)

- Auto-detect (sparkle button): `resolveProblem` without the saved link; asks inline before replacing a manual link; clears "not linked".
- Files for a problem: `GraderController.filesForProblem()` is the only source for the duplicate notice, row click / go to file, Find file by name and the before-submit "changed more recently" check. It merges saved links, remembered auto-matches and the match index (see "Matching"), minus "not linked" files and files linked to another problem.
- Notice: same name in different folders → "Another file with the same name also matches this problem." (files listed below); otherwise "N files are linked to this problem". Stable order everywhere: workspace-relative path, natural, case-insensitive (`comparePaths`); the active file is only marked ("this file"), rows never move. Each file shows how it's linked, with Open and Unlink (chosen) / "Don't match this file"; "Unlink the other files"; Dismiss. Submit asks (inline, once) when another file for the problem is newer (mtime; dirty = now).
- `MappingStore.cleanupDuplicates()` (startup and on saving `.cedt-grader.json`) removes legacy + new duplicate keys and same-path JSON entries (one path normalization, `src/mapping/paths.ts`), rewrites the file, and reports only real changes, once.
- Unavailable: `resolveProblem` returns `unavailable` for a saved link missing from the loaded list; `ProblemUnavailableError` (ApiClient, 404/403 on `/api/v1/problems/{id}…`, incl. submit) marks it at runtime (`unavailableIds`, cleared when the problem is back in the list). Submit disabled, history kept (stale), statement opens from cache with a "may be out of date" note.

## Problem list and verdicts (as on the website)

- Status (`problemStatus`): solved = submitted and best ≥ 100; inprogress = submitted and best < 100; untried = none. Filters All / Unsolved / In progress / Solved, persisted per workspace (`cedtGrader.problemFilter`).
- Topics: `/main/list` `.topic-badge` pills (`Tag.where(kind: 'topic')`, `parseTopicTags`); the API `tags` (names only) is the fallback.
- Verdicts (`src/grader/verdicts.ts`): codes in `RESULT_CODE` order `? P - s T M x E !`; strip only if it matches the website's `VERDICT_STRING_RE`; groups `[...]` = box with `groupLabel()` (website text); otherwise plain `[text]`. Legend popover "Reading the results".
- Header: `titleParts()` drops a repeated `name:` prefix from `full_name`; match source as a text line under the selector.
- Sorting (`webview/filters.ts` `sortProblems`): default / name A–Z, Z–A (numeric) / latest submission / best score ↑↓ / recently opened (`cedtGrader.recentlyOpened` in workspaceState); stored in the filter (`sort`).
- Verdict strip layout: `.strip > * { flex: 0 0 auto }` + `.tile-group { max-width: 100% }` keeps groups whole; History rows show "passed/total" inline and the full mini strip (all tiles, wrapping, groups) on its own line. Checked visually in headless Chrome at 260/420 px with 12/40/120 tests.
- Account: `client.user.fullName` (login response or `GET /api/v1/me`, once per session after a token restore).
- CPH tip (`cphTip` in ViewState): not installed + problem with test cases; "Not now" = this session, "Don't show again" = `cedtGrader.cphTipDismissed`.

## Scoring (src/grader/score.ts)

- **Every score is out of 100.** cafe-grader normalizes the `sum` and `group_min` score types to 0–100 whatever the number of tests, weights or groups (`app/engine/scorer.rb`). The API's `full_score` is **not** the maximum and is not used. The 100 is `SERVER_SCORE_CAP` in `src/shared/constants.ts` (comment points to scorer.rb).
- **Raw-sum problems** (`raw_sum` / `custom_testlib_raw`; detected from the `/main/list` score column, the API has no score type): the raw score, no "/ max", uncapped, with a tooltip explaining why.
- One display rule, `scoreText(points, rawSum)` / `outOfFor(rawSum)`: Current problem card, problem-row pills, Result and History all use it ("70 / 100" or "37" + tooltip).
- Counted: `counted = max(0, min(best, 100 − min(100, hint_cost + ai_cost)))` (`Submission.max_score_report`); `best` = max over regular submissions, not the latest.
- Penalties come from `/main/list` ("from problem list"). Without that page (password not remembered and the web session gone) the panel shows best scores and says so.
- Exam (contest-window) filtering is not applied (the API doesn't apply it either). The README says the instructor's final grading may differ.
- "Solved" (list filter) = submitted and best ≥ 100, as on the website.

## Matching (one matcher, both directions)

- `resolveProblem` (src/mapping/match.ts) is the only matcher: saved link (the file's own, else its nearest folder link) → CPH `.prob` (URL or name) → exact normalized file name → **exact name of the folder the file is in** (`folders.at(-1)`, workspace-relative; name / full name / name pattern; source `'folder'`) → confident suggestion from the file name → the same suggestion rules for the folder name. Normalization: zero-width removed, trim, lower case, `space - _ .` the same separator, NFC. A file at the top of a workspace folder has no folder step.
- Suggestions: score = name similarity (+ `MATCH.folderTagBonus` when a parent folder is named like one of the problem's tags). Used only if ≥ `MATCH.suggestMinScore` and ahead of the next by ≥ `MATCH.suggestMinMargin`; close scores → "Several problems could match this file. Choose one."; below → "Not linked to a problem" (candidates ≥ `MATCH.pickerMinScore` only in the picker).
- Problem → file uses the same function: `buildMatchIndex` runs `matchFile` (= `resolveProblem` without saved link / CPH) over all source files from one `workspace.findFiles` (`sourceGlob` + `excludeGlob` + `filterSourceFiles`, at most `LIMITS.indexMaxFiles`), cached in `OnceCache` until a file is created / deleted / renamed (1 s debounce) or the problem list reloads; built only while the panel needs it; logged as `FILE SEARCH`. Before opening, a candidate whose CPH data points to another problem is dropped (same answer as opening it). A test checks that both directions agree for every fixture.
- **States** (match line under the selector): **Chosen by you** (saved link; also confirmed suggestions) · **Folder linked by you: `pkg/`** (folder mode) · **Matched by file name** · **Matched by folder name** · **Matched from CPH data** · **Suggested** (muted "Suggested from the file name · Use this"; confident suggestion or a *temporary link*) · **Not linked to a problem** (explicitly unlinked, or no confident match).
- **Temporary link:** a row click that opens a single name-matched / suggested file shows that problem for it ("Suggested · Use this") until another file becomes active; Use this / Choose another / Don't match this file decide.
- **✕ in every state:** a chosen link → "Unlink this file"; a name / CPH match, suggestion or temporary link → "Don't match this file"; folder mode → "Unlink this folder"; matched by folder name → "Don't match this folder". All store the sticky "not linked" state (`cedtGrader.unlinked`, follows renames; a folder entry covers every file below it); choosing a problem or Auto-detect clears it (Auto-detect also for folders above the file).
- Suggestions behave like links for everything read-only (score, history, results, statement, files for this problem, notice, ✓) and load only that one problem; write actions (Submit, Load test cases) ask once inline (`confirmSuggestion`), yes saves the link.
- Remembered auto-matches (`cedtGrader.autoMatches`): file name / CPH / suggestion of files that were open; never over a manual link or "not linked"; dropped on delete; kept on rename only if the matcher still agrees.
- **Rename file to match the problem** (Current problem link, header right-click, command): shown when the name doesn't match (same normalization); proposes `<clean problem name>.<ext>`, editable; `WorkspaceEdit.renameFile` (editors, links, rename handling and the CPH prompt follow; Undo works); never overwrites (suggests `<name>_2.<ext>`).
- **Files for this problem** notice: Dismiss hides it per problem until the set of files or how they are linked changes (`cedtGrader.dismissedNotices`, `noticeSignature`); "Clear Cached Data" (lists) resets it.

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
- **Dependencies:** keep them minimal. Runtime: `cheerio/slim`, `tough-cookie`, `markdown-it`, `fflate` (zip attachments; chosen by the user over a hand-written reader), Node fetch. Bundled at build time: `pdfjs-dist`, `@vscode/codicons`. Dev: esbuild, TypeScript, vitest, jsdom, tsx, vsce.

## Cache and storage

| Where | What |
|---|---|
| globalStorage | `statements/<host>/<id>.pdf\|json`, `testcases/<host>/<id>.json` (the only files the cache code touches: `CACHE_DIRS`) |
| workspaceState / globalState | keys in `src/shared/stateKeys.ts` (problem list, links, "not linked", auto-matches, notices, recently opened, statement view, backups, …) |
| SecretStorage | password and token (only with "Remember") |
| memory | history and submission details (`RequestCache`; never on disk) |
| workspace | `.cedt-grader.json`, `.cph/*.prob.bak` (written by test-case import / CPH move; recorded in `cedtGrader.backups`), downloaded attachments (only on click, never overwriting; not cache: never cleaned up) |

- Size limit `cedtGrader.cacheMaxMB` (default 100, min 10): after every write (`onWrite` → `cacheWritten`, one run at a time, the new file kept) the least recently used files go first. Stores `touch()` files on every cache hit; writes are atomic (`*.tmp` + rename).
- Daily (`dailyCleanup`, at most once a day): stale links > 30 days, files unused 30 days, `*.tmp` older than 30 days, size limit, statement view state of statements no longer cached. Never touches the workspace.
- **Clear Cached Data…** (`cedtGrader.clearCache`, panel "⋯" menu + palette): QuickPick with the size in use, checkboxes (`CLEAR_DEFAULTS`):
  - Downloaded files [on]: statements, test cases, statement view state, submission details in memory.
  - Problem list, history and remembered matches [on]: saved problem lists, history, auto-matches, "not linked", dismissed notices / reconnects, recently opened, stale links.
  - File-to-problem links [off]: all links incl. the entries of each `.cedt-grader.json` (file kept; a file with unsaved edits is skipped), per-file languages.
  - Saved login [off]: same as Log Out.
  - Backup files [off, shown only if any]: only recorded `.prob.bak` files that still exist.
  - Then a modal confirm. Settings-like state (filter, test-case target, remember, CPH tip) is never cleared.

## Getting Started walkthrough

- `contributes.walkthroughs` `cedtGrader.start`: Open the panel (`onView:cedtGrader.panel`) → Log in (`onContext:cedtGrader.loggedIn`) → Open a solution file (`cedtGrader.hasSourceFile`) → Check the problem (`cedtGrader.hasProblem`) → Submit (`cedtGrader.submitted`, a submission was sent this session) → Optional: install CPH (`extensionInstalled:`). A test checks ids, pages, context keys and command links.
- Opened after install by VS Code itself (`workbench.welcomePage.walkthroughs.openOnInstall`, default on), but only for an install inside a running window (Install from VSIX…); a CLI install (`code --install-extension`) or one while VS Code is closed doesn't open it (checked by the user). Decided: no own fallback (it would need `onStartupFinished` activation in every window); the README tells users to run "Get Started". Reopen: `cedtGrader.openWalkthrough` ("Get Started", panel ⋯ menu).

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
  - header icons, always visible: Open statement, Copy problem name, Open on the grader website, Download attachment (only with `hasAttachment`; disabled "Downloading…"), Link the whole folder / Link only this file (disabled reason at the workspace root), Auto-detect, ✕ (Unlink this file / folder, Don't match this file / folder, every state); right-click on the header offers the same plus "Rename file to match the problem" (not in folder mode or for a folder-name match);
  - "Rename file to match the problem" link when the file name doesn't match;
  - match line under the selector ("Chosen by you" / "Matched by file name" / "Matched from CPH data"; a suggestion is a muted "Suggested from the file name · Use this"; choosing from the dropdown confirms too); notes for ambiguous / stale mappings;
  - "Not linked to a problem" (Choose problem / Auto-detect) after "Unlink this file": the file is stored as explicitly unlinked (`cedtGrader.unlinked`), so auto-detection leaves it alone until the user chooses or auto-detects;
  - "files for this problem" notice (see Problem links);
  - "Load test cases" (when `has_testcase`; for a suggestion it asks once first; CPH or files);
  - counted-score card (counted, best, latest, attempts, penalty, "your best still counts");
  - language dropdown;
  - folder mode: **Submits** and **Runs** dropdowns ("Automatic: <detected file>" + why in the tooltip, or "asked when needed") + "only this file is sent";
  - **Run tests** (CPH installed; disabled until the run file has tests);
  - Submit button.
- **Result** (active file only): live status, points, verdict tiles, compiler message, improvement line (no Resubmit button: Submit is the one way to submit).
- **History** (API): every submission with relative/exact time, language, score, mini verdict strip, counted marker; expand for details (per test, runtime, memory, compiler message) and "Open this version" / "Compare with current file" (`cedt-grader-submission:` read-only documents, served from the cache).
- **Problems:** counted score per problem; virtualized, every problem reachable by scrolling; count "292 problems" / "127 of 292 problems". The list element is persistent: scroll position survives re-renders, data refresh and hide/show (`listScroll` in webview state); an editor switch only updates rows whose ✓ changed. No scroll after a row click; when the user opens a file themselves the active row is revealed with a minimal ("nearest") scroll. Row click opens the problem's file(s) via `filesForProblem(…, includeSuggested)` — saved links, remembered auto-matches, name matches and suggestions (opening never links) — (several → pick in path order labeled linked / matched by file name / suggested; missing → offer to remove the stale link; none → Link to <current file> / Create a new file / Find a file by name / Open statement; never links by itself). Row icons on hover / keyboard focus: copy name, go to file or find file by name, new file, download attachment (only with `hasAttachment`), statement. Right-click on a row: the same plus "Link to <file>" and "Open on the grader website". Row tooltip: bold "name #id" + full name only.
- **Inline questions** (`askInline` → `ViewState.prompt`, plain buttons under the banner, long labels wrap inside the box; cancelled on file switch; questions about submitting have `near: 'submit'` and are shown right above the Submit button instead, scrolled into view, Current problem opened; at the top only when that section is hidden by the layout): submit confirmation, suggested-match submit, newer linked file, auto-detect result, unlink other files, reconnect after a move, stale link. Native modal dialogs only for what can't be undone or loses data: overwrite a file, Clear Cached Data, the exam warning.
- **Context menus** (`withContextMenu` in `webview/main.ts`): always in addition to visible icons, never instead. Long labels are cut in the middle (`webview/text.ts`), full label in tooltip + aria-label.

Statement viewer (`webview/statement.ts`, `webview/zoom.ts`): pinch (Ctrl+wheel) zooms around the cursor via `PDFViewer.updateScale({origin})` with `preventDefault`; Cmd/Ctrl + / - / 0; page/zoom/scroll kept in webview state (serializer, restart) and globalState (`cedtGrader.statementView`, reopen); `retainContextWhenHidden`; `registerWebviewPanelSerializer('cedtGrader.statement')` reopens tabs after restart from the disk cache (no request).

## Where to change things

| What | Where |
|---|---|
| Repository URL, README troubleshooting anchors ("Troubleshooting" link: banner, login error, ⋯ menu, `cedtGrader.openTroubleshooting`) | `REPO_URL`, `TROUBLESHOOTING` in `src/shared/constants.ts` (keep in sync with `package.json` `repository` and the README headings; `test/submitOptions.test.ts` checks) |
| Default grader URL, website paths | `src/shared/constants.ts` (`DEFAULT_BASE_URL` — also `package.json` default; `WEB_PATHS`) |
| Timings: poll interval/timeout/back-off, GET retries, debounce, history TTL, request timeout, file-event debounce, token fallback, daily cleanup | `src/shared/constants.ts` `TIMING` (poll interval also setting `cedtGrader.pollIntervalSeconds`) |
| Webview timings and sizes (tooltip delay, list height, scroll save, row-click window, statement state save) | `src/shared/constants.ts` `PANEL` |
| Cache size / age limits | `CACHE` in `src/shared/constants.ts` (size also setting `cedtGrader.cacheMaxMB`); what "Clear Cached Data" removes: `src/data/cacheClear.ts`; stored key names: `src/shared/stateKeys.ts` |
| Limits (match-index file cap, remembered auto-matches, recently opened), stale-link days | `src/shared/constants.ts` `LIMITS`, `STALE_LINK_DAYS` |
| Suggestion confidence (threshold, tie margin, folder/tag bonus, picker cut-off) | `src/shared/constants.ts` `MATCH` |
| Score maximum / penalty cap / "solved" threshold (server literal 100, scorer.rb) | `SERVER_SCORE_CAP` in `src/shared/constants.ts`; display rule `scoreText` in `src/grader/score.ts` |
| Matching (normalization, scoring, states) | `src/mapping/match.ts`; problem → file index `src/mapping/matchIndex.ts`; which files are looked at `src/mapping/findByName.ts` |
| Languages / extensions | from the server (`GET /api/v1/languages` `ext`); fallback table + aliases in `src/grader/languages.ts`; non-source (never auto-picked) in `src/mapping/newFileLanguage.ts`; binary extensions in `src/mapping/findByName.ts` |
| Verdict codes, words, group text | `src/grader/verdicts.ts` (website `RESULT_CODE` order) |
| User-facing text | `src/shared/strings.ts`: `S` host messages / questions / picks, `W` sidebar + statement webviews, `G` grader errors / connection banner / status bar / score lines, `HOW_LINKED`, `PICK_HOW`, `W_SOURCE` |
| Path normalization for links | `src/mapping/paths.ts` |
| "Files for this problem" rules and notice wording | `src/mapping/problemFiles.ts` |
| Folders never searched | `EXCLUDED_DIRS` in `src/mapping/findByName.ts` |
| Attachment caps (download size, zip entries / total size, inline submit-file buttons) | `ATTACHMENT` in `src/shared/constants.ts`; extraction rules `src/mapping/attachment.ts` |
| Settings | `package.json` `contributes.configuration` + `src/config.ts` |

No course- or problem-specific names in code (problem names come from the server; `test/scalability.test.ts` checks).

## Upgrading from an older version

Every release must keep data written by older versions working (`test/upgrade.test.ts` checks the v0.7.0 shapes):
- **`.cedt-grader.json`:** new fields are optional (`folder`, `submitFile`, `runFile`); an old file parses the same, never becomes a folder link, and is written back byte for byte. Never rename or repurpose an existing field; bump `version` only with a reader for the old one.
- **workspaceState / globalState:** keys only in `src/shared/stateKeys.ts`; a changed shape gets a new key (e.g. the problem list's `.v2`) or a normalizer (`normalizeProblem` fills fields older saved lists lack). Legacy keys are still read (`KEYS.legacyMapping`, fsPath link keys).
- **Caches:** `globalStorage` JSON keeps its format; anything unreadable is treated as a cache miss, never an error.
- **CPH files:** our imported tests are recognised by their id (`GRADER_ID_BASE` + grader id), so a re-import updates tests written by an older version (e.g. ones with the `KEY:` line) instead of adding duplicates.
- **Settings:** never rename a setting; add a new one and read the old one as fallback.
- The 0.6.x → 0.7.0 publisher change (`cedt-student` → `Badvoic3`) makes a separate extension: VS Code keeps its globalState / secrets / workspaceState apart, so users log in again and lose links that were only in workspaceState (`.cedt-grader.json` links survive). The CHANGELOG / README say to uninstall the old one first.
- Downgrading is not supported: an older version drops the folder fields when it rewrites `.cedt-grader.json`.

## Known limitations

- Contest-window filtering of the counted score is not applied (the API doesn't apply it either); exams only get the warning in section 2b.
- Hint / AI penalties need the `/main/list` HTML page; without a web session (password not remembered and the session gone) the panel shows best scores and says so.
- The API has no "binary language" flag: non-source languages (Archive, Digital, Viva, Text) are recognised by name / extension (`src/mapping/newFileLanguage.ts`).
- The problem picker dropdown shows at most 50 matches ("N more. Refine the search."); the Problems list itself has no limit.
- The match index reads at most `LIMITS.indexMaxFiles` (5 000) source files; files beyond that are only matched when opened.
- Folder mode submits ONE file (the API takes one `source`); the grader compiles it with its own driver (statements say "submit only student.h"; the grader's main may differ from the starter main). That the server accepts a header such as `student.h` with language C++ was not verified by a real submit (no test submissions on the live server).
- The folder-name step looks at the file's immediate parent folder only (a package with sub-folders: files in sub-folders match by their own folder, or via a folder link). A folder link's source-file list reads at most `ATTACHMENT.maxEntries` entries.
- `.h` maps to C++ (C when a problem takes C only); `.hpp/.hh/.hxx` to C++ (fallback table; the server lists only `.cpp`).
- Zip extraction supports what fflate supports (stored / deflate; no encryption, no zip64 beyond fflate's support); entries are written as plain files (a symlink entry becomes a small text file).
- Undo of "Rename file to match the problem" relies on VS Code's undo for WorkspaceEdit file operations (checked by hand, not by a test).
- The controller (vscode-dependent) has no unit tests; its rules are kept in pure, tested helpers (`problemFiles.ts`, `suggestionGate.ts`, `match.ts`, `mappingOps.ts`, `paths.ts`) and the webview is tested in jsdom.
- English only; texts are already in `src/shared/strings.ts`, ready for Phase 6.

## Releasing

- Publisher **`Badvoic3`** (extension ID `Badvoic3.cedt-grader-submit`), decided 2026-11-03 so the GitHub `.vsix` and the Marketplace are the same extension. The user registers exactly this publisher ID on the Marketplace later (not done yet: no Azure DevOps account). Changing it later would make the Marketplace version a second, separate extension.
- The repo is public: `npm run package` / `npm run publish` let vsce rewrite README links to `https://github.com/Badvoic3/cedt-grader-vscode/{blob,raw}/HEAD/…` (the Marketplace needs web addresses; pictures load from GitHub). `test/i18n.test.ts` checks the scripts don't turn that off.
- **GitHub Release** (main way to install for now): bump `version` (package.json + package-lock), CHANGELOG heading, `npm test`, `npm run package`, commit, `git tag -a vX.Y.Z`, push with the tag, then `gh release create vX.Y.Z cedt-grader-submit-X.Y.Z.vsix --title "vX.Y.Z" --notes-file <CHANGELOG section>`. README install step 1 links to `/releases/latest`.
- **Marketplace** (when the user says "publish"): the user runs `! npx vsce login Badvoic3` once and pastes a personal access token (Azure DevOps → User settings → Personal access tokens, organization *All accessible organizations*, scope **Marketplace → Manage**; never pasted in chat). Then `npm run publish` (vsce publish; runs the production build). After that, move "Install from the Marketplace" first in both READMEs (search "CEDT Grader Submit"; updates are automatic) and keep the `.vsix` from Releases as the fallback.
- Optional later: a GitHub Actions workflow publishing on `v*` tags with the token as repo secret `VSCE_PAT`.

## Release decisions (Phase 5)

- LICENSE: MIT, © 2026 Nutthanun Kongsorn. `repository`: https://github.com/Badvoic3/cedt-grader-vscode. Icon: `media/icon.png` (128 px, rendered from `media/icon.svg`; the Activity Bar uses the SVG).
- No source maps in the `.vsix`. No ESLint: strict `tsc` (noUnused*) is the lint.
- **Git history: rewritten before the first push** (2026-11-02): every commit and the `v0.5.0` tag use the GitHub noreply address (`git config user.email` is set to it); the old personal email is in no object. All hashes before that date changed. The deleted fixture `test/fixtures/submission_edit.html` (added in 884623c, removed in 21d606d) is sanitized (CSRF tokens `***`, user id 12345, empty `int main`) and stays in history.

## Open questions

- Exam time window in the counted score: keep as a limitation (recommended; the API has no contest data) or implement via contest pages?
- Verdict codes: stay in `src/grader/verdicts.ts` (they mirror the server) or move to `src/shared/constants.ts`?

## Not done yet

- Phase 6: done (v0.7.0, confirmed 2026-11-03, released on GitHub). Marketplace publishing waits for the user's publisher account (see Releasing).

Commands (kept for keybindings; the panel is the primary interface): `cedtGrader.login`, `logout`, `submit`, `chooseProblem`, `clearMapping`, `loadTestcases`, `showLastResult`, `openStatement`, `refreshProblems`, `refreshHistory`, `showRequestLog`, `clearCache`, `openWalkthrough`, `openSettings`, `renameFileToProblem`, `downloadAttachment`, `toggleFolderMode`, `runTests`, `focus`.
