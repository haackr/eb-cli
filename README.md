# Usage

<!-- usage -->
```sh-session
$ npm install -g eb-cli
$ eb COMMAND
running command...
$ eb (--version)
eb-cli/1.0.0 darwin-arm64 node-v22.14.0
$ eb --help [COMMAND]
USAGE
  $ eb COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
* [`eb budgetitems delete [FILE]`](#eb-budgetitems-delete-file)
* [`eb budgetitems set [FILE]`](#eb-budgetitems-set-file)
* [`eb login`](#eb-login)
* [`eb logout`](#eb-logout)
* [`eb session clean`](#eb-session-clean)
* [`eb session create`](#eb-session-create)
* [`eb session delete`](#eb-session-delete)
* [`eb session list`](#eb-session-list)
* [`eb session test`](#eb-session-test)
* [`eb users delete [FILE]`](#eb-users-delete-file)

## `eb budgetitems delete [FILE]`

describe the command here

```
USAGE
  $ eb budgetitems delete [FILE] [-f] [-n <value>]

ARGUMENTS
  FILE  file to read

FLAGS
  -f, --force
  -n, --name=<value>  name to print

DESCRIPTION
  describe the command here

EXAMPLES
  $ eb budgetitems delete
```

## `eb budgetitems set [FILE]`

describe the command here

```
USAGE
  $ eb budgetitems set [FILE] [-f] [-n <value>]

ARGUMENTS
  FILE  file to read

FLAGS
  -f, --force
  -n, --name=<value>  name to print

DESCRIPTION
  describe the command here

EXAMPLES
  $ eb budgetitems set
```

## `eb login`

log in to e-Builder

```
USAGE
  $ eb login [-s] [-u <value>] [-a <value>] [-e us1|us2|us3|us4|gov|ca]

FLAGS
  -a, --account=<value>       account (if the user has access to multiple accounts)
  -e, --environment=<option>  environment
                              <options: us1|us2|us3|us4|gov|ca>
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
  $ eb logout [-s] [-u <value>] [-a <value>] [-A]

FLAGS
  -A, --all               logout from all sessions
  -a, --account=<value>   account (if the user has access to multiple accounts)
  -s, --show_browser      show browser window (useful for debugging; default is headless)
  -u, --username=<value>  username

DESCRIPTION
  log out of e-Builder sessions

ALIASES
  $ eb session delete

EXAMPLES
  $ eb logout
```

## `eb session clean`

test e-Builder sessions and remove invalid ones

```
USAGE
  $ eb session clean [-u <value>]

FLAGS
  -u, --username=<value>  username to test sessions for (tests all if not specified)

DESCRIPTION
  test e-Builder sessions and remove invalid ones

ALIASES
  $ eb session clean

EXAMPLES
  $ eb session clean

  $ eb session clean --username myuser
```

## `eb session create`

log in to e-Builder

```
USAGE
  $ eb session create [-s] [-u <value>] [-a <value>] [-e us1|us2|us3|us4|gov|ca]

FLAGS
  -a, --account=<value>       account (if the user has access to multiple accounts)
  -e, --environment=<option>  environment
                              <options: us1|us2|us3|us4|gov|ca>
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
  $ eb session delete [-s] [-u <value>] [-a <value>] [-A]

FLAGS
  -A, --all               logout from all sessions
  -a, --account=<value>   account (if the user has access to multiple accounts)
  -s, --show_browser      show browser window (useful for debugging; default is headless)
  -u, --username=<value>  username

DESCRIPTION
  log out of e-Builder sessions

ALIASES
  $ eb session delete

EXAMPLES
  $ eb session delete
```

## `eb session list`

list open e-Builder sessions

```
USAGE
  $ eb session list [-u <value>]

FLAGS
  -u, --username=<value>  username to filter sessions by

DESCRIPTION
  list open e-Builder sessions

EXAMPLES
  $ eb session list

  $ eb session list --username myuser
```

## `eb session test`

test e-Builder sessions and remove invalid ones

```
USAGE
  $ eb session test [-u <value>]

FLAGS
  -u, --username=<value>  username to test sessions for (tests all if not specified)

DESCRIPTION
  test e-Builder sessions and remove invalid ones

ALIASES
  $ eb session clean

EXAMPLES
  $ eb session test

  $ eb session test --username myuser
```

## `eb users delete [FILE]`

describe the command here

```
USAGE
  $ eb users delete [FILE] [-f] [-n <value>]

ARGUMENTS
  FILE  file to read

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
* [Usage](#usage)
* [Commands](#commands)
* [Table of contents](#table-of-contents)
<!-- tocstop -->
