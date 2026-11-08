# Grader Submit — Developer Guide

**English** · [ภาษาไทย](DEVGUIDE.th.md)

[**← Back to README**](README.md) · [**User Guide (`USERGUIDE.md`)**](USERGUIDE.md) · [**Support (`SUPPORT.md`)**](SUPPORT.md) · [**Changelog (`CHANGELOG.md`)**](CHANGELOG.md)

This guide explains how **Grader Submit** is structured, how to build, test, and package the extension locally, and how to extend its grader provider or local test runner.

---

## 1. Prerequisites & Quick Commands

- **Node.js:** 20 or newer
- **VS Code:** `1.106.0` or newer (for running the Extension Development Host)

```bash
npm install          # install dependencies
npm run build        # type-check (tsc --noEmit) + bundle host and webviews (esbuild.mjs)
npm test             # run the Vitest test suite
npm run typecheck    # run tsc --noEmit on src/, webview/, and test/
npm run check        # full gate: npm run build && npm test
npm run package      # build a clean production .vsix (cedt-grader-submit-<version>.vsix)
npx vsce ls          # inspect the exact files included in the .vsix package
```

Press <kbd>F5</kbd> in VS Code to launch the **Extension Development Host**.

---

## 2. Architecture Overview

Grader Submit runs across two environments connected by typed `postMessage` channels (`src/shared/messages.ts`):

1. **Extension Host (Node.js, `src/` → `dist/extension.js`):**
   - Owns all state, network requests, credential storage (`vscode.SecretStorage`), disk caches (`context.globalStorageUri`), file watching, and local test execution.
   - Pushes complete, immutable `ViewState` (sidebar) and `ToTests` (Test split view) snapshots to the webviews.
2. **Webviews (Browser DOM, `webview/` → `media/dist/*.js`):**
   - **Sidebar (`webview/main.ts`)**, **Test Split View (`webview/tests.ts`)**, **PDF Statement Viewer (`webview/statement.ts`)**, and **Break Tab (`webview/break.ts`)**.
   - Render state with plain DOM helpers (`webview/dom.ts`), `textContent`, and strict Content Security Policy (`default-src 'none'`, nonce-gated scripts, no inline styles). Webviews never contact the network directly.

### Repository Layout

| Path | Responsibility |
|---|---|
| `src/extension.ts` | Entry point (`activate`), command registration, webview/serializer registration. |
| `src/controller.ts` | Central coordinator (`GraderController`) wiring state, events, and flow modules. |
| `src/flows/` | Focused workflow modules: `submit.ts`, `links.ts`, `folderMode.ts`, `attachments.ts`, `runner.ts`, `cache.ts`, `explorerBadges.ts`, `breakReminder.ts`, `serverCheck.ts`, `panelReveal.ts`, `prompts.ts`. |
| `src/grader/` | `GraderProvider` interface (`provider.ts`), scoring (`score.ts`), language mapping (`languages.ts`), redaction (`redact.ts`), and the `cafe-grader-web` implementation (`providers/cafeGrader/`). |
| `src/runner/` | Pure, `vscode`-free local test runner: language/compiler detection (`languages.ts`), content-hash build cache (`compile.ts`), process-group execution (`execute.ts`), stdout comparison (`compare.ts`), bounded line/token diff (`diff.ts`), and case store (`store.ts`). |
| `src/data/` | `DataService` (request deduplication, TTL, visibility gating), `statementStore.ts`, `testcaseStore.ts`, and `pdfSamples.ts` (PDF table extractor). |
| `src/mapping/` | Problem-to-file matcher (`match.ts`), workspace source index (`findByName.ts`), hidden link store (`store.ts`), and folder-role detector (`folderRoles.ts`). |
| `src/migration/` | One-time `v1.0.x` importer and recoverable cleanup (`importLinks.ts`, `oldFiles.ts`, `cph.ts`). |
| `src/ui/` | Webview providers and panels (`sidebarProvider.ts`, `testPanel.ts`, `statementPanel.ts`, `breakPanel.ts`, `statusBar.ts`, `compareDocs.ts`). |
| `src/shared/` | Shared constants (`constants.ts`), typed messages (`messages.ts`), English & Thai string tables (`strings.ts`, `strings.th.ts`, `i18n.ts`), and state keys (`stateKeys.ts`). |
| `webview/` | Browser bundles (`main.ts`, `tests.ts`, `statement.ts`, `break.ts`, `breakScenes.ts`, `style.css`, `tests.css`). |
| `test/` | Vitest test suites (`*.test.ts`). Tests use local fakes only and never contact a live grader. |

---

## 3. Core Design Boundaries

### `GraderProvider` Boundary (`src/grader/provider.ts`)

`GraderController`, `DataService`, and all `src/flows/*` depend strictly on the `GraderProvider` interface and `GraderCapabilities` (`{ testcases, pdfStatement, attachments, penaltyHtml, rawSumScores }`). All `cafe-grader-web` specifics (Rails `/api/v1` JWT endpoints, `/main/list` HTML scraping, CSRF handling, and verdict string parsing) live inside `src/grader/providers/cafeGrader/`. Adding another grading backend requires only a new provider folder under `src/grader/providers/`.

### `vscode`-Free Runner Core (`src/runner/`)

Every module under `src/runner/` is prohibited from importing `vscode` (enforced by `test/providerBoundary.test.ts`):

- **Compilation (`src/runner/compile.ts`):** Hashes the run file, its local `#include` headers, compiler command, and flags into `<os.tmpdir()>/cedt-grader-bin/<hash>/` (with automatic fallback to `<globalStorageUri>/bin/` if `/tmp` is mounted `noexec`).
- **Execution (`src/runner/execute.ts`):** Spawns child processes in their own process group (`detached: true` on POSIX, `taskkill /T /F` on Windows) with `shell: false`, enforces time limits + grace window and output caps (`64 KB` display cap, `max(64 KB, 2 × expected)` compare cap), and samples peak memory (`VmHWM` on Linux, `/usr/bin/time -l` on macOS).

### Centralization Rules (Enforced by Tests)

- **Tunables (`src/shared/constants.ts`):** Timeouts, cache caps, runner limits, and URLs live in `src/shared/constants.ts`.
- **User-facing strings (`src/shared/strings.ts` & `src/shared/strings.th.ts`):** All UI labels, tooltips, notifications, and error messages live in the string tables (`test/i18n.test.ts` checks that every key is translated, all placeholders match, and no unused keys remain).
- **State keys (`src/shared/stateKeys.ts`):** All `globalState` and `workspaceState` keys are registered in `KEYS` (`test/stateKeys.test.ts`).

---

## 4. Security & Server Discipline

- **Never contact a live grader in tests:** All unit and integration tests use fake HTTP servers or mock providers.
- **Origin-locked redirects (`src/grader/http.ts`):** HTTP redirects are followed manually with `redirect: 'manual'` and refused if the target origin differs from `cedtGrader.baseUrl`.
- **Credential isolation:** `cedtGrader.baseUrl` is `application`-scoped (User Settings only) so a workspace `.vscode/settings.json` cannot redirect credentials. Passwords and tokens live only in `vscode.SecretStorage`.
- **Redaction (`src/grader/redact.ts`):** Crash reports and logs strip tokens, cookies, passwords, usernames, and home-directory paths before display.

---

## 5. Third-Party Notices

Grader Submit bundles the following open-source runtime libraries (see `package.json` and `LICENSE`):

| Package | License | Role in Grader Submit |
|---|---|---|
| [`cheerio`](https://github.com/cheeriojs/cheerio) | MIT | Parsing `/main/list` HTML for topic tags, penalties, and raw-sum flags. |
| [`fflate`](https://github.com/101arrowz/fflate) | MIT | Inspecting and extracting problem zip attachments with streaming size caps. |
| [`markdown-it`](https://github.com/markdown-it/markdown-it) | MIT | Rendering Markdown problem statements when a problem has no PDF. |
| [`pdfjs-dist`](https://github.com/mozilla/pdf.js) | Apache-2.0 | Rendering PDF problem statements and extracting example input/output tables. |
| [`tough-cookie`](https://github.com/salesforce/tough-cookie) | BSD-3-Clause | In-memory cookie jar for web session requests. |
| [`vscode-textmate`](https://github.com/microsoft/vscode-textmate) | MIT | Tokenizing open source files for syntax-coloured break scenes. |
| [`vscode-oniguruma`](https://github.com/microsoft/vscode-oniguruma) | MIT | WebAssembly regular-expression engine used by `vscode-textmate` (`dist/onig.wasm`). |
| [`@vscode/codicons`](https://github.com/microsoft/vscode-codicons) | MIT / CC-BY-4.0 | Icon font subset bundled in `media/dist/`. |

The `swarm` break scene (`webview/breakScenes.ts`) uses our own 2D grid-fluid implementation (semi-Lagrangian advection, pressure projection, and vorticity confinement).

---

## 6. Contributing

1. Create a branch from `main` and make your changes in focused commits.
2. Add or update unit tests in `test/*.test.ts` (including `vi.mock('vscode')` tests for host/UI wiring).
3. If you add or change user-facing text, update both `src/shared/strings.ts` and `src/shared/strings.th.ts` (and `package.nls.json` / `package.nls.th.json` for manifest strings).
4. Run `npm run check` (`npm run build && npm test`) and verify that all tests and type checks pass before opening a pull request.
