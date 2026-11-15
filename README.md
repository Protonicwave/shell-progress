# shell-progress

Helpers that let a script report its progress, and a Claude Code mod that
draws a bar per job in a pane beside the chat, under the tool Claude is
running. There is one helper for Bash and
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
script therefore write two files. The pid is the one Windows tools show: under
Git Bash and Cygwin the Bash helper reads it from `/proc/$$/winpid`, because
`$$` there is the emulation layer's own number, and elsewhere it uses `$$`.
The start time is captured once, when the
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

The pane is titled This session. Its first line shows the tool call Claude is
running, such as `Bash npm test`, with how long it has run, or `Thinking`
between calls, or once the turn ends, `Waiting for you` and how long the turn
took. While a turn runs the header shows its time. If the mod is reloaded
during a turn, that time stops moving until the next turn starts, unless a
running job keeps the pane redrawing. Below come the jobs, then
Agents, then Recent: the last three calls, newest first, each with how long it
took, and in red when it failed. Only the main conversation's calls are shown,
not a subagent's. A call another mod makes through `$.tool.call` on the main
conversation is shown as if Claude had made it. A group with nothing in it is
not drawn.

Agents lists the session's subagents and teammates, newest first, each with its
task and whether it is running, waiting, completed or failed. Past five, the
rest are counted. Pressing an agent's task shows its transcript in the main
view, as the tasks list does; a toast says why when it cannot, for example
for a teammate that runs in a terminal pane of its own. An agent leaves the
list when Claude Code stops tracking it, shortly after it ends. Once an agent
that Claude waited on has finished, a dim row under it gives its time and
tokens, such as `0m 40s · 65k tokens`, from the Agent tool's result. An agent
started in the background has no such row: the tool answers when it starts,
before it has used either.

At the foot of the pane, a bar shows how full the context window is, such as
`38% · 76k of 200k`, and another how much of the five-hour usage limit is used
and when it resets, such as `63% · resets 16:00`. Each bar shares a row with
its label and figures; in a pane narrower than 40 columns it takes a row of
its own under them. Either bar takes the theme's warning colour from 80%.
Below them is the session's cost so far, as `/cost` totals it. A figure Claude
Code does not have is left out: the context bar appears after the session's
first response, and the limit bar only on a subscription.

Once a turn has ended, the context figures end with what it added to the
context, such as `+12k`, or `-61k` for a turn that compacted it. A turn that
added under 500 tokens shows nothing. The mod also reads the five-hour limit
at the end of each turn. When the rate between the newest reading and one at
least 5 minutes older says the limit fills before it resets, its figures give
that time in the warning colour instead of the reset, such as
`82% · full by 14:39`.

While a job is running, a machine row above the bars gives the CPU,
GPU and free memory, such as `cpu 34% · gpu 5% · 11.2 GB free`, as Task
Manager counts them: the CPU against its base speed and capped at 100%, the
GPU as its busiest adapter's 3D engines, and memory in gibibytes, which
Windows calls GB. A machine without GPU Engine counters has no GPU figure.
Under the readings, in the warning colour, `held at 78% speed` says a CPU at
50% or more is running below its base speed, as heat or a power plan holds it
back, and `on battery, 41%` says the laptop is off mains.

The readings come from `mod/hooks/sampler.ps1`, one Windows PowerShell process
that reads Windows performance counters, every process's among them, every 5
seconds. The mod starts it with the first running job and stops it after the
last; a file that does not hold a progress line does not count, and a stalled
job does until it is dismissed. A reading older than 15 seconds is not shown.
When the sampler cannot start, as on a machine without Windows PowerShell, or
exits, writes a line the mod cannot read or writes nothing for 30 seconds, the
mod logs why, once for a lasting fault, leaves the row out, and starts it
again at most once a minute while a job runs.

While the pane is closed, waiting for a wider terminal, or behind another
pane, the same figures follow Claude Code's prompt hint, the line with the
permission mode, drawn dim: `ctx 38% · 5h 63% · $1.84`. They leave the hint
when the pane comes back into view, so each figure is on screen once. The mod
adds them after the hint rather than rewriting it, so the permission mode
keeps its colour and the agent count stays live. Only the terminal draws
them, and a row too narrow for the whole hint cuts them short. They stay off
the mod's status line, which Claude Code draws in its warning colour.

Under Jobs, the pane lists each running job with a bar, its step and total, its label and
the time since it started. From its third step a job also shows about how long
it has left, from its average time per step so far, until it reaches its last
step, which can take any time. A job with no step count
shows a spinner instead of a bar. A running job whose file has not changed for
10 minutes is marked stalled, with how long it ran before its file went quiet,
which is how a script that was killed before it could write its finished line
shows. Under a Finished heading come the five newest jobs that ended during the
session, with how long each took and, for a failure, its exit code. A file
that does not hold a progress line shows as `unreadable progress line`.

While the sampler runs, a running job's first row also gives the CPU its
processes used between the last two readings, such as `cpu 12% · 7/12  58%`:
the process whose id names the job's file and every process descended from
it, as CPU time over elapsed time on all logical processors. A
single-threaded job at full speed on 8 of them reads about 12%. The machine
row measures against the base clock speed, so while the CPU runs faster than
that, its figure is above the sum of the jobs'. A pane under 40 columns
leaves the job's figure out. A stalled job whose process has ended, or whose
id now names a process started after the job, reads `process ended`, at any
width. A process that outlives the parent that started it, as a detached
daemon does, is not counted.

A job whose file has gone unchanged for the stall time while its processes
use 5% or more of all logical processors is quiet, not stalled: its row reads
`quiet 11m 00s · busy`, with how long since its file last changed, and the
heading and status line count it as running. Once its processes fall below
5%, or the sampler stops, it is stalled.

Pressing a job's name expands its row to the path of its progress file, its
process id, the time it started and, once finished, its exit code. Pressing it
again, or another job's name, collapses it. An expanded stalled or finished
job has a Dismiss button, which hides the job from the pane in this session and
later ones. The Jobs heading then counts the hidden jobs, and pressing the
count shows them all again. A later run that writes to the same file name is a
new job and shows. A dismissed stalled job whose script turns out to be alive
stays hidden while it runs on and when it finishes.

An expanded failed job also has an Ask Claude button, which sends Claude a
prompt naming the script, how long it ran, its exit code and the last step it
reported, and asks why it failed. The last step is the label the script
wrote, copied as it stands, so anything that can write to the progress
directory chooses part of that prompt. If Claude is working, the prompt waits for
the current turn to end. The button then reads Asked Claude for the rest of the
session, unless the prompt was refused, in which case it returns.

The pane opens by itself when a session starts, if the terminal is at least
144 columns wide. It does not open by itself again in that session once
closed. `/progress` opens it at any width. Docked beside the transcript it
opens 48 columns wide, or at the width you last dragged it to. While a job runs,
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

The sampler has a CPU budget of 600 ms a minute, 1% of one core. On Windows,
this runs it for a minute after its start-up and exits 1 when it uses more:

```
python tests/measure_sampler.py
```
