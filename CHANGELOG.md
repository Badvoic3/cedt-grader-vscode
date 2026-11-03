# Changelog

## Unreleased

### CPH's panel
- With CPH installed and its setting "Auto Show Judge" on (CPH's default), CPH opens its panel on every switch to a source file and can cover this one. The panel now asks once, inside the panel: **Turn it off** (changes CPH's setting where it is on), **Keep it** (asks again next session) or **Don't ask again**.

### Attachments
- **Download attachment** (the website's "File"): a cloud-download icon on the current problem and on problem rows (and in their right-click menus, plus the command "Download Problem Attachment"), only for problems that have an attachment. Downloaded only when you click, through the grader's API (`GET /api/v1/problems/{id}/files/attachment`).
- A single file (e.g. a `.dig` or `.cpp` template) is saved next to the active file (or in the workspace root) under its own name, opened, and the panel offers to rename it to match the problem. Nothing is ever overwritten (`_2`, `_3`, …).
- A zip package is checked completely first (no unsafe paths, at most 500 files / 50 MB, macOS `__MACOSX` junk and shipped compiled programs skipped, a single top folder removed), then one question: **Name it after the problem (`<problem name>/`) and link it** (folder mode) or keep the zip's original name without linking. Always a new folder.

### Folder mode
- A problem can be linked to a **folder** instead of a single file (a package with `main.cpp` and headers): every file in the folder shows that problem. **Link the whole folder / Link only this file** switches it (folder icon on the current problem, right-click menu, command "Switch Between Linking This File and the Whole Folder").
- Two files are found automatically in a linked folder: the file you **submit** (the header you edit, e.g. `student.h` / `densegraph.h`, never the provided `main.cpp`) and the program that **runs** the tests (the driver with `main()`, e.g. `main.cpp` / `main_dense.cpp`). The rule matched every package on the grader. **Submits** and **Runs** dropdowns show them ("Automatic: …", with the reason in the tooltip) and let you choose others; choices are saved with the link in `.cedt-grader.json`. The grader takes one file per submission, so only the submit file is sent; language detection, the wrong-language hint and save-before-submit apply to it.
- **Load test cases** in folder mode always goes to the run file (CPH tests of `main.cpp`, or `<folder>/tests` files), whichever file of the folder is open.
- **Run tests** (with CPH installed): saves the folder's files, shows the run file and runs its test cases in CPH. Also works for a single linked file with CPH tests. Command "Run Tests".
- Renaming a folder now offers to move the CPH test cases of the files inside it (CPH names them after the full path).
- Folder links follow folder renames; the submit file follows renames inside the folder. ✕ unlinks the folder.

### Matching
- **Matched by folder name:** when a file's own name matches no problem, the name of the folder it is in is tried with the same rules (exact name first, then a confident suggestion), so any file in a folder named like a problem resolves to it. Same matcher both ways (clicking a problem finds those files; a folder counts as one item in "files for this problem").
- `.h` / `.hpp` headers count as C++ (`.h` as C when a problem takes C only).

### Fixes
- Test cases: the last line `KEY: …` in the expected outputs of problems with a provided `main.cpp` is left out when loading them (only the grader's own main prints it, so local runs always failed). Loading again updates tests loaded before.
- "Load test cases" without CPH no longer keeps spinning after the files are saved; "Download Again" in the result message works again. The button says the test cases come from the grader ("Load test cases from the grader").
- Questions about submitting (confirm, which file, newer file, suggested match) appear right above the **Submit to Grader** button instead of at the top of the panel.
- Folder mode: with another file of the folder open (e.g. `main.cpp`), Submit asks **Submit student.h** or **Submit main.cpp (open file)**. The answer is remembered for the folder (shown under **Submits**), so it is asked once; with "Confirm Before Submit" on it is the confirm question.
- A folder matched only by its name (e.g. a package opened in another VS Code window, where its folder link isn't saved) now works like a linked folder: **Submits** / **Runs** are detected and Submit sends the submit file instead of the open `main.cpp`. Choosing a file saves the folder link.
- The **Resubmit** button under Result is gone: **Submit to Grader** is the one way to submit.
- Long answers in the panel's questions (e.g. long folder names when extracting a zip) wrap instead of running out of the box; the extract choices say which name the folder gets ("Name it after the problem (…/) and link it" / "Keep the original name (…/), don't link").

## 0.7.0 — Phase 6 (language and customization)

### Language
- Thai: setting **CEDT Grader: Display Language** (English, ไทย (Thai), Follow VS Code), switches the panel, statement viewer, messages and status bar at once. Command names, settings and the walkthrough are in Thai when VS Code itself is in Thai. Grader content and verdict words stay as they are; Thai dates use Gregorian years.
- Plainer English messages (what happened, what to do next).
- `README.th.md` (Thai README) and pictures of the panel in both READMEs.

### Submitting
- **Save before submit** (`cedtGrader.saveBeforeSubmit`, on): the file is saved after you confirm, so the grader gets what is on disk; if saving fails nothing is sent.
- **Show the result** (`cedtGrader.revealResultAfterSubmit`, on): when grading finishes, the Result section opens and scrolls into view; keyboard focus stays in the editor.

### Files
- **File-name pattern** (`cedtGrader.fileNamePattern`, default `{name}.{ext}`): names for "New file for this problem" and "Rename file to match the problem", e.g. `{id}_{name}.{ext}`. Files named this way are matched to their problem automatically (both directions). An invalid pattern falls back to the default with a warning.

### Panel
- **Choose and order the sections** (`cedtGrader.panel.sections`): hide the ones you don't use, move Problems up, etc. Account comes back while logged out.
- **Compact mode** (`cedtGrader.panel.compact`): about 20% shorter panel with the same content.

### Releases
- Publisher `Badvoic3` (extension ID `Badvoic3.cedt-grader-submit`), the same ID the Marketplace version will use. If you installed an earlier `.vsix` (publisher `cedt-student`), uninstall it first.
- The `.vsix` is attached to GitHub Releases; README links and pictures point to the public GitHub repository.

### Help
- **Troubleshooting** link (connection banner, login errors, panel ⋯ menu, command) opens the README's troubleshooting section on GitHub, in the display language.

## 0.6.0 — Phase 5 (quality and packaging)

### Cache and storage
- Downloaded statements and test cases have a size limit (setting `cedtGrader.cacheMaxMB`, default 100 MB); the least recently used files are deleted first.
- Once a day: files unused for 30 days and leftover temporary files are removed (never anything in your workspace).
- New command **CEDT Grader: Clear Cached Data…** (also in the panel's ⋯ menu): shows the size in use and lets you choose what to clear: downloaded files, problem list / history / remembered matches, file-to-problem links (incl. `.cedt-grader.json` entries), saved login, and the `.prob.bak` backups this extension created. Asks before deleting.
- Cache files are written atomically (no half-written statements after a crash).

### Getting started
- A **Get started with CEDT Grader** walkthrough (opened by VS Code after installing from inside VS Code; any time with **CEDT Grader: Get Started** or the panel's ⋯ menu): open the panel, log in, open a solution file, check the problem, submit, optional CPH. Steps tick themselves off as you do them.
- README: step-by-step install from a `.vsix`, first steps, updating, uninstalling, troubleshooting, cache and storage.

### Packaging
- MIT `LICENSE`, extension icon, repository link.
- `npm run package` builds the `.vsix` once, without warnings and without source maps (the production build starts from empty output folders).

## 0.5.0 — pre-Phase 5 checkpoint

First tagged version (re-tagged after the last pre-Phase 5 fixes). Phases 1–4 of `claude-code-prompt.md` are done.

### Grader
- Uses cafe-grader's JSON API (`/api/v1`, JWT) for login, problems, languages, submit, polling, history, submission details, test cases and statements. The website is used only for the problem list page (hint / AI penalties, raw-sum mode, topic tags, exam hint).
- Counted score as the grader computes it: best regular submission, penalties taken off. Every score is shown out of 100 (the grader normalizes scores to 0–100, `app/engine/scorer.rb`; the API's `full_score` is not the maximum); raw-sum problems show the raw score, uncapped, with a tooltip. Fixes "100 / 40".
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
- One matcher for both directions: clicking a problem finds exactly the files that show that problem when opened (cached index of the workspace's source files); a file opened that way is a temporary link ("Suggested · Use this").
- ✕ in every state ("Unlink this file" / "Don't match this file"); "Rename file to match the problem" (editable, never overwrites, Undo works, link and CPH tests follow); Dismiss for the "files for this problem" notice.
- Links saved in `.cedt-grader.json` and workspace storage, with one path normalization (`./`, Unicode NFC, case on macOS / Windows); they follow renames and moves; deleted files leave a stale link that can reconnect.
- "Unlink this file" that sticks; Auto-detect; notice when several files belong to one problem (stable order, Open / Unlink / "Don't match this file").
- Copy problem name, new file for a problem (sensible extension choice), go to file, find file by name.

### Test cases and CPH
- "Load test cases": into CPH's `.prob` when CPH is installed (backup, own tests kept, no duplicates), otherwise as `.in` / `.out` files. Truncated cases are never imported. CPH is optional and never required.

### Code
- Tunables in `src/shared/constants.ts`, all user-facing text in `src/shared/strings.ts`, languages from the server, no course-specific names in code. 312 tests.
