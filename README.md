# CEDT Grader Submit

Submit the file you are editing to **CEDT Grader** ([cedt-grader.nattee.net](https://cedt-grader.nattee.net), a [cafe-grader-web](https://github.com/nattee/cafe-grader-web) server) and see the score and per-test verdicts inside VS Code. You don't need to open a browser.

It works alongside **Competitive Programming Helper (CPH)**: test locally with CPH, then submit with this extension.

## Install

1. Get the `.vsix` file (or build it: `npm install && npm run package`).
2. In VS Code, open the Extensions view, click **⋯ → Install from VSIX…**, and pick the file.

## Use it

Click the **CEDT Grader** icon in the Activity Bar. The sidebar has five sections:

| Section | What it does |
|---|---|
| **Account** | Log in with your grader username and password. Use **Log out** to end the session and forget the saved password. |
| **Current problem** | Follows the file you are editing. Pick its grader problem from the searchable list, choose a language (only languages this problem allows are shown), then press **Submit to Grader**. |
| **Result** | Shows live status while grading, then the score, a coloured tile per test (hover a tile for its verdict), the compiler message if compilation failed, a link to the submission, and **Resubmit**. |
| **History** | Shows your last submissions for this problem from VS Code. Click one to open it on the website. |
| **Problems** | Lists all your problems with your best score, with a filter box. Click a problem to use it for the current file. Click ↗ to open its statement. |

Typical flow: open `sol.cpp` → pick the problem once (it is remembered) → **Submit** → confirm. That's two clicks for every later submission.

The mapping is saved in `.cedt-grader.json` in your workspace folder, and also in VS Code's workspace storage. If CPH has a problem file for your source whose name or URL matches a grader problem, that problem is suggested automatically.

**Also available:**
- The status bar item (`☁ Submit to Grader`, the score after grading) opens the panel.
- The ☁ button in the editor title bar (C, C++, Python, Java files) submits the current file.
- Every action is a command (`CEDT Grader: …` in the Command Palette), so you can bind keyboard shortcuts: Log In, Log Out, Submit Current File, Choose Problem for This File, Show Last Result, Open Problem Statement.

## Settings

| Setting | Default | |
|---|---|---|
| `cedtGrader.baseUrl` | `https://cedt-grader.nattee.net` | Another cafe-grader server. User settings only. |
| `cedtGrader.username` | | Filled in when you log in from the panel. |
| `cedtGrader.pollIntervalSeconds` | `5` | How often to check while grading (minimum 3). Polling only runs after a submission and stops after 3 minutes. |
| `cedtGrader.confirmBeforeSubmit` | `true` | Ask before each submission. |
| `cedtGrader.allowContestSubmissions` | `false` | See below. User settings only. |

## Exams and contests

Exams on the grader run as **contests**. **The extension blocks submissions while a contest/exam is running.** It shows *"This problem is part of an active contest/exam. Submit through the website."* with a button to open the problem in your browser. If the extension cannot tell for sure whether a contest is running, it also blocks.

- During an exam the website sends regular "check-ins" that show you are present. VS Code never sends them, never imitates them and never pretends to be a browser. If you submit from VS Code during an exam, you may look absent, and the exam rules may forbid such tools anyway.
- In exam mode the grader also locks your account to one device. **Do not log in from VS Code during an exam:** it can lock your browser out ("You cannot login from two different places").
- `cedtGrader.allowContestSubmissions` exists for instructors who explicitly allow it. Even when it is on, you must confirm every single time that you have your instructor's permission. **Ask your instructor before using this extension in any exam.**

## Using it with CPH

- This extension only *reads* CPH's `.cph/*.prob` files to suggest a problem. It never changes how CPH runs or stores tests.
- Both extensions add a button to the editor title bar. CPH's runs your tests locally; ours (☁) submits to the grader.

## Privacy

- Your password is stored in the OS keychain through VS Code SecretStorage. It is never written to settings, files or logs, and the sidebar does not keep it after you press **Log in**.
- Session cookies are kept in memory only, and the extension logs only request paths and status codes (Output → *CEDT Grader*).
- The extension talks only to the configured grader server. It doesn't log in automatically when VS Code starts, and it only contacts the server when you act (log in, load problems, submit) and while a submission is being graded.

## Development

```bash
npm install
npm test          # vitest: parsers, contest detector, client (mocked fetch), webview (jsdom)
npm run build     # typecheck + esbuild → dist/extension.js, media/dist/*
npm run package   # .vsix
npx tsx scripts/probe.ts --help   # protocol probe; credentials from .env (see .env.example)
```

Press **F5** in VS Code to start an Extension Development Host.
