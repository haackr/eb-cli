# EB CLI Copilot Instructions

## Project Overview

This is an Oclif-based CLI tool for automating interactions with e-Builder, a construction management platform. It uses Puppeteer for headless browser automation to handle authentication and web interactions, storing session cookies in a local SQLite database.

## Architecture

- **Framework**: Oclif v4 with TypeScript
- **Build System**: TypeScript compilation to `./dist/`, source in `./src/`
- **Database**: SQLite (`eb.db`) via better-sqlite3 for session storage
- **Automation**: Puppeteer for browser-based operations
- **Package Manager**: pnpm

## Key Components

- `src/commands/`: Oclif commands organized by topics (e.g., `budgetitems/`, `users/`)
- `src/lib/db.ts`: SQLite database operations for sessions
- `src/lib/eb-puppetmaster/auth.ts`: Puppeteer-based authentication logic
- `bin/dev.js`: Development runner using ts-node
- `bin/run.js`: Production runner using compiled code

## Development Workflow

- **Run in development**: `pnpm run dev` (uses ts-node for direct TS execution)
- **Build**: `tsc` compiles `./src/` to `./dist/`
- **Test**: No tests configured yet (placeholder in package.json)
- **Install globally**: `npm install -g .` or `pnpm install -g .` after building

## Command Patterns

Commands extend `@oclif/core`'s `Command` class with static properties:

- `static override description`
- `static override examples`
- `static override flags` (using `Flags.boolean`, `Flags.string`, etc.)
- `static override args` (using `Args.string`, etc.)

Example from `src/commands/login.ts`:

```typescript
export default class Login extends Command {
  static override flags = {
    environment: Flags.string({
      options: ['us1', 'us2', 'us3', 'us4', 'gov', 'ca'],
    }),
  };
  public async run(): Promise<void> {
    const { flags } = await this.parse(Login);
    // Implementation
  }
}
```

## Authentication Pattern

- Use `eb.login()` from `src/lib/eb-puppetmaster/auth.ts` for headless login
- Store resulting cookies via `db.addSession()` in `src/lib/db.ts`
- Retrieve sessions with `db.getSessions()` or `db.getUserSessionsByUsername()`
- Environments defined in `eb.Environment` enum

## Database Operations

Use prepared statements for SQLite operations:

```typescript
const insertSession = db.prepare("INSERT INTO sessions (...) VALUES (?, ?, ?, ?)");
export function addSession(...) {
  insertSession.run(...);
}
```

## Puppeteer Usage

- Launch with `puppeteer.launch({ headless: !showBrowser })`
- Use shadow DOM selectors (e.g., `#element >>> #inner`) for e-Builder's UI
- Handle multi-account selection with inquirer prompts

## User Interaction

- Use `@inquirer/prompts` for interactive input (select, input, password)
- Use `ora` for progress spinners: `const spinner = ora("Message").start(); spinner.succeed("Done");`

## File Structure Conventions

- Commands in `src/commands/` with topic subdirectories
- Library code in `src/lib/`
- Bin scripts in `bin/` for dev/prod execution
- Compiled output goes to `dist/`

## Environment Handling

Support multiple e-Builder environments (us1, us2, us3, us4, gov, ca) with different base URLs.

## Current State

- Login command fully implemented with puppeteer automation
- Other commands (`budgetitems set/delete`, `users delete`) are stubs awaiting implementation
- No tests implemented yet
