# EB CLI Copilot Instructions

## Project Overview

This Oclif v4 CLI automates e-Builder administration with Puppeteer. It persists authenticated browser cookies locally so commands can reuse, validate, and refresh e-Builder sessions.

## Build, Lint, and Test

- Use Node `22.14.0` and npm (the checked-in lockfile is `package-lock.json`).
- `npm run build` compiles `src/` to `dist/`.
- `npm run lint` runs ESLint on all TypeScript under `src/`; target one file with `npx eslint src/commands/login.ts`.
- `npm run format:check` checks formatting; `npm run format` writes formatting.
- Run source commands with `npm run dev -- <command>`, for example `npm run dev -- session list`. The production runner (`bin/run.js`) executes compiled commands from `dist/`.
- No test runner or test files are configured. `npm test` intentionally exits with an error, so there is no full-suite or single-test command.

## Architecture

- Oclif discovers commands from the filesystem: `src/commands/<topic>/<command>.ts` becomes `eb <topic> <command>` after compilation. Commands define Oclif metadata and parse arguments/flags in `run()`.
- Browser-facing behavior lives in `src/lib/eb-puppetmaster/`. Its `index.ts` is the public barrel and centralizes e-Builder environment conversion (`us1` through `ca` <-> host subdomains). Command code should call its exported operations rather than construct URLs or duplicate environment maps.
- `BrowserManager` owns the process-wide Puppeteer instance, browser mode, lifecycle handlers, and Chrome bootstrap. Reuse it for a command and close it when work completes.
- `src/lib/db.ts` stores `SessionRow` records in `~/.eb-cli/eb.db`, not in the repository. Session cookies are serialized JSON and must be read/updated through the database helpers.
- `BaseSessionCommand` connects session selection, login fallback, cookie validation, and refresh. Browser-backed commands should extend it, resolve the session with `getSession(flags)`, and fetch cookies with `getSessionCookies(session.id, headless)`.

## TypeScript and Command Conventions

- The TypeScript configuration is strict, uses `module: nodenext`, and enables `verbatimModuleSyntax`. Use `.js` suffixes in relative TypeScript imports and use `import type` for type-only imports.
- Oclif classes use `static override` metadata. Session-backed commands spread `BaseSessionCommand.baseFlags`; commands supporting machine output set `static override enableJsonFlag = true` and avoid human-oriented progress output when `this.jsonEnabled()`.
- CSV commands parse headers with Papa Parse (`header: true`, `skipEmptyLines: true`), reject parsing errors, and validate that useful operations remain before starting a browser.

## Browser and Batch-Operation Conventions

- Pass `!flags['show-browser']` as the headless setting and reuse one `BrowserManager` browser across a batch. Puppeteer selectors may cross e-Builder shadow DOM with `>>>`.
- Authenticate via `promptLoginAndSaveSession`/`eb.login`; validate or refresh stored cookies before operations. Long-running batch commands refresh cookies every ten items.
- Batch commands support `--dry-run`, `--verbose`, optional result CSVs, and `--json`. Preserve this contract: collect per-item success/failure results, keep partial output on `SIGINT`/`SIGTERM`, suppress spinners/progress for JSON, and always close the browser on completion or failure.
- Implement low-level automation functions in `eb-puppetmaster` with typed option/result objects. They receive an environment, cookies, and an optional shared browser; commands own CSV parsing, progress, result aggregation, and presentation.
- Browser launch retries after installing Chrome. On Linux, system dependencies are installed automatically only as root or when `EB_PUPPETEER_INSTALL_DEPS=1`; otherwise users must install missing Chrome libraries themselves.

## Release Integration

Publishing a GitHub release runs `.github/workflows/release.yml`: it builds the Oclif manifest, packs platform tarballs and native installers, uploads update artifacts to S3, and promotes the version-derived update channel. Keep the package Oclif configuration and `src/hooks/preparse/default-update-channel.ts` aligned with any update-channel changes.
