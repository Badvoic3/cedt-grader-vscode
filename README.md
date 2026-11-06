# CEDT Grader Submit

**English** · [ภาษาไทย](README.th.md)

Submit the file you are editing to **CEDT Grader** ([cedt-grader.nattee.net](https://cedt-grader.nattee.net), a [cafe-grader-web](https://github.com/nattee/cafe-grader-web) server) without opening a browser. A panel in VS Code shows your score, the result of every test, your submission history, the problem list and the problem statement.

This is an unofficial homework tool. It is not made by the grader's maintainers.

<img src="media/readme/panel.png" width="300" alt="The CEDT Grader panel: Account, Current problem with a counted score of 90 / 100, Result with one tile per test, History and the Problems list">

- **Submit** the open file and see the verdict of each test, as on the website.
- **Counted score:** your best submission, with hint and AI-assist penalties taken off.
- **Every problem** in one list, with filters for status, topic and tags.
- **Statements** open in a tab beside your code.
- **Test cases:** load the grader's test cases, or the sample cases from the statement, as `.in` / `.out` files or into CPH.
- **Packages:** download a problem's attachment and work on a whole folder (`main.cpp` + `student.h`).
- English or Thai ([Language](#language)). Works on its own; [CPH](#works-with-cph) is optional.

## Install

You need **VS Code 1.82 or newer**.

### In VS Code (Marketplace)

1. Click the **Extensions** icon in the left bar (four squares, or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> / <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> on macOS).
2. Search for **CEDT Grader Submit** (`Badvoic3.cedt-grader-submit`).
3. Click **Install**.

<img src="media/readme/install.png" width="340" alt="Installing in VS Code: 1. click the Extensions icon in the left bar, 2. search for CEDT Grader Submit, 3. click Install; the CEDT Grader icon appears in the left bar">

Updates install automatically.

### From a `.vsix` file

Use this if you can't use the Marketplace.

1. Open the [latest release](https://github.com/Badvoic3/cedt-grader-vscode/releases/latest) and download `cedt-grader-submit-<version>.vsix` under *Assets*. Don't unzip it.
2. In the Extensions view, click **⋯** (Views and More Actions) at the top and choose **Install from VSIX…**. Pick the file. If VS Code asks to reload, click it.

*Or, from a terminal:* `code --install-extension cedt-grader-submit-<version>.vsix`. On macOS, if `code` isn't found, first run **Shell Command: Install 'code' command in PATH** from the Command Palette (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>).

### Check that it worked

A **CEDT Grader** icon (a page with a check mark) appears in the left bar. If you installed from inside VS Code, the **Get started with CEDT Grader** page opens. You can open it any time with **CEDT Grader: Get Started** from the Command Palette or the **⋯** menu at the top of the panel.

## First steps

1. Click the **CEDT Grader** icon in the left bar.
2. Log in with your grader username and password. Leave **Remember password on this computer** on if this is your own computer.
3. Open the folder that holds your solutions (**File → Open Folder…**), then a solution file, e.g. `00_Intro_11.cpp`.
4. Check the problem under **Current problem**. A file named like a problem is found by itself. Otherwise pick the problem from the list (search by name or id). Your choice is remembered.
5. Press **Submit to Grader**. The result of each test and your counted score appear in the panel.

## The panel

The panel has five sections:

| Section | What it shows |
|---|---|
| **Account** | Log in and out. **Log out** forgets the login and the saved password. |
| **Current problem** | The problem of the file you are editing, your counted score, the language, test-case buttons and **Submit to Grader**. |
| **Result** | The submission you just sent: live status, points, one tile per test, the compiler message. |
| **History** | Every submission for this problem, also those from the website. |
| **Problems** | All your problems with their counted score. |

You can hide or reorder sections and make the panel compact (see [Settings](#settings)).

### Current problem

It shows the file name, the problem it belongs to and how the problem was found (here: *Matched by file name*). Then your counted score, the language and **Submit to Grader**.

<img src="media/readme/current.png" width="340" alt="Current problem section: 00_Intro_11.cpp matched by file name to problem 00_Intro_11, counted score 90 / 100 with best 100, latest 100, 3 attempts and a -10 AI assist penalty, language C++, Load test cases and Submit to Grader">

The icons next to the problem:

- **Open statement** (PDF icon), **Copy problem name**, **Open on the grader website**.
- **Download attachment**, only for problems that have one (see [Folder mode and attachments](#folder-mode-and-attachments)).
- **Save the grader's test cases as .in / .out files**, only for problems with test cases.
- **Link the whole folder** / **Link only this file**.
- **Auto-detect** (sparkle) finds the problem again; **✕** unlinks it.

Right-click the problem for the same actions and **Rename file to match the problem**.

Only the languages the problem allows are in the language list. If the file's language isn't allowed, the panel says "This problem doesn't accept C++. Wrong problem?" and offers **Change**.

### Result

While grading, the panel shows the live status. Then you see the points, one coloured tile per test as on the website, the compiler message if compilation failed, and whether your counted score improved.

<img src="media/readme/result.png" width="340" alt="Result section with the Reading the results legend open: one tile per test, a dashed box for tests scored together, the score 71 / 100 and Counted score improved: 40 → 71">

**Reading the results:** tiles are in test order. Green P = correct, red - = wrong answer, yellow T = time limit, and so on. Tests in a dashed box are scored together: one failing tile fails the whole box. Hover a tile or a box for details. The **?** button opens this legend.

### History

Click a submission to see each test's result, time and memory. **Open this version** opens that code in a new editor; **Compare with current file** shows the differences. The star marks the submission that counts.

<img src="media/readme/history.png" width="340" alt="History with submission 3 expanded: per-test results, score, time and memory, and the buttons Open this version and Compare with current file">

### Problems

Every problem, however many, with its counted score on the left and its tags. A grey "–" means you haven't submitted yet. A ✓ marks the problem of the open file.

<img src="media/readme/problems.png" width="340" alt="Problems list with the filters All, Unsolved, In progress and Solved, a search box, sorting, topic chips and seven problems with their counted scores">

- **Status:** All / Unsolved / In progress / Solved, as on the website.
- **Topics:** click a topic pill to show only that topic's problems, click again to hide them, a third time to turn it off. Several pills can be on at once. The setting `cedtGrader.panel.topicClickOrder` puts "hide" first.
- **Tags:** the **Tags** dropdown lists the other tags. Tick several and choose **Any (OR)** or **All (AND)**.
- **Search** by name or id, and **sort** (Default order, Name A–Z, Name Z–A, Latest submission, Best score (low to high / high to low), Recently opened).

Click a problem to open its file. If there is none, you can link the current file, create a new file, find a matching file or open the statement. Hover a row (or move to it with the keyboard) for its icons: **Copy problem name**, **Go to linked file** or **Find a matching file**, **New file for this problem**, **Open statement**, and **Download attachment** when there is one. Right-click a row for all actions. With the keyboard, ↑ / ↓ / Home / End move between problems and Tab goes to the row's icons.

The list keeps its scroll position.

## Linking files to problems

**Found by itself.** A file whose name matches a problem name is linked to it (`00_Intro_11.cpp` → `00_Intro_11`). Case, spaces, `-`, `_` and `.` don't matter. A file in a folder named like a problem also gets that problem ("Matched by folder name").

**Suggestions.** A file named *close to* one problem gets it as a suggestion: "Suggested from the file name · **Use this**". You see its score, history and statement at once. Submitting or loading test cases asks once first. If several problems fit about equally, the panel asks you to choose.

**Your choice wins.** A problem you pick is saved in `.cedt-grader.json` in your folder and in VS Code's storage. The line under the problem says how it was found: **Chosen by you**, **Matched by file name**, **Matched by folder name**, **Matched from CPH data** or **Suggested**.

**Submitting.** A file whose problem was found by itself asks once before its first submit. After that it is "Chosen by you" and **Submit to Grader** sends at once. Questions about submitting appear right above the button.

**✕ next to the problem** works in every case: **Unlink this file** for your own choice, **Don't match this file** for an automatic match (**Unlink this folder** / **Don't match this folder** in folder mode). Either way, the file is left alone until you choose a problem or press **Auto-detect**.

**Rename file to match the problem** renames e.g. `sol.cpp` to `00_Intro_11.cpp`. You can edit the name first. It never overwrites a file, Undo works, and the link and CPH tests follow.

**Several files for one problem.** If two files belong to the same problem (drafts, or the same name in two folders), the panel tells you and lists them, with **Open** and **Unlink**. **Dismiss** hides the notice until the files change. Before you submit, it asks if the other file was changed more recently.

<img src="media/readme/notice.png" width="340" alt="Current problem with the notice: Another file with the same name also matches this problem, with Show and Dismiss">

**Moving files.** Renaming or moving a linked file in VS Code keeps the link. If you move files outside VS Code (Finder, git), the panel asks whether to keep the old link when you open the file.

## Folder mode and attachments

Some problems come as a package: a provided `main.cpp` that runs the tests, and a file you edit, such as `student.h`. Folder mode links the whole folder to the problem.

<img src="media/readme/folder-mode.png" width="340" alt="Current problem in folder mode: student.h open, Folder linked by you: grader/07_Class_12/, Submits Automatic: student.h, Runs Automatic: main.cpp, the note that only this file is sent, Load test cases, Load samples, Run tests and Submit to Grader">

**Download the attachment.** For problems with an attachment (the website's "File"), click **Download attachment** on the current problem or on a problem row. It is downloaded only when you click.

- **A single file** is saved next to your file under its own name and opened. The panel offers to rename it to match the problem.
- **A zip package** is checked first, then extracted into a **new** folder. Choose **Name it after the problem (`<problem name>/`) and link it** to start folder mode, or **Keep the original name (`<name>/`), don't link**.
- Nothing is ever overwritten. Zips with unsafe paths, more than 500 files or more than 50 MB are refused. macOS junk files, hidden folders such as `.git` and compiled programs are skipped.

**Link a folder yourself.** Click **Link the whole folder** next to the problem. **Link only this file** switches back.

**Submits and Runs.** In folder mode the panel finds two files by itself:

- **Submits:** the file that is sent to the grader, e.g. `student.h`. The grader takes one file per submission and uses its own `main`.
- **Runs:** the program that runs the tests, e.g. `main.cpp` with `main()`.

Each dropdown starts with "Automatic: <file>"; hover it to see why that file was chosen. Pick another file if needed; your choice is saved with the folder link. If another file of the folder is open when you submit, the panel asks once: "Submit student.h" or "Submit main.cpp (open file)".

**Test cases in folder mode** always go to the run file. With CPH installed, **Run tests** saves the folder's files and runs the tests in CPH. The grader's own `main` prints an extra last line `KEY: …` that the provided `main.cpp` doesn't, so that line is left out of the expected outputs.

A folder named like a problem works the same way ("Matched by folder name"): Submits and Runs are found by themselves. Folder links are saved per workspace folder, so a folder linked in one VS Code window isn't linked in a window opened on its parent folder. The folder-name match covers that case.

## Test cases and sample cases

**Load test cases** downloads the grader's test cases (only for problems that provide them). Large cases the grader shows only in part are skipped.

- **Without CPH**, the first time it asks where they go: **Save as Files** or **Install CPH**. Files go to `<problem name>/tests/1.in`, `1.out`, … next to your source. The panel asks before creating the folder and never overwrites your files.
- **With CPH**, they go into CPH (see [Works with CPH](#works-with-cph)).
- The **Save the grader's test cases as .in / .out files** icon next to the problem always saves them as files, also with CPH installed.

**Load samples** works for every problem. It reads the example input/output table in the statement PDF and saves those cases the same way: into CPH, or as `tests/sample1.in`, `sample1.out`, … A case that is already there is skipped. An unusual layout may be read wrong, so check the cases. When part of the table can't be read, nothing is loaded and the panel says so. It works on ruled tables with selectable text, not on scanned pages.

## Problem statements

Click the PDF icon (**Open statement**) to open the statement in a tab beside your code.

- Zoom with a pinch or <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> <kbd>+</kbd> / <kbd>-</kbd>; <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> <kbd>0</kbd> fits the width. Search with <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>F</kbd>.
- The tab remembers its page and zoom and reopens after a restart.
- Statements are downloaded once and kept in VS Code's storage, never in your project. The viewer's Refresh button downloads them again.
- Problems without a PDF show their text description.
- An open statement tab follows your file: switching to another solution file shows that file's problem. Turn this off with `cedtGrader.statementFollowsFile`.

## More ways to submit

- The status bar item (☁ **Submit to Grader**, with the score after grading) opens the panel.
- Every action is a command in the Command Palette (`CEDT Grader: …`), so you can give it a keyboard shortcut: Log In, Log Out, Submit Current File, Choose Problem for This File, Clear Problem for This File, Rename File to Match the Problem, Load Test Cases from the Grader, Save Test Cases as .in / .out Files, Load Sample Cases from the Statement, Run Tests, Download Problem Attachment, Switch Between Linking This File and the Whole Folder, Show Last Result, Open Problem Statement, Reload Problem List, Reload Submission History, Show Panel, Open Settings, Show Request Log, Clear Cached Data…, Get Started, Troubleshooting.

## Works with CPH

[Competitive Programming Helper](https://marketplace.visualstudio.com/items?itemName=DivyanshuAgrawal.competitive-programming-helper) (CPH) runs test cases on your own computer. It is optional: everything else works without it. If it is installed:

- **Load test cases** and **Load samples** save the cases into the file's CPH problem ("Saved to CPH"). Your own CPH tests stay first, the old CPH file is backed up (`.bak`), and loading again doesn't add duplicates.
- CPH reads new tests only when you switch to the file. If the file is already open in front, the extension does this for you; otherwise press **Reload in CPH** (or switch to the file) before running them.
- **Run tests** (folder mode, or a file with CPH tests) runs them in CPH.
- **Matching:** a file whose CPH problem refers to a grader problem (by URL or name) is linked to it ("Matched from CPH data").
- **Renames:** after you rename a file or folder in VS Code, the extension offers to move its CPH tests too (CPH itself doesn't follow renames).
- **CPH's panel covering this one:** CPH opens its own panel each time you switch to a source file (its setting "Auto Show Judge"). The panel asks once whether to turn that off: **Turn it off**, **Keep it** or **Don't ask again**. You can still open CPH yourself.

The extension never changes CPH itself and doesn't require it. Without CPH, test cases are saved as files.

## When the connection fails

A banner at the top of the panel says what went wrong (no internet, server error, login expired, too many attempts, timeout) and offers **Retry**. What was loaded before stays visible, marked "may be out of date". If a submission was already sent, its result loads when the connection is back.

<img src="media/readme/banner.png" width="340" alt="Banner: No internet connection, with a Retry button; History below is marked May be out of date">

## Scores

The panel shows the score the grader **counts**: your best submission, not your latest.

- Scores are out of 100. The grader scales every normal problem to 100, whatever its number of tests.
- Problems that add up raw test scores ("raw-sum scoring") show the raw number with no maximum.
- Hint and AI-assist penalties are taken off (e.g. "-10 AI assist"), as on the website's problem list. They are read from the website's problem list. If the panel can't read that page (for example, your password isn't remembered and the website login has ended), it shows your best scores without penalties and says so.
- If your latest submission scored lower, the panel says so ("Latest: 40. Your best, 70, still counts.").
- Exam (contest-window) rules are not applied.

The extension only shows what the grader shows. **Your instructor's final grading may differ.**

## Exams

This is an unofficial homework tool. If a problem looks like part of an exam, the extension warns you before submitting (**Open in Browser** / **Submit Anyway**). Ask your instructor before using it in an exam.

## Settings

| Setting | Default | |
|---|---|---|
| `cedtGrader.displayLanguage` | `en` | Language of the panel and messages: English, ไทย (Thai), or Follow VS Code. See [Language](#language). |
| `cedtGrader.panel.sections` | all, in order | Which panel sections to show, in what order (Account, Current problem, Result, History, Problems). Remove one to hide it. Account always comes back while you are logged out. |
| `cedtGrader.panel.compact` | `false` | Compact panel: tighter spacing, the counted score on one line, one-line problem rows (full name in the tooltip), smaller verdict tiles. |
| `cedtGrader.panel.topicClickOrder` | `showFirst` | What the first click on a topic pill does: `showFirst` = show only that topic's problems (the second click hides them), `hideFirst` = hide them first (the second click shows only them). The third click turns the filter off. |
| `cedtGrader.baseUrl` | `https://cedt-grader.nattee.net` | Another cafe-grader server. User settings only. |
| `cedtGrader.username` | | Filled in when you log in from the panel. |
| `cedtGrader.pollIntervalSeconds` | `5` | How often to check while grading (minimum 3). Checking runs only after a submission and stops after 3 minutes. |
| `cedtGrader.confirmBeforeSubmit` | `true` | Ask once before submitting a file whose problem was matched automatically (file name, folder name, CPH data). Submitting saves the match as your choice ("Chosen by you"), so it isn't asked again. Problems you chose yourself are never asked; suggestions always are. |
| `cedtGrader.saveBeforeSubmit` | `true` | Save the file before submitting (after you confirm), so the grader gets exactly what is on disk. Save actions such as format on save run first. If saving fails, nothing is submitted. |
| `cedtGrader.revealResultAfterSubmit` | `true` | When grading finishes, open the **Result** section and scroll to it. Keyboard focus stays in your editor. |
| `cedtGrader.statementBeside` | `true` | Open statements beside your code. `false` = in the current editor group. |
| `cedtGrader.statementFollowsFile` | `true` | An open statement tab switches to the problem of the file you switch to, and closes when that file has no problem. |
| `cedtGrader.defaultLanguage` | `C++` | Language for **New file for this problem** when your current file's language isn't allowed. |
| `cedtGrader.fileNamePattern` | `{name}.{ext}` | File name for **New file for this problem** and **Rename file to match the problem**: `{name}` = problem name, `{id}` = problem id, `{ext}` = extension; must end with `.{ext}`. Files named this way are matched automatically, e.g. `{id}_{name}.{ext}` → `1360_00_Intro_11.cpp`. |
| `cedtGrader.cacheMaxMB` | `100` | Size limit for downloaded statements and test cases (see [Cache and storage](#cache-and-storage)). |
| `cedtGrader.debugRequests` | `false` | Log each grader request and cache hit/miss to *Output → CEDT Grader: Requests* (no passwords or tokens). |

## Language

The panel, the statement viewer, messages and the status bar are in **English** or **Thai**. Change it with the setting **CEDT Grader: Display Language** (`cedtGrader.displayLanguage`): *English* (default), *ไทย (Thai)* or *Follow VS Code*. It changes at once, without a restart.

- Command names, setting descriptions and the Get Started walkthrough follow **VS Code's own display language**. They are in Thai only when VS Code itself is in Thai (Thai language pack).
- Grader content (problem names, statements, compiler messages) is never translated. Verdict words (Wrong Answer, Time Limit Exceed, …) stay as the website shows them.
- Dates in Thai use Thai month names with Gregorian years (2 พ.ย. 2026), like the grader website.

## Staying logged in and privacy

- With **Remember password on this computer** on, your password and login token are kept in your operating system's keychain (macOS Keychain, Windows Credential Manager or the Linux secret service) through VS Code. The extension logs in again by itself when the 12-hour grader login expires. With it off, only the token is kept, in memory.
- The password is never written to settings, files or logs. The panel doesn't keep it after you press **Log in**. When another user logs in, or the grader address changes, the earlier saved login is deleted.
- The extension talks only to the grader server in `cedtGrader.baseUrl`, and follows redirects only within that address. Starting VS Code sends nothing: data is loaded only while the panel is open, when you act (log in, refresh, submit, open a statement, load test cases, download an attachment) and while a submission is graded.
- Website cookies are kept in memory only. Logs show only request paths and status codes.

## Cache and storage

To avoid downloading the same thing twice, the extension keeps:

- **Downloaded files** (statements, test cases) in VS Code's storage for extensions, never in your project. They are limited to `cedtGrader.cacheMaxMB` (100 MB by default): when the limit is reached, the files you haven't opened for the longest time go first. Once a day, files unused for 30 days are removed.
- **The problem list** (shown at once when VS Code starts, then reloaded once) and, while VS Code is open, your submission history and details.
- **Links** between your files and problems, in `.cedt-grader.json` in your folder and in VS Code's workspace storage.
- **Your password and login token** in the OS keychain, only with "Remember password" on.

**CEDT Grader: Clear Cached Data…** (Command Palette, or the **⋯** menu at the top of the panel) shows how much space is used and lets you choose what to clear:

| Choice | Ticked at first | Clears |
|---|---|---|
| Downloaded files | yes | statements, test cases, submission details |
| Problem list, history and remembered matches | yes | saved problem list, history, automatic matches, "not linked" files, dismissed notices, recently opened problems, links of deleted files |
| File-to-problem links | no | every problem you chose for a file, also inside `.cedt-grader.json` (the file itself is kept) |
| Saved login | no | your saved password and login token (the same as Log Out) |
| Backup files from test-case imports | no | old CPH test files (`.prob.bak`) this extension kept; shown only if there are any |

It asks once more before deleting. Nothing else in your folders is ever deleted.

## Updating and uninstalling

**Updating.** From the Marketplace, updates are automatic. With a `.vsix`, install the new file the same way (**⋯ → Install from VSIX…**); it replaces the old version. Your login, links and settings are kept. What changed is in [CHANGELOG.md](CHANGELOG.md).

**Uninstalling.**

1. Optional, to leave nothing behind: run **CEDT Grader: Clear Cached Data…** and tick everything, including **Saved login** (this removes your password from the keychain). VS Code may keep an extension's data after uninstalling.
2. In the Extensions view, find **CEDT Grader Submit**, click the gear icon and choose **Uninstall** (or run `code --uninstall-extension Badvoic3.cedt-grader-submit`).
3. `.cedt-grader.json` files in your solution folders (your links) stay; delete them if you like.

## Troubleshooting

The panel links here: **Troubleshooting** in the connection banner, under a login error, and in the panel's **⋯** menu (or **CEDT Grader: Troubleshooting** in the Command Palette).

**I can't log in.**
- "Wrong username or password.": check them on the [grader website](https://cedt-grader.nattee.net). A wrong saved password is forgotten, so type it again.
- "Too many failed login attempts.": the grader blocks logins for a while after several failures (website and VS Code count together). Wait a few minutes, then try once. The extension never retries a failed login by itself.
- "The grader refused the login.": your account may be disabled or limited to some networks. Ask your instructor.
- Using another cafe-grader server? Set `cedtGrader.baseUrl` in your **user** settings.

**"The grader … sent the request on to another address …, so it was stopped."**
The extension follows redirects only within the grader's address. If the grader really moved, put its new address in `cedtGrader.baseUrl` (user settings).

**The wrong problem is detected for my file.**
Click the problem name under **Current problem** and pick the right one; your choice is remembered and always wins. **✕** next to the problem (**Unlink this file** / **Don't match this file**) stops automatic matching for that file; **Auto-detect** tries again. **Rename file to match the problem** renames the file so it matches next time too.

**"This problem doesn't accept C++. Wrong problem?" (or another language)**
The grader allows only some languages per problem. Usually the file is linked to the wrong problem: click **Change** and pick the right one. Otherwise check the language dropdown above **Submit to Grader** and the file's extension (`.cpp`, `.c`, `.py`, …).

**Folder mode sends the wrong file.**
Pick the right file under **Submits**. Only that one file is sent.

**No internet / the grader is down.**
The banner at the top of the panel says what happened; press **Retry** when you're back online. What was already loaded stays visible ("may be out of date"). If a submission failed, the message says whether it reached the grader; check **History** before submitting again.

**Load samples found no cases, or wrong ones.**
It reads only ruled tables with selectable text. Copy the cases from the statement by hand, or delete the `sample<n>` files (or the CPH tests) it added.

**Where is my password stored?**
Only if **Remember password on this computer** is on: in your operating system's keychain through VS Code's SecretStorage. Never in settings, files or logs. **Log out** (or Clear Cached Data → Saved login) deletes it.

**Something else.**
*Output → CEDT Grader* shows errors. Turn on `cedtGrader.debugRequests` and run **CEDT Grader: Show Request Log** to see every request (no passwords or tokens).

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
