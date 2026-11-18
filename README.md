# eb-cli

[![CI](https://github.com/haackr/eb-cli/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/haackr/eb-cli/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/haackr/eb-cli?include_prereleases&sort=semver)](https://github.com/haackr/eb-cli/releases)

`eb` is a command-line tool for automating e-Builder: bulk user and budget item changes from CSV, process workflows, reports, project settings, and API log exports. It also runs as an MCP server, so AI agents can use the same automation.

## Install

Download the installer for your platform from the [latest release](https://github.com/haackr/eb-cli/releases/latest):

| Platform              | Installer                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------- |
| macOS (Apple Silicon) | [`eb-macos-arm64.pkg`](https://github.com/haackr/eb-cli/releases/latest/download/eb-macos-arm64.pkg)     |
| macOS (Intel)         | [`eb-macos-x64.pkg`](https://github.com/haackr/eb-cli/releases/latest/download/eb-macos-x64.pkg)         |
| Windows (x64)         | [`eb-windows-x64.exe`](https://github.com/haackr/eb-cli/releases/latest/download/eb-windows-x64.exe)     |
| Windows (ARM64)       | [`eb-windows-arm64.exe`](https://github.com/haackr/eb-cli/releases/latest/download/eb-windows-arm64.exe) |
| Debian / Ubuntu (x64) | [`eb-linux-amd64.deb`](https://github.com/haackr/eb-cli/releases/latest/download/eb-linux-amd64.deb)     |

On other Linux systems, use the install script. It installs to `~/.local/lib/eb` and links `eb` into `~/.local/bin`:

```sh
curl -fsSL https://eb-cli-updates-934677684919-us-east-2-an.s3.us-east-2.amazonaws.com/install.sh | bash
```

After that, `eb update` keeps the CLI current. It follows the channel your installer was built for (`stable`, `beta`, or `alpha`).

### Linux browser dependencies

Browser-backed commands use a headless Chrome. On Linux, the CLI downloads Chrome the first time it needs it. It installs Chrome's system packages itself only when running as `root` or when `EB_PUPPETEER_INSTALL_DEPS=1` is set. In restricted cloud terminals, leave that variable unset and install any missing Chrome libraries manually if the browser fails to launch.

## Getting started

```sh
eb login                # sign in through a browser window; the session is saved
eb session list         # show saved sessions
eb reports list         # run a command against your session
eb <command> --help     # see flags and examples for any command
```

Most commands that change data accept `--dry-run`, and many accept `--json` for scripting. When you have more than one saved session, choose one with `--session-id` or `--username`.

## AI agents

- `eb mcp` starts an MCP stdio server that exposes eb's automation tools to MCP clients.
- `eb agent guide` prints system-prompt instructions and e-Builder recipes for agents that drive the CLI directly.

## Commands

<!-- commands -->

- [`eb agent guide`](#eb-agent-guide)
- [`eb apilogs download`](#eb-apilogs-download)
- [`eb budgetitems delete FILE`](#eb-budgetitems-delete-file)
- [`eb budgetitems set FILE`](#eb-budgetitems-set-file)
- [`eb daemon start`](#eb-daemon-start)
- [`eb daemon status`](#eb-daemon-status)
- [`eb daemon stop`](#eb-daemon-stop)
- [`eb login`](#eb-login)
- [`eb logout`](#eb-logout)
- [`eb mcp`](#eb-mcp)
- [`eb process accept INSTANCE`](#eb-process-accept-instance)
- [`eb process action INSTANCE`](#eb-process-action-instance)
- [`eb process inspect PROCESS`](#eb-process-inspect-process)
- [`eb process instances`](#eb-process-instances)
- [`eb process set INSTANCE`](#eb-process-set-instance)
- [`eb process setnullfield FILE`](#eb-process-setnullfield-file)
- [`eb process start PROCESS`](#eb-process-start-process)
- [`eb process startable`](#eb-process-startable)
- [`eb process submit INSTANCE`](#eb-process-submit-instance)
- [`eb process view INSTANCE`](#eb-process-view-instance)
- [`eb project settings get PROJECT`](#eb-project-settings-get-project)
- [`eb project settings set [PROJECT]`](#eb-project-settings-set-project)
- [`eb reports copy`](#eb-reports-copy)
- [`eb reports export-config REPORT`](#eb-reports-export-config-report)
- [`eb reports import-config FILE`](#eb-reports-import-config-file)
- [`eb reports list`](#eb-reports-list)
- [`eb reports run REPORT`](#eb-reports-run-report)
- [`eb session exec [URL]`](#eb-session-exec-url)
- [`eb session import`](#eb-session-import)
- [`eb session list`](#eb-session-list)
- [`eb session test`](#eb-session-test)
- [`eb update [CHANNEL]`](#eb-update-channel)
- [`eb users delete FILE`](#eb-users-delete-file)
- [`eb users remove-project FILE`](#eb-users-remove-project-file)
- [`eb users remove-project-role FILE`](#eb-users-remove-project-role-file)
- [`eb users setfield FILE`](#eb-users-setfield-file)
- [`eb users setsso FILE`](#eb-users-setsso-file)
- [`eb users sso-report`](#eb-users-sso-report)

## `eb agent guide`

output system prompt instructions, DOM helper API, and e-Builder execution recipes for AI agents

```
USAGE
  $ eb agent guide [--json] [--markdown]

FLAGS
  --markdown  output guide as formatted Markdown

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  output system prompt instructions, DOM helper API, and e-Builder execution recipes for AI agents

ALIASES
  $ eb agent-guide

EXAMPLES
  $ eb agent guide

  $ eb agent guide --json
```

## `eb apilogs download`

Download e-Builder API logs to JSONL

```
USAGE
  $ eb apilogs download [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-p <value>] [-o <value>] [--overwrite]
    [--from-date <value>] [--to-date <value>]

FLAGS
  -A, --account=<value>      Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                             Production")
  -i, --session-id=<value>   Session ID to use
  -o, --output-file=<value>  [default: ./api-logs-<timestamp>.jsonl] Path to output JSONL file (one log record per line)
  -p, --pages=<value>        [default: 10] Number of pages to download from the API logs table
  -s, --show-browser         Show browser window
  -u, --username=<value>     Username to use session for
      --from-date=<value>    Start date for API logs (format: MM/DD/YYYY or YYYY-MM-DD; defaults to 30 days ago)
      --overwrite            Overwrite output file if it already exists
      --to-date=<value>      End date for API logs (format: MM/DD/YYYY or YYYY-MM-DD; defaults to today)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Download e-Builder API logs to JSONL

  Download API logs from e-Builder, including modal details, across paginated pages

EXAMPLES
  $ eb apilogs download --session-id 1

  $ eb apilogs download --from-date 2026-08-01 --to-date 2026-08-31

  $ eb apilogs download --username myuser --pages 10 --output-file ./api-logs.jsonl
```

## `eb budgetitems delete FILE`

Delete budget items from a CSV

```
USAGE
  $ eb budgetitems delete FILE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [--dry-run] [-v] [-o <value>]

ARGUMENTS
  FILE  CSV file containing budget item IDs or project names and account codes to delete

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -i, --session-id=<value>  Session ID to use
  -o, --output-csv=<value>  Write operation results to a CSV file at this path
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
  -v, --verbose             Show detailed progress for each item instead of overall progress bar
      --dry-run             Dry run (no actual deletion)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Delete budget items from a CSV

  Delete budget items from a CSV file (supports item IDs or project names and account codes)

EXAMPLES
  $ eb budgetitems delete items.csv --session-id 1

  $ eb budgetitems delete items.csv --username myuser
```

## `eb budgetitems set FILE`

Set budget item properties from a CSV

```
USAGE
  $ eb budgetitems set FILE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [--dry-run] [-v] [-o <value>]

ARGUMENTS
  FILE  CSV file containing budget item properties (supports item IDs or project names and account codes)

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -i, --session-id=<value>  Session ID to use
  -o, --output-csv=<value>  Write operation results to a CSV file at this path
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
  -v, --verbose             Show detailed progress for each item instead of overall progress bar
      --dry-run             Dry run (no actual changes)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Set budget item properties from a CSV

  Set properties for budget items from a CSV file (supports item IDs or project names and account codes)

EXAMPLES
  $ eb budgetitems set items.csv --session-id 1

  $ eb budgetitems set items.csv --username myuser
```

## `eb daemon start`

Start a warm headless browser shared by eb commands

```
USAGE
  $ eb daemon start [--json] [--idle-minutes <value>]

FLAGS
  --idle-minutes=<value>  [default: 15] Shut down after this many minutes without activity

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Start a warm headless browser shared by eb commands

  Starts a detached headless Chromium that `eb session exec`, `eb session test`, page inspection, and
  report/process-schema commands reuse instead of launching a browser per invocation. Every command still runs in its
  own isolated browser context. The daemon exits after the idle timeout. Set EB_BROWSER_DAEMON=auto to start it
  automatically, or EB_BROWSER_DAEMON=off to never use it.

EXAMPLES
  $ eb daemon start

  $ eb daemon start --idle-minutes 60 --json
```

## `eb daemon status`

Show whether the warm headless browser daemon is running

```
USAGE
  $ eb daemon status [--json]

GLOBAL FLAGS
  --json  Format output as json.

EXAMPLES
  $ eb daemon status --json
```

## `eb daemon stop`

Stop the warm headless browser daemon

```
USAGE
  $ eb daemon stop [--json]

GLOBAL FLAGS
  --json  Format output as json.

EXAMPLES
  $ eb daemon stop
```

## `eb login`

log in to e-Builder

```
USAGE
  $ eb login [-b] [-s] [-u <value>] [-p <value>] [-a <value>] [-e us1|us2|us3|us4|gov|ca] [--sso-url
    <value>] [--provider 1password|bitwarden|keychain|env] [--item <value>] [--vault <value>]

FLAGS
  -a, --account=<value>       account (if the user has access to multiple accounts)
  -b, --[no-]browser          sign in yourself in a browser window (default when no password or --provider is given);
                              --no-browser prompts for username/password in the terminal instead
  -e, --environment=<option>  environment
                              <options: us1|us2|us3|us4|gov|ca>
  -p, --password=<value>      password
  -s, --show_browser          automated login only: show the browser window (useful for debugging)
  -u, --username=<value>      username
      --item=<value>          Item name, title, or reference in the credential manager (default: "e-Builder")
      --provider=<option>     Credential manager provider (1password, bitwarden, keychain, env)
                              <options: 1password|bitwarden|keychain|env>
      --sso-url=<value>       SSO entry URL; opens a browser for interactive provider authentication
      --vault=<value>         1Password vault name or ID

DESCRIPTION
  log in to e-Builder

  With no password or credential provider, eb opens a browser window: sign in the way you normally do (password,
  passkey, MFA, SSO) and the session is saved as soon as e-Builder loads. With --provider (or --password), eb signs in
  for you headlessly. The username and account are detected from e-Builder either way.

ALIASES
  $ eb session create

EXAMPLES
  $ eb login # sign in yourself in a browser window

  $ eb login --environment us2

  $ eb login --provider 1password --item "e-Builder" # automated

  $ eb login --no-browser # type username/password in the terminal

  $ eb login --sso-url https://idp.example.com/ebuilder
```

## `eb logout`

log out of e-Builder sessions

```
USAGE
  $ eb logout [-s] [-u <value>] [-a <value>] [-A] [-i <value>]

FLAGS
  -A, --all                 logout from all sessions
  -a, --account=<value>     account (if the user has access to multiple accounts)
  -i, --session_id=<value>  session ID to logout from
  -s, --show_browser        show browser window (useful for debugging; default is headless)
  -u, --username=<value>    username

DESCRIPTION
  log out of e-Builder sessions

ALIASES
  $ eb session delete

EXAMPLES
  $ eb logout

  $ eb logout --session-id 1

  $ eb logout --username john.doe

  $ eb logout --all
```

## `eb mcp`

Start an MCP (Model Context Protocol) stdio server exposing e-Builder automation tools to AI agents

```
USAGE
  $ eb mcp

DESCRIPTION
  Start an MCP (Model Context Protocol) stdio server exposing e-Builder automation tools to AI agents

EXAMPLES
  $ eb mcp
```

## `eb process accept INSTANCE`

Accept ownership of an instance's current step (take responsibility for it)

```
USAGE
  $ eb process accept INSTANCE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-P <value>]

ARGUMENTS
  INSTANCE  InstanceID GUID, or instance name with --project

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -P, --project=<value>     Project name (case-insensitive, unique partial match) or PortalID GUID
  -i, --session-id=<value>  Session ID to use
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for

GLOBAL FLAGS
  --json  Format output as json.

EXAMPLES
  $ eb process accept "MPA - 2" -P "RH - eB-CLI Test project" --json
```

## `eb process action INSTANCE`

Take a workflow action on a process instance (e.g. Approve, Revise, Close)

```
USAGE
  $ eb process action INSTANCE -a <value> [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-P <value>] [-c
    <value>] [--private] [-F <value>...] [--fields <value>] [--accept-ownership]

ARGUMENTS
  INSTANCE  InstanceID GUID, or instance name with --project

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -F, --field=<value>...    Field to set as "Label=value" (repeatable). Label match is case-insensitive; a DataFieldID
                            GUID also works. Use "a; b" for multi-value fields and an empty value to clear.
  -P, --project=<value>     Project name (case-insensitive, unique partial match) or PortalID GUID
  -a, --action=<value>      (required) Action name (case-insensitive) or action ID
  -c, --comment=<value>     Comment to record with the action
  -i, --session-id=<value>  Session ID to use
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
      --accept-ownership    Accept ownership of the step first when setting fields
      --fields=<value>      Fields as a JSON object ({"Label": "value"}) or @path/to/file.json
      --private             Mark the comment private

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Take a workflow action on a process instance (e.g. Approve, Revise, Close)

  Optionally sets fields first, then takes the action and completes e-Builder's comment step. Actions that require a
  comment fail with a clear error unless --comment is given. Use `eb process view` to list the actions available to you.

EXAMPLES
  $ eb process action 8ededb4a-a8a2-46db-bdb7-707c88a1ddd7 --action Close --json

  $ eb process action "MPA - 2" -P "RH - eB-CLI Test project" --action Revise --comment "Please add the drawing number" --json
```

## `eb process inspect PROCESS`

inspect and project compact, token-efficient schema of an e-Builder process (fields, workflow, layout matrix)

```
USAGE
  $ eb process inspect PROCESS [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [--cached] [--refresh] [--compact
    | -m] [-o <value>]

ARGUMENTS
  PROCESS  Name of the e-Builder Process Type (e.g. "Commitment Change Order")

FLAGS
  -A, --account=<value>      Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                             Production")
  -i, --session-id=<value>   Session ID to use
  -m, --markdown             output human-readable Markdown documentation: workflow diagram (Mermaid), steps with
                             actions and field assignments, data fields, and field access by layout
  -o, --output-file=<value>  write the output to this file instead of stdout
  -s, --show-browser         Show browser window
  -u, --username=<value>     Username to use session for
      --[no-]cached          use locally cached schema from SQLite if available (default: true)
      --compact              output ultra-compact field and step summary
      --refresh              force live refresh from e-Builder and update cache

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  inspect and project compact, token-efficient schema of an e-Builder process (fields, workflow, layout matrix)

ALIASES
  $ eb process schema

EXAMPLES
  $ eb process inspect "Commitment Change Order" --json

  $ eb process inspect "Invoice" --refresh --json

  $ eb process inspect "Submittal" --compact

  $ eb process inspect "Submittal" --markdown -o submittal.md
```

## `eb process instances`

List a project's process instances (open by default; --status closed|draft|all)

```
USAGE
  $ eb process instances -P <value> [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [--process <value>] [--search
    <value>] [--status open|closed|draft|all]

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -P, --project=<value>     (required) Project name (case-insensitive, unique partial match) or PortalID GUID
  -i, --session-id=<value>  Session ID to use
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
      --process=<value>     Filter by process prefix (e.g. "MPA") or process type name
      --search=<value>      Case-insensitive text filter over all columns
      --status=<option>     [default: open] Which instances to list
                            <options: open|closed|draft|all>

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  List a project's process instances (open by default; --status closed|draft|all)

  Lists the instances on the project's Processes page (its default view: open instances) with step, status, and dates.

EXAMPLES
  $ eb process instances --project "RH - eB-CLI Test project" --json

  $ eb process instances --project "RH - eB-CLI Test project" --process MPA --search "asset" --json
```

## `eb process set INSTANCE`

Set fields on a process instance and save

```
USAGE
  $ eb process set INSTANCE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-P <value>] [-F <value>...]
    [--fields <value>] [--accept-ownership] [--dry-run]

ARGUMENTS
  INSTANCE  InstanceID GUID, or instance name with --project

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -F, --field=<value>...    Field to set as "Label=value" (repeatable). Label match is case-insensitive; a DataFieldID
                            GUID also works. Use "a; b" for multi-value fields and an empty value to clear.
  -P, --project=<value>     Project name (case-insensitive, unique partial match) or PortalID GUID
  -i, --session-id=<value>  Session ID to use
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
      --accept-ownership    Accept ownership of the step first if it hasn't been accepted
      --dry-run             Set the values in the form without saving
      --fields=<value>      Fields as a JSON object ({"Label": "value"}) or @path/to/file.json

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Set fields on a process instance and save

  Only fields editable at the current step can be set. Nothing is saved if any field cannot be set. If the step is
  assigned to a role whose ownership has not been accepted, e-Builder discards edits; pass --accept-ownership to accept
  it first.

EXAMPLES
  $ eb process set 8ededb4a-a8a2-46db-bdb7-707c88a1ddd7 -F "Drawing Number=A-101" --json

  $ eb process set "MPA - 2" -P "RH - eB-CLI Test project" --fields '{"Discipline":"Civil"}' --accept-ownership --json
```

## `eb process setnullfield FILE`

Set process instance fields to blank

```
USAGE
  $ eb process setnullfield FILE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [--dry-run] [-v] [-o <value>]

ARGUMENTS
  FILE  CSV file: first column is process instance ID; subsequent columns list field names to blank for that row

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -i, --session-id=<value>  Session ID to use
  -o, --output-csv=<value>  Write operation results to a CSV file at this path
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
  -v, --verbose             Show detailed progress for each process instance instead of overall progress bar
      --dry-run             Dry run (open and detect fields without saving)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Set process instance fields to blank

  Set one or more fields to blank for each process instance from a CSV file.

EXAMPLES
  $ eb process setnullfield process-null-fields.csv --session-id 1

  $ eb process setnullfield process-null-fields.csv --username myuser --dry-run
```

## `eb process start PROCESS`

Start (initiate) a process in a project, filling in its start-form fields

```
USAGE
  $ eb process start PROCESS -P <value> [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [--subject <value>]
    [-F <value>...] [--fields <value>] [--draft] [--dry-run]

ARGUMENTS
  PROCESS  Process name, prefix (e.g. "MPA"), or ProcessID

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -F, --field=<value>...    Field to set as "Label=value" (repeatable). Label match is case-insensitive; a DataFieldID
                            GUID also works. Use "a; b" for multi-value fields and an empty value to clear.
  -P, --project=<value>     (required) Project name (case-insensitive, unique partial match) or PortalID GUID
  -i, --session-id=<value>  Session ID to use
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
      --draft               Save as a draft instead of submitting
      --dry-run             Fill the form and report what would be set, without submitting
      --fields=<value>      Fields as a JSON object ({"Label": "value"}) or @path/to/file.json
      --subject=<value>     Instance subject (when the workflow allows a manual subject)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Start (initiate) a process in a project, filling in its start-form fields

  Fills the start form and clicks Submit (or Save Draft with --draft). Fields are matched by label. Some workflows
  generate the subject automatically; --subject is only accepted when the form has a subject box. Nothing is submitted
  if any field cannot be set.

EXAMPLES
  $ eb process start "Weather Demo" --project "RH - eB-CLI Test project" --subject "Site visit" -F "Weather_Conditions=Sunny" --json

  $ eb process start MPA -P "RH - eB-CLI Test project" -F "RFI Subject=Door hardware" -F "Is There a Potential Cost Impact?=No" --json
```

## `eb process startable`

List the processes you can start in a project

```
USAGE
  $ eb process startable -P <value> [--json] [-i <value>] [-u <value>] [-A <value>] [-s]

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -P, --project=<value>     (required) Project name (case-insensitive, unique partial match) or PortalID GUID
  -i, --session-id=<value>  Session ID to use
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for

GLOBAL FLAGS
  --json  Format output as json.

EXAMPLES
  $ eb process startable --project "RH - eB-CLI Test project" --json
```

## `eb process submit INSTANCE`

Submit a draft process instance (optionally setting fields first)

```
USAGE
  $ eb process submit INSTANCE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-F <value>...] [--fields
    <value>]

ARGUMENTS
  INSTANCE  Draft InstanceID (returned by `eb process start --draft`)

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -F, --field=<value>...    Field to set as "Label=value" (repeatable). Label match is case-insensitive; a DataFieldID
                            GUID also works. Use "a; b" for multi-value fields and an empty value to clear.
  -i, --session-id=<value>  Session ID to use
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
      --fields=<value>      Fields as a JSON object ({"Label": "value"}) or @path/to/file.json

GLOBAL FLAGS
  --json  Format output as json.

EXAMPLES
  $ eb process submit fcc61467-0ea8-4dd4-89d8-cdee6853f85d -F "Weather_Conditions=Clear" --json
```

## `eb process view INSTANCE`

Show a process instance: step, status, available actions, and fields

```
USAGE
  $ eb process view INSTANCE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-P <value>]

ARGUMENTS
  INSTANCE  InstanceID GUID, or instance name with --project

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -P, --project=<value>     Project name (case-insensitive, unique partial match) or PortalID GUID
  -i, --session-id=<value>  Session ID to use
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for

GLOBAL FLAGS
  --json  Format output as json.

EXAMPLES
  $ eb process view 8ededb4a-a8a2-46db-bdb7-707c88a1ddd7 --json

  $ eb process view "MPA - 2" --project "RH - eB-CLI Test project" --json
```

## `eb project settings get PROJECT`

Show a project's settings (Project Details → Settings tab)

```
USAGE
  $ eb project settings get PROJECT [--json] [-i <value>] [-u <value>] [-A <value>] [-s]

ARGUMENTS
  PROJECT  Exact project name (case-insensitive) or PortalID GUID

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -i, --session-id=<value>  Session ID to use
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Show a project's settings (Project Details → Settings tab)

  Reads Project Access, Deny Techsupport Access, Enable Document Control, Workflow Due Date Offset, Work Day Start/End
  Time and Work Week. Settings that are hidden or read-only for the project are listed as unavailable.

EXAMPLES
  $ eb project settings get "RH - eB-CLI Test project"

  $ eb project settings get 9869854c-4c8d-4638-8b5e-e52d08103c12 --json
```

## `eb project settings set [PROJECT]`

Change a project's settings (Project Details → Settings tab)

```
USAGE
  $ eb project settings set [PROJECT] [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-f <value> | --access
    visible|hidden | --deny-techsupport yes|no | --document-control yes|no | --due-date-offset <value> | --work-start
    <value> | --work-end <value> | --work-week <value>] [--dry-run] [-v] [-o <value>]

ARGUMENTS
  [PROJECT]  Exact project name (case-insensitive) or PortalID GUID. Omit when using --file.

FLAGS
  -A, --account=<value>            Select session by account name (case-insensitive substring, e.g. "prod", "uat", or
                                   "Acme - Production")
  -f, --file=<value>               CSV with a project column and one column per setting
  -i, --session-id=<value>         Session ID to use
  -o, --output-csv=<value>         (--file) Write per-project results to this CSV
  -s, --show-browser               Show browser window
  -u, --username=<value>           Username to use session for
  -v, --verbose                    (--file) Print each project instead of a progress bar
      --access=<option>            Project Access
                                   <options: visible|hidden>
      --deny-techsupport=<option>  Deny Techsupport Access (yes = e-Builder employees cannot access the project)
                                   <options: yes|no>
      --document-control=<option>  Enable Document Control
                                   <options: yes|no>
      --dry-run                    Show what would change without saving
      --due-date-offset=<value>    Workflow Due Date Offset (whole number)
      --work-end=<value>           Work Day End Time, e.g. "3:00 pm"
      --work-start=<value>         Work Day Start Time, e.g. "7:00 am"
      --work-week=<value>          Working days, e.g. "mon,tue,wed,thu,fri", "mon-fri" or "weekdays"

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Change a project's settings (Project Details → Settings tab)

  Sets Project Access, Deny Techsupport Access, Enable Document Control, Workflow Due Date Offset, Work Day Start/End
  Time and Work Week, then saves and reads the values back to confirm them. Settings you don't pass are left unchanged,
  and nothing is saved when the project already matches.

  Use flags for one project, or --file for a CSV with a "project" column (name or PortalID) and one column per setting:
  projectAccess, denyTechsupport, documentControl, workflowDueDateOffset, workDayStart, workDayEnd, workWeek. Blank
  cells are left unchanged. Every row is validated before anything is saved.

  Values: access visible|hidden; yes/no for the yes/no settings; whole-hour times ("7:00 am", "7am", "15:00"); work week
  as days ("mon,tue,wed,thu,fri", "mon-fri", "weekdays").

EXAMPLES
  $ eb project settings set "RH - eB-CLI Test project" --work-week mon-fri --work-start 7am --work-end 4pm

  $ eb project settings set 9869854c-4c8d-4638-8b5e-e52d08103c12 --access hidden --dry-run --json

  $ eb project settings set --file settings.csv -o results.csv
```

## `eb reports copy`

copy a report configuration directly from one e-Builder account/session to another

```
USAGE
  $ eb reports copy --from-session <value> --to-session <value> --report-id <value> [--json] [-n <value>] [-s]

FLAGS
  -n, --name=<value>          Optional new name for the recreated report in the target account
  -s, --show-browser          Show browser window during copying
      --from-session=<value>  (required) Source session ID containing the report to copy
      --report-id=<value>     (required) Source report ID to copy
      --to-session=<value>    (required) Target session ID where the report will be recreated

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  copy a report configuration directly from one e-Builder account/session to another

EXAMPLES
  $ eb reports copy --from-session 1 --to-session 2 --report-id 12345 --json

  $ eb reports copy --from-session 1 --to-session 2 --report-id 12345 --name "Cloned Cost Summary"
```

## `eb reports export-config REPORT`

export portable configuration AST of an e-Builder report for inspection or cross-account replication

```
USAGE
  $ eb reports export-config REPORT [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-o <value>]

ARGUMENTS
  REPORT  Report ID to export configuration from

FLAGS
  -A, --account=<value>      Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                             Production")
  -i, --session-id=<value>   Session ID to use
  -o, --output-file=<value>  file path to save report configuration JSON
  -s, --show-browser         Show browser window
  -u, --username=<value>     Username to use session for

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  export portable configuration AST of an e-Builder report for inspection or cross-account replication

ALIASES
  $ eb reports export

EXAMPLES
  $ eb reports export-config 12345 --json

  $ eb reports export-config 12345 --output-file ./report-config.json
```

## `eb reports import-config FILE`

create a new e-Builder report from a portable JSON report configuration file

```
USAGE
  $ eb reports import-config FILE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-n <value>] [--folder <value>]

ARGUMENTS
  FILE  Path to the report configuration JSON file

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -i, --session-id=<value>  Session ID to use
  -n, --name=<value>        Optional name override for the imported report
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
      --folder=<value>      Report folder to save into (overrides the config's folder)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  create a new e-Builder report from a portable JSON report configuration file

ALIASES
  $ eb reports import

EXAMPLES
  $ eb reports import-config ./my-report.json --json

  $ eb reports import-config ./my-report.json --name "New Custom Report"
```

## `eb reports list`

list available standard and custom e-Builder reports with caching

```
USAGE
  $ eb reports list [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-c <value>] [-q <value>] [--cached]
    [--refresh]

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -c, --category=<value>    Filter reports by category name
  -i, --session-id=<value>  Session ID to use
  -q, --search=<value>      Filter reports by search keyword in name or description
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
      --[no-]cached         Use locally cached report catalog from SQLite if available (default: true)
      --refresh             Force live refresh from e-Builder and update cache

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  list available standard and custom e-Builder reports with caching

ALIASES
  $ eb reports catalog

EXAMPLES
  $ eb reports list --json

  $ eb reports list --category Process --json

  $ eb reports list --search "Change Order" --refresh
```

## `eb reports run REPORT`

run an e-Builder report and return token-efficient tabular results or export CSV/JSON

```
USAGE
  $ eb reports run REPORT [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-l <value>] [--format json|csv]
    [-o <value>]

ARGUMENTS
  REPORT  Report ID to execute

FLAGS
  -A, --account=<value>      Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                             Production")
  -i, --session-id=<value>   Session ID to use
  -l, --limit=<value>        [default: 50] maximum number of rows to extract for token safety (default: 50)
  -o, --output-file=<value>  file path to save report output
  -s, --show-browser         Show browser window
  -u, --username=<value>     Username to use session for
      --format=<option>      [default: json] output format
                             <options: json|csv>

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  run an e-Builder report and return token-efficient tabular results or export CSV/JSON

ALIASES
  $ eb reports execute

EXAMPLES
  $ eb reports run 12345 --limit 25 --json

  $ eb reports run 12345 --format csv --output-file ./report.csv
```

## `eb session exec [URL]`

Execute JavaScript or Puppeteer automation in an authenticated e-Builder session

```
USAGE
  $ eb session exec [URL] [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-e <value> | -f <value>] [--url
    <value>] [-p] [-a <value>] [-w <value>] [--screenshot <value>] [--screenshot-on-failure] [--dialog-policy
    dismiss|accept|manual] [--inspect]

ARGUMENTS
  [URL]  e-Builder relative path (e.g. /da2/Processes/ProcessesMain.aspx) or full URL (defaults to Home)

FLAGS
  -A, --account=<value>             Select session by account name (case-insensitive substring, e.g. "prod", "uat", or
                                    "Acme - Production")
  -a, --arg=<value>                 JSON (or string) argument passed to the evaluated script function
  -e, --eval=<value>                JavaScript snippet or function to evaluate (alias: --script)
  -f, --script-file=<value>         Path to a JavaScript file to evaluate (alias: --file). `export default` /
                                    `module.exports =` wrappers are accepted.
  -i, --session-id=<value>          Session ID to use
  -p, --[no-]puppeteer              Run script in Node Puppeteer context ({ page, browser, context, env, origin, url,
                                    arg, args, fs, path, os, eb, settle, inspect }). Auto-detected when omitted; use
                                    --no-puppeteer to force DOM mode.
  -s, --show-browser                Show browser window
  -u, --username=<value>            Username to use session for
  -w, --wait-for=<value>            CSS selector to wait for (in main document or #contentFrame) before evaluating
      --dialog-policy=<option>      [default: dismiss] How to answer alert/confirm/prompt dialogs. "manual" leaves them
                                    to your script; a Puppeteer script with its own page.on("dialog") listener always
                                    takes precedence.
                                    <options: dismiss|accept|manual>
      --inspect                     Inspect and extract page structure (forms, fields, buttons, tables) into structured
                                    JSON AST
      --screenshot=<value>          Save a full-page PNG screenshot to this file path after execution
      --[no-]screenshot-on-failure  Capture screenshot on execution or wait-for error (default: true)
      --url=<value>                 e-Builder relative path or full URL (alternative to the positional URL argument)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Execute JavaScript or Puppeteer automation in an authenticated e-Builder session

  Navigate to an e-Builder path or URL using a stored session (headless by default) and evaluate a DOM or Puppeteer
  script. Automatically resolves environment URLs, verifies the session on the target navigation, and saves refreshed
  cookies. Errors report a typed code (SessionExpiredError, NetworkError, NavigationTimeoutError) so network problems
  are not mistaken for logouts.

ALIASES
  $ eb exec

EXAMPLES
  $ eb session exec /da2/Processes/ProcessesMain.aspx --eval "document.title" --json

  $ eb session exec --account prod --url /da2/Home/index2.aspx --file ./script.js --json

  $ eb session exec ./script.js --account uat --json

  $ eb session exec /da2/Setup/Processes/ProcessTypesView.aspx --script-file extract-types.js --json

  $ eb session exec /da2/Processes/ImportProcesses/ImportProcesses.aspx --puppeteer --script-file inspect-step2.js --arg '{"file":"./dummy.xlsx"}' --json
```

## `eb session import`

import the e-Builder session you are signed in to in Google Chrome

```
USAGE
  $ eb session import [-u <value>] [-a <value>] [-e us1|us2|us3|us4|gov|ca] [--chrome-data-dir <value>] [--timeout
    <value>]

FLAGS
  -a, --account=<value>          account name to save if it cannot be detected
  -e, --environment=<option>     environment to import (default: the one Chrome is signed in to)
                                 <options: us1|us2|us3|us4|gov|ca>
  -u, --username=<value>         username to save if it cannot be detected
      --chrome-data-dir=<value>  Chrome user data directory (default: the standard Google Chrome location)
      --timeout=<value>          [default: 120] seconds to wait for remote debugging to be enabled and approved

DESCRIPTION
  import the e-Builder session you are signed in to in Google Chrome

  Connects to your running Chrome over remote debugging, reads only the e-Builder cookies, and disconnects; your browser
  and tabs are left as they are. Requires Chrome 144+ with remote debugging allowed at
  chrome://inspect/#remote-debugging (one-time setup; eb opens that page for you if needed). Chrome asks you to approve
  each connection.

  The environment, username, and account are detected from the session itself.

  The imported session is the same login as your Chrome tab: logging out of either one (eb logout or e-Builder's Log
  Out) ends both.

EXAMPLES
  $ eb session import

  $ eb session import --environment us2 # when Chrome is signed in to several
```

## `eb session list`

list open e-Builder sessions

```
USAGE
  $ eb session list [--json] [-u <value>]

FLAGS
  -u, --username=<value>  username to filter sessions by

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  list open e-Builder sessions

EXAMPLES
  $ eb session list

  $ eb session list --username myuser

  $ eb session list --json
```

## `eb session test`

test e-Builder sessions and refresh valid ones. With --delete, removes sessions that were redirected to a login page (network errors, timeouts, and server errors never delete a session).

```
USAGE
  $ eb session test [--json] [-u <value>] [-s] [-d]

FLAGS
  -d, --[no-]delete       delete sessions whose cookies were rejected (redirected to login). Never deletes on
                          network/timeout/server errors.
  -s, --show_browser      show browser window during testing
  -u, --username=<value>  username to test sessions for (tests all if not specified)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  test e-Builder sessions and refresh valid ones. With --delete, removes sessions that were redirected to a login page
  (network errors, timeouts, and server errors never delete a session).

ALIASES
  $ eb session clean

EXAMPLES
  $ eb session test

  $ eb session test --username myuser

  $ eb session test --show-browser

  $ eb session test --json

  $ eb session test --delete
```

## `eb update [CHANNEL]`

update the eb CLI

```
USAGE
  $ eb update [CHANNEL] [--force |  | [-a | -v <value> | -i]] [-b ]

FLAGS
  -a, --available        See available versions.
  -b, --verbose          Show more details about the available versions.
  -i, --interactive      Interactively select version to install. This is ignored if a channel is provided.
  -v, --version=<value>  Install a specific version.
      --force            Force a re-download of the requested version.

DESCRIPTION
  update the eb CLI

EXAMPLES
  Update to the stable channel:

    $ eb update stable

  Update to a specific version:

    $ eb update --version 1.0.0

  Interactively select version:

    $ eb update --interactive

  See available versions:

    $ eb update --available
```

_See code: [@oclif/plugin-update](https://github.com/oclif/plugin-update/blob/4.7.59/src/commands/update.ts)_

## `eb users delete FILE`

Delete users from a CSV

```
USAGE
  $ eb users delete FILE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [--dry-run] [-v] [-o <value>]

ARGUMENTS
  FILE  CSV file containing user IDs to delete

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -i, --session-id=<value>  Session ID to use
  -o, --output-csv=<value>  Write operation results to a CSV file at this path
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
  -v, --verbose             Show detailed progress for each user instead of overall progress bar
      --dry-run             Dry run (no actual deletion)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Delete users from a CSV

  Delete users from an account using CSV input

EXAMPLES
  $ eb users delete users.csv --session-id 1

  $ eb users delete users.csv --username myuser
```

## `eb users remove-project FILE`

Remove users from projects from a CSV

```
USAGE
  $ eb users remove-project FILE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [--dry-run] [-v] [-o <value>]

ARGUMENTS
  FILE  CSV file containing projectName, userName

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -i, --session-id=<value>  Session ID to use
  -o, --output-csv=<value>  Write operation results to a CSV file at this path
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
  -v, --verbose             Show detailed progress for each row instead of overall progress bar
      --dry-run             Dry run (no actual removal)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Remove users from projects from a CSV

  Remove users from projects using CSV input

EXAMPLES
  $ eb users remove-project remove-users.csv --session-id 1

  $ eb users remove-project remove-users.csv --username myuser
```

## `eb users remove-project-role FILE`

Remove users from project roles from a CSV

```
USAGE
  $ eb users remove-project-role FILE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [--dry-run] [-v] [-o <value>]

ARGUMENTS
  FILE  CSV file containing projectName, roleName, userName

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -i, --session-id=<value>  Session ID to use
  -o, --output-csv=<value>  Write operation results to a CSV file at this path
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
  -v, --verbose             Show detailed progress for each row instead of overall progress bar
      --dry-run             Dry run (no actual removal)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Remove users from project roles from a CSV

  Remove users from project roles using CSV input

EXAMPLES
  $ eb users remove-project-role remove-users.csv --session-id 1

  $ eb users remove-project-role remove-users.csv --username myuser
```

## `eb users setfield FILE`

Set user fields from a CSV

```
USAGE
  $ eb users setfield FILE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [--dry-run] [-v] [-o <value>]

ARGUMENTS
  FILE  CSV file containing a userId column and one or more field-value columns

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -i, --session-id=<value>  Session ID to use
  -o, --output-csv=<value>  Write operation results to a CSV file at this path
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
  -v, --verbose             Show detailed progress for each user instead of overall progress bar
      --dry-run             Dry run (open and detect fields without saving)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Set user fields from a CSV

  Set built-in or custom user fields using CSV input where each column name is the field label.

EXAMPLES
  $ eb users setfield user-fields.csv --session-id 1

  $ eb users setfield user-fields.csv --username myuser --dry-run
```

## `eb users setsso FILE`

Set user SSO values from a CSV

```
USAGE
  $ eb users setsso FILE [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [--dry-run] [-v] [-o <value>]

ARGUMENTS
  FILE  CSV file containing userId and sso values

FLAGS
  -A, --account=<value>     Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                            Production")
  -i, --session-id=<value>  Session ID to use
  -o, --output-csv=<value>  Write operation results to a CSV file at this path
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
  -v, --verbose             Show detailed progress for each user instead of overall progress bar
      --dry-run             Dry run (no actual changes)

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Set user SSO values from a CSV

  Set SSO true/false per user using CSV input with userId and sso columns.

EXAMPLES
  $ eb user setsso users-sso.csv --session-id 1

  $ eb user setsso users-sso.csv --username myuser --dry-run
```

## `eb users sso-report`

Generate users SSO report

```
USAGE
  $ eb users sso-report [--json] [-i <value>] [-u <value>] [-A <value>] [-s] [-o <value>] [--overwrite] [-v]

FLAGS
  -A, --account=<value>      Select session by account name (case-insensitive substring, e.g. "prod", "uat", or "Acme -
                             Production")
  -i, --session-id=<value>   Session ID to use
  -o, --output-file=<value>  [default: users-sso-report-<timestamp>.csv] Path to CSV output file
  -s, --show-browser         Show browser window
  -u, --username=<value>     Username to use session for
  -v, --verbose              Show detailed progress for each user instead of overall progress bar
      --overwrite            Overwrite output file if it exists

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Generate users SSO report

  Generate a CSV report showing whether SSO is required for every user in Manage Users.

EXAMPLES
  $ eb users sso-report --session-id 1

  $ eb users sso-report --username myuser --output-file users-sso.csv
```

<!-- commandsstop -->

## Development

Requires Node 22.

```sh
npm install
./bin/dev.js <command>   # run from source without building
npm test                 # build, then run the test suite
npm run lint
npm run format:check
npm run readme           # regenerate the command reference above
```

### Releasing

Pushing a `v*` tag (for example `v0.5.3`) runs `.github/workflows/release.yml`, which:

- creates a GitHub Release with generated notes
- builds the oclif autoupdate tarballs for each platform, uploads them to S3, and promotes them to a release channel
- builds native installers (`.pkg`, `.exe`, `.deb`) and attaches them to the release, plus version-free copies for the `releases/latest/download/...` links
- marks the release as latest once every installer is attached (stable releases only)

The workflow needs these repository settings:

- Secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- Variables: `OCLIF_S3_BUCKET` (required), `AWS_REGION` (optional, defaults to `us-east-1`)

The version's prerelease tag selects the channel:

| Tag              | Channel     |
| ---------------- | ----------- |
| `v1.2.3`         | `stable`    |
| `v1.2.3-alpha.N` | `alpha`     |
| `v1.2.3-beta.N`  | `beta`      |
| `v1.2.3-rc.N`    | `stable-rc` |
| other prerelease | `beta`      |

## License

Proprietary. All rights reserved. The source is publicly viewable, but you may not use, copy, modify, or distribute it without written permission. See [LICENSE](LICENSE).
