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
| **Account** | Log in with your grader username and password. Keep **Remember password on this computer** on to stay logged in (stored in the macOS Keychain / OS keychain). **Log out** forgets both the login and the password. |
| **Current problem** | Follows the file you are editing. Pick its grader problem from the searchable list (name or id), see your **counted score**, choose a language (only languages this problem allows are shown), then press **Submit to Grader**. |
| **Result** | Shows live status while grading, then the points, a coloured tile per test (hover a tile for its verdict), the compiler message if compilation failed, whether your counted score improved, a link to the submission, and **Resubmit**. |
| **History** | Every submission for this problem (website ones too), with time, language, score and verdicts; the one that counts is marked. Click one for per-test results, runtime, memory and the compiler message, to **open that version** in a new editor, or to **compare it with your current file**. |
| **Problems** | Lists all your problems with their counted score, with a filter box. Click a problem to use it for the current file. Click ↗ to open its statement. |

Typical flow: open `sol.cpp` → pick the problem once (it is remembered) → **Submit** → confirm. That's two clicks for every later submission.

The mapping is saved in `.cedt-grader.json` in your workspace folder, and also in VS Code's workspace storage. If CPH has a problem file for your source whose name or URL matches a grader problem, that problem is suggested automatically.

**Also available:**
- The status bar item (`☁ Submit to Grader`, the score after grading) opens the panel.
- The ☁ button in the editor title bar (C, C++, Python, Java files) submits the current file.
- Every action is a command (`CEDT Grader: …` in the Command Palette), so you can bind keyboard shortcuts: Log In, Log Out, Submit Current File, Choose Problem for This File, Show Last Result, Open Problem Statement.

## Scores

The panel shows the score the grader **counts**: your best submission, not your latest. Hint and AI-assist penalties are taken off (e.g. "-10 AI assist"), as on the website's problem list. If your latest submission scored lower, the panel says so ("Latest: 40 — your best 70 still counts").

The extension only mirrors what the grader shows. **Your instructor's final grading may differ.**

## Logging in with Apple Passwords

The Passwords app can't fill VS Code directly. Copy your password from the Passwords app once and paste it into the login form. With **Remember password on this computer** on, it is kept in your Keychain, and the extension logs in again by itself when the 12-hour grader login expires.

## Settings

| Setting | Default | |
|---|---|---|
| `cedtGrader.baseUrl` | `https://cedt-grader.nattee.net` | Another cafe-grader server. User settings only. |
| `cedtGrader.username` | | Filled in when you log in from the panel. |
| `cedtGrader.pollIntervalSeconds` | `5` | How often to check while grading (minimum 3). Polling only runs after a submission and stops after 3 minutes. |
| `cedtGrader.confirmBeforeSubmit` | `true` | Ask before each submission. |
| `cedtGrader.debugRequests` | `false` | Log each grader request and cache hit/miss to *Output → CEDT Grader: Requests* (no passwords or tokens). |

## Exams

This is an unofficial homework tool. If a problem looks like part of an exam, the extension warns you before submitting. Ask your instructor before using it in any exam.

## Using it with CPH

- This extension only *reads* CPH's `.cph/*.prob` files to suggest a problem. It never changes how CPH runs or stores tests.
- Both extensions add a button to the editor title bar. CPH's runs your tests locally; ours (☁) submits to the grader.

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
