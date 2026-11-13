# shell-progress

Helpers that let a script report its progress to a Claude Code mod that draws
a bar per job. The mod is not built yet. What exists is the helpers, one for
Bash and one for Windows PowerShell 5.1, and the file format they write.

## Line format

Each job owns one file holding one LF-terminated line, rewritten on every
update. Fields are separated by single spaces.

Running:

```
<startedEpochSec> <step> <total> <label...>
```

`total` is 0 when the script has no step count. The label may be empty, in
which case there is no trailing space.

Finished:

```
<startedEpochSec> done <exitCode> <endedEpochSec>
```

`exitCode` is a signed decimal integer: Windows reports some failures with a
negative code, such as -1073741819 for an access violation.

The file is `<progress dir>/<script file name>-<pid>.txt`, and the script file
name keeps its extension, for example `build.sh-1234.txt`. Two runs of the same
script therefore write two files. The start time is captured once, when the
helper is loaded, and every later write reuses it. Files are written to a
temporary name and renamed into place, so a reader never sees half a line.

## Bash

```bash
source helpers/progress.sh

progress 1 3 fetching sources
progress 2 3 compiling assets
progress 3 3
```

`progress <step> <total> [label words...]` joins the label words with single
spaces and replaces any carriage return or line feed with a space. Step and
total must be non-negative decimal integers. Otherwise the call prints a
message to stderr, writes nothing and returns 2.

A failed write prints a one-line warning and returns 0, so a transient
failure cannot stop a `set -e` script. The helper works under
`set -euo pipefail`.

Loading the helper installs an EXIT trap that writes the finished line with
the script's exit status. A script that sets its own EXIT trap replaces that
one, and its trap must call `progress_done "$?"`:

```bash
trap 'cleanup_temp_files; progress_done "$?"' EXIT
```

## PowerShell

```powershell
. "$PSScriptRoot/../helpers/progress.ps1"

$code = 0
try {
    Set-Progress -Step 7 -Total 12 -Label 'compiling assets'
    # ... work ...
} catch {
    $code = 1
    throw
} finally {
    Complete-Progress -ExitCode $code
}
```

Windows PowerShell 5.1 has no exit trap, so the `finally` block is the only
way to write the finished line. `Set-Progress` throws on a step or total that
is not a non-negative integer, with the same message as the Bash helper. A
failed write produces a warning, not an error.

## Where the files go

The progress directory is `$CLAUDE_PROGRESS_DIR` when it is set and not
empty. Otherwise it is `.claude/progress` under the working directory at the
moment the helper is loaded. It is created if missing.

A script that changes directory before loading the helper writes under that
other directory, where the mod will not look. Set `CLAUDE_PROGRESS_DIR` in that
case.

## Clean-up

Each time a helper is loaded it deletes finished files in the progress
directory whose end time is more than 24 hours old. Running files, files it
cannot parse and recent finished files are left alone. It examines at most 500
files per start, and any beyond that wait for the next one.

## Tests

The tests use only the Python 3.12 standard library. From the repository root:

```
python -m unittest discover -s tests -q
```

The Bash tests need `bash` on `PATH` and the PowerShell tests need
`powershell` (Windows PowerShell 5.1). A suite whose interpreter is missing is
skipped.

The mod's tests run against Claude Code's own test kit:

```
claude plugin test mod
claude plugin validate mod
```

Type-checking needs the API declarations that Claude Code writes into
`mod/.claude-plugin/types/` when an interactive session loads the mod, so
start `claude --plugin-dir mod` once after cloning. Then:

```
npx -y -p typescript@5.8.3 tsc -p mod
```
