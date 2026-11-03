# CEDT Grader Submit

**English** · [ภาษาไทย](README.th.md)

Submit the file you are editing to **CEDT Grader** ([cedt-grader.nattee.net](https://cedt-grader.nattee.net), a [cafe-grader-web](https://github.com/nattee/cafe-grader-web) server) and see your score, per-test verdicts, submission history and the problem statement inside VS Code, without opening a browser.

It works on its own. If you also use Competitive Programming Helper, see [Works with CPH](#works-with-cph). The panel is in English or Thai ([Language](#language)).

## Install

The extension comes as one file, `cedt-grader-submit-<version>.vsix`. You don't need the Marketplace.

1. **Get the file.** Open the [latest release](https://github.com/Badvoic3/cedt-grader-vscode/releases/latest) and download `cedt-grader-submit-<version>.vsix` (e.g. `cedt-grader-submit-0.7.0.vsix`) under *Assets*. Remember where you saved it. Don't unzip it.
2. **Install it in VS Code.**
   - Open the Extensions view: the four-squares icon in the left bar, or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> on macOS).
   - Click the **⋯** (Views and More Actions) at the top of the Extensions view and choose **Install from VSIX…**.
   - Pick the `.vsix` file. If VS Code asks to reload or restart extensions, click it.

   *Or, from a terminal:* `code --install-extension cedt-grader-submit-0.7.0.vsix`. On macOS, if `code` isn't found, run **Shell Command: Install 'code' command in PATH** from the Command Palette (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) first.
3. **Check that it worked.** A **CEDT Grader** icon (a page with a check mark) appears in the left bar, and, if you installed from inside VS Code, the **Get started with CEDT Grader** page opens. If it doesn't (e.g. you installed from a terminal or while VS Code was closed), run **CEDT Grader: Get Started** from the Command Palette or the **⋯** menu at the top of the panel; you can open it again the same way any time.

### First steps

1. Click the **CEDT Grader** icon in the left bar.
2. **Log in** with your grader username and password. Leave **Remember password on this computer** on if this is your own computer.
3. **Open a solution file** (e.g. `00_Intro_11.cpp`). Open the folder that holds your solutions first (**File → Open Folder…**), so links can be saved.
4. **Check the problem** under *Current problem*. A file named like the problem is found automatically; otherwise pick it from the list (search by name or id). Your choice is remembered.
5. Press **Submit to Grader**. The result, the per-test verdicts and your counted score appear in the panel.

### Optional: install CPH

[Competitive Programming Helper](https://marketplace.visualstudio.com/items?itemName=DivyanshuAgrawal.competitive-programming-helper) (CPH) runs test cases on your own computer. Install it from the Extensions view (search for "Competitive Programming Helper") if you want **Load test cases** to put the grader's test cases into CPH. Everything else works without it. See [Works with CPH](#works-with-cph).

### Updating to a new version

Install the new `.vsix` the same way (**⋯ → Install from VSIX…**). It replaces the old version; reload if asked. Your login, links and settings are kept. The version you have is shown on the extension's page in the Extensions view; what changed is in `CHANGELOG.md`.

### Uninstalling

1. Optional, to leave nothing behind: run **CEDT Grader: Clear Cached Data…** from the Command Palette and tick everything, including **Saved login** (this removes your password from the OS keychain). VS Code may keep an extension's stored data after uninstalling.
2. In the Extensions view, find **CEDT Grader Submit**, click the gear icon and choose **Uninstall** (or `code --uninstall-extension Badvoic3.cedt-grader-submit`).
3. `.cedt-grader.json` files in your solution folders (your file-to-problem links) stay; delete them if you like.

## Use it

Click the **CEDT Grader** icon in the Activity Bar. The sidebar has five sections:

<img src="media/readme/panel.png" width="300" alt="The CEDT Grader panel: Account, Current problem with a counted score of 90 / 100, Result with one tile per test, History and the Problems list">

| Section | What it does |
|---|---|
| **Account** | Log in with your grader username and password. Keep **Remember password on this computer** on to stay logged in (stored in the macOS Keychain / OS keychain). **Log out** forgets both the login and the password. |
| **Current problem** | Follows the file you are editing. Pick its grader problem from the searchable list (name or id), see your **counted score**, choose a language (only languages this problem allows are shown), then press **Submit to Grader**. Icons next to the problem: statement, copy name, open on the grader website, auto-detect, unlink. |
| **Result** | Shows live status while grading, then the points, a coloured tile per test as on the website (hover a tile or a box for details; **?** explains the colours), the compiler message if compilation failed, whether your counted score improved, a link to the submission, and **Resubmit**. |
| **History** | Every submission for this problem (website ones too), with time, language, score and verdicts; the one that counts is marked. Click one for per-test results, runtime, memory and the compiler message, to **open that version** in a new editor, or to **compare it with your current file**. |
| **Problems** | Lists all your problems (every one, however many) with their counted score. Filter by status (All / Unsolved / In progress / Solved, like the website), by topic, or by name/id, and sort (name, latest submission, best score, recently opened). Click a problem to open its file (or create / find / link one); hover a row for its icons, or right-click it for all actions. The list stays where you scrolled. |

Typical flow: open `sol.cpp` → pick the problem once (it is remembered) → **Submit** → confirm. That's two clicks for every later submission.

**Current problem.** The file name, the problem it belongs to and how it was chosen (here: *Matched by file name*), the icons for the statement, copying the name, the grader website, Auto-detect and ✕, then your counted score, the language and **Submit to Grader**.

<img src="media/readme/current.png" width="340" alt="Current problem section: 00_Intro_11.cpp matched by file name to problem 00_Intro_11, counted score 90 / 100 with best 100, latest 100, 3 attempts and a -10 AI assist penalty, language C++, Load test cases and Submit to Grader">

**Reading the results.** One tile per test, in order, coloured as on the website: green P = correct, red - = wrong answer, yellow T = time limit, and so on. Tests in a dashed box are scored together: one failing tile fails the whole box. The **?** button opens this legend; hover a tile for its test.

<img src="media/readme/result.png" width="340" alt="Result section with the Reading the results legend open: one tile per test, a dashed box for tests scored together, the score 71 / 100 and Counted score improved: 40 → 71">

**History.** Click a submission to see each test's result, time and memory, open that version, or compare it with your current file. The star marks the submission that counts.

<img src="media/readme/history.png" width="340" alt="History with submission 3 expanded: per-test results, score, time and memory, and the buttons Open this version and Compare with current file">

**Problems.** Every problem with its counted score. Filter by status or topic, search, sort; a ✓ marks the problem of the file you have open.

<img src="media/readme/problems.png" width="340" alt="Problems list with the filters All, Unsolved, In progress and Solved, a search box, sorting, topic chips and seven problems with their counted scores">

**Linking files to problems.** A file is linked automatically when its name matches a problem name (`00_Intro_11.cpp` → `00_Intro_11`; case, spaces, `-`, `_` and `.` don't matter). A file named *close to* one problem gets it as a suggestion ("Suggested from the file name · **Use this**"): you see its score, history and statement right away, and submitting or loading test cases asks once first. If several problems fit about equally, or none fits well, the panel asks you to choose. Your own choice always wins and is saved in `.cedt-grader.json` and VS Code's workspace storage; a line under the problem says how it was chosen. The ✕ next to the problem works in every case: **Unlink this file** for your own choice, **Don't match this file** for an automatic match; either way auto-detection leaves that file alone until you choose again. Clicking a problem finds the same files that would show that problem when opened (one matcher both ways). **Rename file to match the problem** renames e.g. `sol.cpp` to `00_Intro_11.cpp` (editable first, never overwrites, Undo works; the link and CPH tests follow).

If two files belong to the same problem (drafts, or the same file name in two folders), the panel tells you and lists them, with Open and Unlink (or **Dismiss** until the files change); before submitting it asks if the other file was changed more recently.

<img src="media/readme/notice.png" width="340" alt="Current problem with the notice: Another file with the same name also matches this problem, with Show and Dismiss">

Handy actions in the problem list and picker: **copy the exact problem name**, **new file for this problem** (creates `<name>.cpp` next to your file), **go to the file** for a problem (or find one by name). Questions that aren't about losing work appear right in the panel, not as pop-ups.

Renaming or moving a linked file in VS Code keeps the link. If you move files in Finder or git, the extension asks whether to keep the old link when you open the file.

**Attachments and folder mode.** For problems with an attachment (the website's "File"), the cloud-download icon on the current problem or on a problem row downloads it (only when you click). A single file is saved next to your file under its own name and the panel offers to rename it to match the problem. A zip package (e.g. `main.cpp` + `student.h` + a library header) is checked first and then extracted into a **new** folder; choose **Extract to `<problem name>/` and link it** to put the problem in *folder mode*: every file in that folder shows the problem. Nothing is ever overwritten. You can also switch an existing file's link to its whole folder with the folder icon (**Link the whole folder** / **Link only this file**). In folder mode the panel finds two files by itself: the file you **submit** (the one you edit, e.g. `student.h` — the grader takes one file per submission and has its own `main`) and the program that **runs** the tests (the provided `main.cpp` with `main()`). Both are shown under **Submits** and **Runs**, where you can pick others. **Load test cases** goes to the run file, and with CPH installed **Run tests** runs them. Files in a folder *named* like a problem are also matched automatically ("Matched by folder name").

**Test cases.** For problems that provide them, **Load test cases** downloads the grader's test cases (large cases the grader only shows in part are skipped). Without CPH they can be saved as files: `<problem name>/tests/1.in`, `1.out`, … next to your source (the extension asks before creating the folder and never overwrites your files). With CPH installed they go into CPH instead (see below).

**Also available:**
- The status bar item (`☁ Submit to Grader`, the score after grading) opens the panel.
- The ☁ button in the editor title bar (C, C++, Python, Java files) submits the current file.
- Every action is a command (`CEDT Grader: …` in the Command Palette), so you can bind keyboard shortcuts: Log In, Log Out, Submit Current File, Choose Problem for This File, Clear Problem for This File, Rename File to Match the Problem, Load Test Cases, Show Last Result, Open Problem Statement, Reload Problem List, Reload Submission History, Show Panel, Open Settings, Show Request Log, Clear Cached Data…, Get Started.

## Problem statements

Click the book icon next to the problem to open its statement in a tab beside your code (pinch or Cmd/Ctrl +/- to zoom, Cmd/Ctrl 0 to fit width, page navigation, search with Cmd/Ctrl+F). The tab remembers its page and zoom and reopens after a restart. Statements are downloaded once and kept in VS Code's own storage (never in your project); the viewer's Refresh button downloads them again. Problems without a PDF show their text description. Set `cedtGrader.statementBeside` to `false` to open statements in the current editor group.

## When the connection fails

A banner at the top of the sidebar says what went wrong (no internet, server error, session expired, too many attempts, timeout) and offers **Retry**. Your last loaded data stays visible, marked "may be out of date". If a submission was already sent, its result loads once the connection is back.

<img src="media/readme/banner.png" width="340" alt="Banner: No internet connection, with a Retry button; History below is marked May be out of date">

## Scores

The panel shows the score the grader **counts**: your best submission, not your latest, out of 100 (the grader scales every normal problem to 100, whatever its number of tests). Problems that add up raw test scores ("raw sum") show the raw number with no maximum. Hint and AI-assist penalties are taken off (e.g. "-10 AI assist"), as on the website's problem list. If your latest submission scored lower, the panel says so ("Latest: 40. Your best, 70, still counts."). Exam (contest-window) rules are not applied.

The extension only mirrors what the grader shows. **Your instructor's final grading may differ.**

## Staying logged in

With **Remember password on this computer** on, your password is kept in the OS keychain (macOS Keychain), and the extension logs in again by itself when the 12-hour grader login expires. The password field accepts paste and password-manager autofill.

## Settings

| Setting | Default | |
|---|---|---|
| `cedtGrader.displayLanguage` | `en` | Language of the panel and messages: English, ไทย (Thai), or Follow VS Code. See [Language](#language). |
| `cedtGrader.panel.sections` | all, in order | Which panel sections to show and in what order (Account, Current problem, Result, History, Problems). Remove one to hide it. Account always comes back while you are logged out. |
| `cedtGrader.panel.compact` | `false` | Compact panel: tighter spacing, the counted score on one line, one-line problem rows (full name in the tooltip), smaller verdict tiles. |
| `cedtGrader.baseUrl` | `https://cedt-grader.nattee.net` | Another cafe-grader server. User settings only. |
| `cedtGrader.username` | | Filled in when you log in from the panel. |
| `cedtGrader.pollIntervalSeconds` | `5` | How often to check while grading (minimum 3). Polling only runs after a submission and stops after 3 minutes. |
| `cedtGrader.confirmBeforeSubmit` | `true` | Ask before each submission. |
| `cedtGrader.saveBeforeSubmit` | `true` | Save the file before submitting (after you confirm), so the grader gets exactly what is on disk. Save actions such as format on save run first. If saving fails, nothing is submitted. |
| `cedtGrader.revealResultAfterSubmit` | `true` | When grading finishes, open the **Result** section and scroll it into view. Keyboard focus stays in your editor. |
| `cedtGrader.statementBeside` | `true` | Open statements beside your code. |
| `cedtGrader.defaultLanguage` | `C++` | Language for **New file for this problem** when your current file's language isn't allowed. |
| `cedtGrader.fileNamePattern` | `{name}.{ext}` | File name for **New file for this problem** and **Rename file to match the problem**: `{name}` = problem name, `{id}` = problem id, `{ext}` = extension; must end with `.{ext}`. Files named this way are matched automatically, e.g. `{id}_{name}.{ext}` → `1360_00_Intro_11.cpp`. |
| `cedtGrader.cacheMaxMB` | `100` | Size limit for downloaded statements and test cases (see [Cache and storage](#cache-and-storage)). |
| `cedtGrader.debugRequests` | `false` | Log each grader request and cache hit/miss to *Output → CEDT Grader: Requests* (no passwords or tokens). |

## Language

The panel, the statement viewer, messages, dialogs and the status bar are in **English** or **Thai**. Change it with the setting **CEDT Grader: Display Language** (`cedtGrader.displayLanguage`): *English* (default), *ไทย (Thai)*, or *Follow VS Code*. It changes at once, without a restart.

- Command names in the Command Palette, the settings descriptions and the Get Started walkthrough follow **VS Code's own display language**. They are in Thai only when VS Code itself is in Thai (Thai language pack).
- Grader content (problem names, statements, compiler messages) is never translated. Verdict words (Wrong Answer, Time Limit Exceed, …) stay as the website shows them.
- Dates in Thai use Thai month names with Gregorian years (2 พ.ย. 2026), like the grader website.

## Cache and storage

To avoid downloading the same thing twice, the extension keeps:

- **Downloaded files** (problem statements, test cases) in VS Code's own storage for extensions, never in your project. They are limited to `cedtGrader.cacheMaxMB` (100 MB by default): when the limit is reached, the files you haven't opened for the longest time are deleted first. Once a day, files you haven't used for 30 days are removed.
- **The problem list** (shown right away when VS Code starts, then reloaded once) and, while VS Code is open, your submission history and details.
- **Links** between your files and problems, in `.cedt-grader.json` in your folder and in VS Code's workspace storage.
- **Your password and login token** in the OS keychain, only with "Remember password" on.

**CEDT Grader: Clear Cached Data…** (Command Palette, or the **⋯** menu at the top of the panel) shows how much space is used and lets you choose what to clear:

| Choice | Ticked at first | Clears |
|---|---|---|
| Downloaded files | yes | statements, test cases, submission details |
| Problem list, history and remembered matches | yes | saved problem list, history, automatic matches, "not linked" files, dismissed notices, recently opened problems, links of deleted files |
| File-to-problem links | no | every problem you chose for a file, also inside `.cedt-grader.json` (the file itself is kept) |
| Saved login | no | your saved password and login token (same as Log Out) |
| Backup files from test-case imports | no | old CPH test files (`.prob.bak`) this extension kept; shown only if there are any |

It asks once more before deleting. Nothing else in your folders is ever deleted.

## Troubleshooting

The panel links here: **Troubleshooting** in the connection banner, under a login error, and in the panel's **⋯** menu (or **CEDT Grader: Troubleshooting** in the Command Palette).

**I can't log in.**
- "Wrong username or password": check them on the [grader website](https://cedt-grader.nattee.net). A wrong saved password is forgotten automatically, so type it again.
- "Too many failed login attempts": the grader blocks logins for a while after several failures (website and VS Code count together). Wait a few minutes, then try once. The extension never retries a failed login by itself.
- "The grader refused the login" (or a message from the grader about your account or network): your account may be disabled or limited to certain networks. Ask your instructor.
- Using another cafe-grader server? Set `cedtGrader.baseUrl` in your **user** settings.

**The wrong problem is detected for my file.**
Click the problem name under *Current problem* and pick the right one; your choice is remembered and always wins. ✕ next to the problem (**Unlink this file** / **Don't match this file**) stops automatic matching for that file; the sparkle icon (**Auto-detect**) tries again. **Rename file to match the problem** renames the file so it matches next time too.

**"This problem doesn't accept C++" (or another language).**
The grader only allows some languages per problem. Usually the file is linked to the wrong problem: click **Change** and pick the right one. Otherwise check the language dropdown above **Submit** and the file's extension (`.cpp`, `.c`, `.py`, …).

**No internet / the grader is down.**
A banner at the top of the panel says what happened; press **Retry** when you're back online. What was already loaded stays visible ("may be out of date"). If a submission failed, the message says whether it reached the grader; check **History** before submitting again.

**Where is my password stored?**
Only if **Remember password on this computer** is on: in your operating system's keychain (macOS Keychain, Windows Credential Manager, or the Linux secret service) through VS Code's SecretStorage. Never in settings, files or logs. **Log out** (or Clear Cached Data → Saved login) deletes it.

**Something else.**
Output → *CEDT Grader* shows errors. Turn on `cedtGrader.debugRequests` and run **CEDT Grader: Show Request Log** to see every request (no passwords or tokens).

## Exams

This is an unofficial homework tool. If a problem looks like part of an exam, the extension warns you before submitting. Ask your instructor before using it in any exam.

## Works with CPH

[Competitive Programming Helper](https://marketplace.visualstudio.com/items?itemName=DivyanshuAgrawal.competitive-programming-helper) is optional. If it is installed:

- **Matching:** a file whose CPH problem refers to a grader problem (by URL or name) is linked automatically ("Matched from CPH data").
- **Load test cases** saves the grader's cases into the file's CPH problem ("Saved to CPH"): your own CPH tests stay first, the old CPH file is backed up (`.bak`), and loading again doesn't duplicate anything. CPH only re-reads tests when you switch to the file, so use **Reload in CPH** (or switch tabs) before running them.
- **Renames:** after renaming a file in VS Code, the extension offers to move its CPH tests to the new name (CPH itself doesn't follow renames).
- Both extensions add a button to the editor title bar: CPH's runs your tests locally; ours (☁) submits to the grader.

The extension never changes CPH itself and doesn't require it. Disabling CPH switches "Load test cases" to saving files.

## Privacy

- With "Remember password" on, your password and the grader's login token are stored in the OS keychain through VS Code SecretStorage. With it off, only the token is kept, in memory. Neither is ever written to settings, files or logs, and the sidebar does not keep the password after you press **Log in**.
- Website cookies are kept in memory only, and the extension logs only request paths and status codes (Output → *CEDT Grader*).
- The extension talks only to the configured grader server. Starting VS Code sends nothing: a remembered login is restored locally, and data is loaded only while the panel is open (the problem list once per session, history for the problem you're on), when you act (log in, refresh, submit, open a statement, load test cases) and while a submission is being graded. If the remembered login has expired by then, it logs in again once with the remembered password.

## Development

```bash
npm install
npm test          # vitest: grader client (fake API), request counts, scores, parsers, matching/links, webview (jsdom)
npm run build     # typecheck + esbuild → dist/extension.js, media/dist/*
npm run package   # .vsix
npx tsx scripts/probe.ts --help   # protocol probe; credentials from .env (see .env.example)
```

Press **F5** in VS Code to start an Extension Development Host. Architecture, protocol and "where to change things" are in `CLAUDE.md`; changes in `CHANGELOG.md`.

## License

MIT, see [LICENSE](LICENSE). Unofficial; not affiliated with the grader's maintainers.
