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

EXAMPLES
  $ eb login
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
