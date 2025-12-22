# Usage

<!-- usage -->

```sh-session
$ npm install -g eb-cli
$ eb COMMAND
running command...
$ eb (--version)
eb-cli/0.1.0-alpha.1 darwin-arm64 node-v22.14.0
$ eb --help [COMMAND]
USAGE
  $ eb COMMAND
...
```

<!-- usagestop -->

# Commands

<!-- commands -->

- [`eb budgetitems delete FILE`](#eb-budgetitems-delete-file)
- [`eb budgetitems set FILE`](#eb-budgetitems-set-file)
- [`eb login`](#eb-login)
- [`eb logout`](#eb-logout)
- [`eb session clean`](#eb-session-clean)
- [`eb session create`](#eb-session-create)
- [`eb session delete`](#eb-session-delete)
- [`eb session list`](#eb-session-list)
- [`eb session test`](#eb-session-test)
- [`eb users delete [FILE]`](#eb-users-delete-file)

## `eb budgetitems delete FILE`

Delete budget items from a CSV

```
USAGE
  $ eb budgetitems delete FILE [--json] [--session-id <value>] [-u <value>] [-s] [--dry-run]

ARGUMENTS
  FILE  CSV file containing budget item IDs to delete

FLAGS
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
      --dry-run             Dry run (no actual deletion)
      --session-id=<value>  Session ID to use

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
  $ eb budgetitems set FILE [--json] [--session-id <value>] [-u <value>] [-s] [--dry-run]

ARGUMENTS
  FILE  CSV file containing budget item properties to set

FLAGS
  -s, --show-browser        Show browser window
  -u, --username=<value>    Username to use session for
      --dry-run             Dry run (no actual changes)
      --session-id=<value>  Session ID to use

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

## `eb users delete [FILE]`

describe the command here

```
USAGE
  $ eb users delete [FILE] [-f] [-n <value>]

ARGUMENTS
  [FILE]  file to read

FLAGS
  -f, --force
  -n, --name=<value>  name to print

DESCRIPTION
  describe the command here

EXAMPLES
  $ eb users delete
```

<!-- commandsstop -->

# Table of contents

<!-- toc -->

- [Usage](#usage)
- [Commands](#commands)
- [Table of contents](#table-of-contents)
<!-- tocstop -->
