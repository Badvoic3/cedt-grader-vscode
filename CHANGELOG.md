# Changelog

## 0.5.0 — pre-Phase 5 checkpoint

First tagged version. Phases 1–4 of `claude-code-prompt.md` are done.

### Grader
- Uses cafe-grader's JSON API (`/api/v1`, JWT) for login, problems, languages, submit, polling, history, submission details, test cases and statements. The website is used only for the problem list page (hint / AI penalties, raw-sum mode, topic tags, exam hint).
- Counted score as the grader computes it: best regular submission, penalties taken off, raw-sum problems uncapped, shown out of the problem's full score.
- Login with "Remember password on this computer" (OS keychain via SecretStorage); silent re-login once when the 12-hour login expires; never retries a failed login.
- Careful with the server: one shared cache, debounced file switches, no requests while the panel is hidden, polling only the just-submitted submission, back-off on errors. Optional request log (`cedtGrader.debugRequests`).
- Clear connection messages in a banner with Retry; cached data stays visible, marked "may be out of date". Submit failures say whether anything was sent.
- Exam hint: a warning before submitting when the problem list looks like an exam. No contest check-ins.

### Sidebar
- Account, Current problem, Result, History and Problems sections in the Activity Bar.
- Verdict strips exactly as on the website (codes, groups, tooltips, legend), wrapping cleanly with 100+ tests.
- Full submission history with per-test details, "Open this version" and "Compare with current file".
- Problems list: status and topic filters, sorting, every problem reachable (virtualized), keeps its scroll position; row click opens the problem's file(s).
- Statement viewer tab (bundled pdf.js: zoom, pinch, search, page navigation; Markdown fallback), cached on disk, reopened after a restart without downloading again.
- Icons with tooltips and aria-labels everywhere; right-click menus with the same actions.
- Questions that don't risk losing work appear inline in the panel instead of pop-up dialogs.

### Linking files to problems
- Automatic matching: saved choice → CPH data → exact file name → confident suggestion (with a confidence threshold; close candidates ask instead). Suggestions work like links for viewing; submitting or loading test cases asks once.
- Links saved in `.cedt-grader.json` and workspace storage, with one path normalization (`./`, Unicode NFC, case on macOS / Windows); they follow renames and moves; deleted files leave a stale link that can reconnect.
- "Unlink this file" that sticks; Auto-detect; notice when several files belong to one problem (stable order, Open / Unlink / "Don't match this file").
- Copy problem name, new file for a problem (sensible extension choice), go to file, find file by name.

### Test cases and CPH
- "Load test cases": into CPH's `.prob` when CPH is installed (backup, own tests kept, no duplicates), otherwise as `.in` / `.out` files. Truncated cases are never imported. CPH is optional and never required.

### Code
- Tunables in `src/shared/constants.ts`, all user-facing text in `src/shared/strings.ts`, languages from the server, no course-specific names in code. 296 tests.
