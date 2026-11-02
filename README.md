# CEDT Grader Submit

Submit the file you are editing to **CEDT Grader** ([cedt-grader.nattee.net](https://cedt-grader.nattee.net), a [cafe-grader-web](https://github.com/nattee/cafe-grader-web) server) and see your score, per-test verdicts, submission history and the problem statement inside VS Code, without opening a browser.

It works on its own. If you also use Competitive Programming Helper, see [Works with CPH](#works-with-cph).

## Install

1. Get the `.vsix` file (or build it: `npm install && npm run package`).
2. In VS Code, open the Extensions view, click **⋯ → Install from VSIX…**, and pick the file.

## Use it

Click the **CEDT Grader** icon in the Activity Bar. The sidebar has five sections:

| Section | What it does |
|---|---|
| **Account** | Log in with your grader username and password. Keep **Remember password on this computer** on to stay logged in (stored in the macOS Keychain / OS keychain). **Log out** forgets both the login and the password. |
| **Current problem** | Follows the file you are editing. Pick its grader problem from the searchable list (name or id), see your **counted score**, choose a language (only languages this problem allows are shown), then press **Submit to Grader**. |
| **Result** | Shows live status while grading, then the points, a coloured tile per test as on the website (hover a tile or a box for details; **?** explains the colours), the compiler message if compilation failed, whether your counted score improved, a link to the submission, and **Resubmit**. |
| **History** | Every submission for this problem (website ones too), with time, language, score and verdicts; the one that counts is marked. Click one for per-test results, runtime, memory and the compiler message, to **open that version** in a new editor, or to **compare it with your current file**. |
| **Problems** | Lists all your problems with their counted score. Filter by status (All / Unsolved / In progress / Solved, like the website), by topic, or by name/id. Click a problem to use it for the current file. Click the book icon to read its statement. |

Typical flow: open `sol.cpp` → pick the problem once (it is remembered) → **Submit** → confirm. That's two clicks for every later submission.

**Linking files to problems.** A file is linked automatically when its name matches a problem name (`00_Intro_11.cpp` → `00_Intro_11`; case, spaces, `-`, `_` and `.` don't matter). Otherwise the closest problem is suggested: it is highlighted with a **Confirm** button, and submitting asks first. Your own choice always wins and is saved in `.cedt-grader.json` and VS Code's workspace storage. A small icon next to the problem name tells you how it was chosen (hover it); **Change** picks another one.

Handy actions in the problem list and picker: **copy the exact problem name**, **new file for this problem** (creates `<name>.cpp` next to your file), **go to the file** linked to a problem (or find one by name).

Renaming or moving a linked file in VS Code keeps the link. If you move files in Finder or git, the extension asks whether to keep the old link when you open the file.

**Test cases.** For problems that provide them, **Load test cases** downloads the grader's test cases (large cases the grader only shows in part are skipped). Without CPH they can be saved as files: `<problem name>/tests/1.in`, `1.out`, … next to your source (the extension asks before creating the folder and never overwrites your files). With CPH installed they go into CPH instead (see below).

**Also available:**
- The status bar item (`☁ Submit to Grader`, the score after grading) opens the panel.
- The ☁ button in the editor title bar (C, C++, Python, Java files) submits the current file.
- Every action is a command (`CEDT Grader: …` in the Command Palette), so you can bind keyboard shortcuts: Log In, Log Out, Submit Current File, Choose Problem for This File, Show Last Result, Open Problem Statement.

## Problem statements

Click the book icon next to the problem to open its statement in a tab beside your code (pinch or Cmd/Ctrl +/- to zoom, Cmd/Ctrl 0 to fit width, page navigation, search with Cmd/Ctrl+F). The tab remembers its page and zoom and reopens after a restart. Statements are downloaded once and kept in VS Code's own storage (never in your project); the viewer's Refresh button downloads them again. Problems without a PDF show their text description. Set `cedtGrader.statementBeside` to `false` to open statements in the current editor group.

## When the connection fails

A banner at the top of the sidebar says what went wrong (no internet, server error, session expired, too many attempts, timeout) and offers **Retry**. Your last loaded data stays visible, marked "may be out of date". If a submission was already sent, its result loads once the connection is back.

## Scores

The panel shows the score the grader **counts**: your best submission, not your latest. Hint and AI-assist penalties are taken off (e.g. "-10 AI assist"), as on the website's problem list. If your latest submission scored lower, the panel says so ("Latest: 40 — your best 70 still counts").

The extension only mirrors what the grader shows. **Your instructor's final grading may differ.**

## Staying logged in

With **Remember password on this computer** on, your password is kept in the OS keychain (macOS Keychain), and the extension logs in again by itself when the 12-hour grader login expires. The password field accepts paste and password-manager autofill.

## Settings

| Setting | Default | |
|---|---|---|
| `cedtGrader.baseUrl` | `https://cedt-grader.nattee.net` | Another cafe-grader server. User settings only. |
| `cedtGrader.username` | | Filled in when you log in from the panel. |
| `cedtGrader.pollIntervalSeconds` | `5` | How often to check while grading (minimum 3). Polling only runs after a submission and stops after 3 minutes. |
| `cedtGrader.confirmBeforeSubmit` | `true` | Ask before each submission. |
| `cedtGrader.statementBeside` | `true` | Open statements beside your code. |
| `cedtGrader.defaultLanguage` | `C++` | Language for **New file for this problem** when your current file's language isn't allowed. |
| `cedtGrader.debugRequests` | `false` | Log each grader request and cache hit/miss to *Output → CEDT Grader: Requests* (no passwords or tokens). |

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
- The extension talks only to the configured grader server. It doesn't log in automatically when VS Code starts, and it only contacts the server when you act (log in, load problems, submit) and while a submission is being graded.

## Development

```bash
npm install
npm test          # vitest: grader client (fake API), scores, parsers, webview (jsdom)
npm run build     # typecheck + esbuild → dist/extension.js, media/dist/*
npm run package   # .vsix
npx tsx scripts/probe.ts --help   # protocol probe; credentials from .env (see .env.example)
```

Press **F5** in VS Code to start an Extension Development Host.
