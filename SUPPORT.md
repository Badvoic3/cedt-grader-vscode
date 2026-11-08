# Grader Submit — Support

[**← Back to README**](README.md) · [**User Guide (`USERGUIDE.md`)**](USERGUIDE.md) · [**Developer Guide (`DEVGUIDE.md`)**](DEVGUIDE.md) · [**Changelog (`CHANGELOG.md`)**](CHANGELOG.md)

Need help with **Grader Submit**? Start with the resources below.

---

## 1. Check the User Guide & Troubleshooting First

Most common setup, login, matching, and local test runner questions are answered in:

- [**User Guide (`USERGUIDE.md`)**](USERGUIDE.md) — full walkthrough of the panel, Folder Mode, built-in test runner, Explorer badges, and settings.
- [**Troubleshooting (`USERGUIDE.md#troubleshooting`)**](USERGUIDE.md#troubleshooting) and [**Quick Troubleshooting (`README.md#troubleshooting`)**](README.md#troubleshooting) — fixes for login lockouts, server checks, problem matching, missing compilers, and PDF sample extraction.

---

## 2. Reporting a Bug or Crash

If something breaks or behaves unexpectedly, please open an issue on GitHub:

- **Crash Report Template:** [`.github/ISSUE_TEMPLATE/crash_report.yml`](.github/ISSUE_TEMPLATE/crash_report.yml) — [**Open a Crash Report on GitHub**](https://github.com/Badvoic3/cedt-grader-vscode/issues/new?template=crash_report.yml)
  - When an unhandled error happens inside the extension, the panel also shows a **Something went wrong in Grader Submit** card with a **Report on GitHub** button that prefills this template after stripping tokens, passwords, and personal file paths.
- **All Other Bugs & Feature Requests:** [**GitHub Issues (`Badvoic3/cedt-grader-vscode/issues`)**](https://github.com/Badvoic3/cedt-grader-vscode/issues/new/choose)

### Helpful Details to Include

1. **Extension version** (e.g. `1.1.0`) and **VS Code version** (*Help → About*).
2. **Operating system** (macOS, Windows, or Linux).
3. **Steps to reproduce** (for example: whether Folder Mode was on, which language/compiler was used, or what the panel showed).
4. **Request log (optional, for connection/server bugs):**
   - Enable `cedtGrader.debugRequests` in Settings, reproduce the issue, and run **Grader: Show Request Log** (`Grader Submit: Requests` output channel). Passwords and tokens are never written to this log.

---

## 3. Course, Account & Grading Questions

**Grader Submit** is an unofficial developer workflow tool and does not control the grading server, problem statements, test cases, or course scores.

For any of the following, please contact your **course instructor or teaching assistants**:

- Account creation, password resets, or `"The grader refused the login."`
- Missing problems, locked exam pages, or contest rules
- Questions about a problem statement, official test cases, or how your final course grade is calculated
