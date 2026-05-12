# Usage

<!-- usage -->

```sh-session
$ npm install -g eb-cli
$ eb COMMAND
running command...
$ eb (--version)
eb-cli/0.1.0-alpha.4 darwin-arm64 node-v22.14.0
$ eb --help [COMMAND]
USAGE
  $ eb COMMAND
...
```

<!-- usagestop -->

# Release Automation

GitHub releases automatically:

- build and publish oclif autoupdate tarballs to S3
- build native installers (`.exe`, `.pkg`, `.deb`) and attach them to the GitHub Release

The workflow is in `.github/workflows/release.yml` and runs when a release is published.

Configure these repository settings before publishing a release:

- Secrets:
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
- Variables:
  - `OCLIF_S3_BUCKET` (required)
  - `AWS_REGION` (optional, defaults to `us-east-1`)
  - `OCLIF_TARGETS` (optional, defaults to `darwin-arm64,darwin-x64,linux-x64,win32-x64`)

Channel behavior:

- prerelease releases are promoted by semver prerelease tag:
  - `*-alpha.*` -> `alpha`
  - `*-beta.*` -> `beta`
  - `*-rc.*` -> `stable-rc`
  - other prerelease tags -> `beta`
- non-prerelease releases are promoted to `stable`

Update channel defaults:

- `eb update` with no channel now defaults to the channel derived from the installed CLI version
- native installers therefore track the channel they were built for by default (for example, `alpha` installers check `alpha` updates)

# Commands

<!-- commands -->

- [`eb apilogs download`](#eb-apilogs-download)
- [`eb budgetitems delete FILE`](#eb-budgetitems-delete-file)
- [`eb budgetitems set FILE`](#eb-budgetitems-set-file)
- [`eb login`](#eb-login)
- [`eb logout`](#eb-logout)
- [`eb session clean`](#eb-session-clean)
- [`eb session create`](#eb-session-create)
- [`eb session delete`](#eb-session-delete)
- [`eb session list`](#eb-session-list)
- [`eb session test`](#eb-session-test)
- [`eb update [CHANNEL]`](#eb-update-channel)
- [`eb users delete FILE`](#eb-users-delete-file)

## `eb apilogs download`

Download e-Builder API logs to JSONL

```
USAGE
  $ eb apilogs download [--json] [-i <value>] [-u <value>] [-s] [-p <value>] [-o <value>] [--overwrite]

FLAGS
  -i, --session-id=<value>   Session ID to use
  -o, --output-file=<value>  [default: /Users/ryan/dev/eb-cli/api-logs-2026-05-11T21-14-48-161Z.jsonl] Path to output
                             JSONL file (one log record per line)
  -p, --pages=<value>        [default: 10] Number of pages to download from the API logs table
  -s, --show-browser         Show browser window
  -u, --username=<value>     Username to use session for
      --overwrite            Overwrite output file if it already exists

GLOBAL FLAGS
  --json  Format output as json.

DESCRIPTION
  Download e-Builder API logs to JSONL

  Download API logs from e-Builder, including modal details, across paginated pages

EXAMPLES
  $ eb apilogs download --session-id 1

  $ eb apilogs download --username myuser --pages 10 --output-file ./api-logs.jsonl
```

## `eb budgetitems delete FILE`

Delete budget items from a CSV

```
USAGE
  $ eb budgetitems delete FILE [--json] [-i <value>] [-u <value>] [-s] [--dry-run] [-v] [-o <value>]

ARGUMENTS
  FILE  CSV file containing budget item IDs to delete

FLAGS
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

  Delete budget items from a CSV file

EXAMPLES
  $ eb budgetitems delete items.csv --session-id 1

  $ eb budgetitems delete items.csv --username myuser
```

## `eb budgetitems set FILE`

Set budget item properties from a CSV

```
USAGE
  $ eb budgetitems set FILE [--json] [-i <value>] [-u <value>] [-s] [--dry-run] [-v] [-o <value>]

ARGUMENTS
  FILE  CSV file containing budget item properties to set

FLAGS
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

  Set properties for budget items from a CSV file

EXAMPLES
  $ eb budgetitems set items.csv --session-id 1

  $ eb budgetitems set items.csv --username myuser
```

## `eb login`

log in to e-Builder

```
USAGE
  $ eb login [-s] [-u <value>] [-p <value>] [-a <value>] [-e us1|us2|us3|us4|gov|ca]

FLAGS
  -a, --account=<value>       account (if the user has access to multiple accounts)
  -e, --environment=<option>  environment
                              <options: us1|us2|us3|us4|gov|ca>
  -p, --password=<value>      password
  -s, --show_browser          show browser window (useful for debugging; default is headless)
  -u, --username=<value>      username

DESCRIPTION
  log in to e-Builder

ALIASES
  $ eb session create

EXAMPLES
  $ eb login
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

## `eb session clean`

test e-Builder sessions, refresh valid ones, and remove invalid ones

```
USAGE
  $ eb session clean [-u <value>] [-s]

FLAGS
  -s, --show_browser      show browser window during testing
  -u, --username=<value>  username to test sessions for (tests all if not specified)

DESCRIPTION
  test e-Builder sessions, refresh valid ones, and remove invalid ones

ALIASES
  $ eb session clean

EXAMPLES
  $ eb session clean

  $ eb session clean --username myuser

  $ eb session clean --show-browser
```

## `eb session create`

log in to e-Builder

```
USAGE
  $ eb session create [-s] [-u <value>] [-p <value>] [-a <value>] [-e us1|us2|us3|us4|gov|ca]

FLAGS
  -a, --account=<value>       account (if the user has access to multiple accounts)
  -e, --environment=<option>  environment
                              <options: us1|us2|us3|us4|gov|ca>
  -p, --password=<value>      password
  -s, --show_browser          show browser window (useful for debugging; default is headless)
  -u, --username=<value>      username

DESCRIPTION
  log in to e-Builder

ALIASES
  $ eb session create

EXAMPLES
  $ eb session create
```

## `eb session delete`

log out of e-Builder sessions

```
USAGE
  $ eb session delete [-s] [-u <value>] [-a <value>] [-A] [-i <value>]

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
  $ eb session delete

  $ eb session delete --session-id 1

  $ eb session delete --username john.doe

  $ eb session delete --all
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

test e-Builder sessions, refresh valid ones, and remove invalid ones

```
USAGE
  $ eb session test [-u <value>] [-s]

FLAGS
  -s, --show_browser      show browser window during testing
  -u, --username=<value>  username to test sessions for (tests all if not specified)

DESCRIPTION
  test e-Builder sessions, refresh valid ones, and remove invalid ones

ALIASES
  $ eb session clean

EXAMPLES
  $ eb session test

  $ eb session test --username myuser

  $ eb session test --show-browser
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

_See code: [@oclif/plugin-update](https://github.com/oclif/plugin-update/blob/4.7.39/src/commands/update.ts)_

## `eb users delete FILE`

Delete users from a CSV

```
USAGE
  $ eb users delete FILE [--json] [-i <value>] [-u <value>] [-s] [--dry-run] [-v] [-o <value>]

ARGUMENTS
  FILE  CSV file containing user IDs to delete

FLAGS
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

<!-- commandsstop -->

# Table of contents

<!-- toc -->

- [Usage](#usage)
- [Release Automation](#release-automation)
- [Commands](#commands)
- [Table of contents](#table-of-contents)
<!-- tocstop -->
