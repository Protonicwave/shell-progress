# shell-progress

Helpers that let a script report its progress, and a Claude Code mod that
draws a bar per job in a pane beside the chat. There is one helper for Bash and
one for Windows PowerShell 5.1; both write the file format below, and the mod
reads it.

## Line format

Each job owns one file holding one LF-terminated line, rewritten on every
update. Fields are separated by single spaces.

Running:

```
<startedEpochSec> <step> <total> <label...>
```

`total` is 0 when the script has no step count. The label may be empty, in
which case there is no trailing space. It never holds a carriage return, line
feed or tab, and the mod treats a line with one as unreadable.

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

The helper needs Bash 4.2 or later, for `printf '%(%s)T'`. The `/bin/bash`
that ships with macOS is 3.2; use one from a package manager there.

```bash
source helpers/progress.sh

progress 1 3 fetching sources
progress 2 3 compiling assets
progress 3 3
```

`progress <step> <total> [label words...]` joins the label words with single
spaces and replaces any carriage return, line feed or tab with a space. Step and
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

`progress_done` takes a signed decimal integer. Given anything else it prints a
message to stderr, writes nothing and returns 2.

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
moment the helper is loaded, and a relative `CLAUDE_PROGRESS_DIR` is taken from
that directory too. The helper fixes the directory when it loads and creates it
if missing, so a script that changes directory later keeps writing to the same
place.

The mod looks in one directory only. A script that runs from another folder,
or changes directory before loading the helper, writes where the mod will not
look. For those, set `CLAUDE_PROGRESS_DIR` to one absolute path in the
environment Claude Code starts from and in the one the scripts run in, for
example by exporting it from your shell profile.

## Clean-up

Each time a helper is loaded it deletes finished files in the progress
directory whose end time is more than 24 hours old. Running files, files it
cannot parse and recent finished files are left alone. It examines at most 500
files per start, and any beyond that wait for the next one.

A script killed before it could write its finished line, by `kill -9`, Task
Manager or `Stop-Process`, or a PowerShell script with no `finally` block,
leaves a running file that nothing removes. The mod shows it as stalled, in
the pane and on the status line, in every session until the file is deleted
from the progress directory by hand, or until it is dismissed in the pane,
which takes it off both the pane and the status line in every session.

## The mod

The mod in `mod/` polls the progress directory twice a second. It reads the
same directory the helpers write to: `$CLAUDE_PROGRESS_DIR` when the session
has it set, otherwise `.claude/progress` under the folder the session started
in.

The pane lists each running job with a bar, its step and total, its label and
the time since it started. From its third step a job also shows about how long
it has left, from its average time per step so far. A job with no step count
shows a spinner instead of a bar. A running job whose file has not changed for
10 minutes is marked stalled, with how long it ran before its file went quiet,
which is how a script that was killed before it could write its finished line
shows. Under a Finished heading come the five newest jobs that ended during the
session, with how long each took and, for a failure, its exit code. A file
that does not hold a progress line shows as `unreadable progress line`.

Pressing a job's name expands its row to the path of its progress file, its
process id, the time it started and, once finished, its exit code. Pressing it
again, or another job's name, collapses it. An expanded stalled or finished
job has a Dismiss button, which hides the job from the pane in this session and
later ones. The pane's header then counts the hidden jobs, and pressing the
count shows them all again. A later run that writes to the same file name is a
new job and shows.

The pane opens by itself the first time a job starts running in a session, if
the terminal is at least 144 columns wide. It does not open by itself again in
that session once closed. `/progress` opens it at any width. While a job runs,
the status line under the prompt also names up to two jobs with their
percentages, such as `build 58% · sync running · 1 more`.

When a job the mod saw running finishes, a toast names it and how it ended,
such as `build.sh done in 0m 31s`, or counts the jobs when several finish
together. A job that failed, or ran for at least 2 minutes, also raises a
system notification through the channel Claude Code's notification settings
name. A dismissed job raises neither.

To run the mod for one session, start Claude Code from the repository root
with:

```
claude --plugin-dir mod
```

To load it in every session, add the absolute path of the `mod` folder to
`CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.
Separate several folders with the platform's path-list separator (`;` on
Windows, `:` elsewhere):

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:/Users/you/shell-progress/mod"
  }
}
```

The stall threshold is the `stallMinutes` setting, 10 by default. Change it
from the mod's row in the config menu, or in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "shell-progress": { "options": { "stallMinutes": 30 } }
  }
}
```

The `notifyMinutes` setting, 2 by default, is how long a successful job must
run before it raises a notification. It is changed the same way.

## Tests

The tests use only the Python 3.12 standard library. From the repository root:

```
python -m unittest discover -s tests -q
```

The Bash tests need `bash` on `PATH` and the PowerShell tests need
`powershell` (Windows PowerShell 5.1). A suite whose interpreter is missing is
skipped. On Windows, run them from Git Bash: in PowerShell or cmd, `bash` is
usually the WSL launcher, which cannot use the Windows temporary paths the
tests pass it, and most Bash tests fail.

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
