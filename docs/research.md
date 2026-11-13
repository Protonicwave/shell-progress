# Progress bars for background scripts

## Recommendation

Build the panel as a Claude Code mod, and have the same mod mirror a one-line summary into the status line. The panel shows every job with its own bar, step and elapsed time. The status line covers the times the panel is not drawn, which happens whenever the terminal is too narrow. Both read the same progress files, so the second view costs about ten lines once the first exists.

A status line on its own is less work, but it has room for one job at a time. A panel on its own goes blank in a narrow window. Doing both from the same files avoids each of those problems.

## What the panel has to know

For each job the panel needs three facts: that it started, how far it has got, and how it ended. Claude Code does not supply the second fact, because a background shell only reports that a command is still running. The script has to report its own position, so the design starts with a small contract between scripts and the mod.

## The contract: one progress file per job

Each script writes a single line to its own file under `.claude/progress/` in the project:

```
7 12 compiling assets
```

The first number is the current step, the second is the total and the rest is a label. A script that cannot count its steps writes `0 0` and a label, and the panel draws a spinner with elapsed time instead of a bar. When the script exits, it writes `done 0`, or `done` with the non-zero exit code if it failed.

The script overwrites the file on every update instead of appending to it. It writes to a temporary file and renames it over the old one, so the panel never reads half a line. The file never grows past a few dozen bytes, which keeps well inside the 4 MiB limit on `$.fs.read`.

A helper hides this from the scripts. In Bash:

```bash
# source scripts/progress.sh, then call: progress 7 12 "compiling assets"
PROGRESS_FILE=".claude/progress/$(basename "$0")-$$.txt"
mkdir -p .claude/progress
progress() { printf '%s %s %s\n' "$1" "$2" "$3" > "$PROGRESS_FILE.tmp" && mv -f "$PROGRESS_FILE.tmp" "$PROGRESS_FILE"; }
trap 'printf "done %s\n" "$?" > "$PROGRESS_FILE"' EXIT
```

PowerShell scripts get the same three steps: a function that writes the line with `Set-Content` and moves it into place, and a `try`/`finally` block that writes the `done` line. With the job named after the script and its process id, two runs of the same script appear as two rows.

Because the files are the interface, the panel also shows scripts started from a separate terminal, not only the ones Claude starts. It does not need to know which tool launched them.

## How the mod reads and draws it

A mod is a folder with a manifest and one TypeScript module, loaded into the session without restarting it. The calls below come from the programming interface (API) type definitions that ship with Claude Code 2.1.323.

- Polling: `$.clock.every(500, ...)` lists `.claude/progress/` with `$.fs.list` and reads each file with `$.fs.read`. A new file is a new job, and a `done` line moves the job to the finished group.
- State: the jobs live in an `atom`. Writing to it with `update` redraws only the views that read it.
- The panel: `$.ui.open({ id: 'progress', title: 'Background jobs' })` asks for the pane, and a `ui.render` hook on `{ component: 'Pane', requestId: 'progress' }` draws it with the surface's `Box` and `Text` elements. The bars are block characters, `█` for full cells and the eighth blocks `▏` to `▉` for the partial cell, so they move smoothly in a terminal.
- The command: `$.command.register` adds `/progress`, which opens the pane on demand.
- The status line: the same timer calls `$.ui.status('build 58% · tests 12/48 · 1 more')`, and clears it with `$.ui.status(undefined)` once nothing is running.
- Clean-up: the mod API can read and write files but not delete them, so the helper deletes finished files older than a day each time a script starts. The mod also ignores any finished job that ended before the session began.

## Where the panel can appear

Width decides it. When the mod opens the pane by itself, the terminal waits for 144 columns before docking it beside the transcript, or 110 if you have opened this pane before. When you open it yourself with `/progress`, it is drawn at any width. In a split or snapped window the status-line mirror is what you will actually look at.

## Risks

The mod API is marked early access, and its reference warns that it changes between releases. A Claude Code update could break the mod until it is adjusted. The checker (`claude plugin validate`) and the type-check catch most such breaks before a session loads the mod.

Polling every 500 ms costs one directory listing and a read of a few small files, which is negligible. A script that dies without running its exit trap (killed outright, for example) leaves its file stuck at the last step. The panel should mark a job as stalled once its file has not changed for a set time. The right threshold depends on your slowest step, which I do not know yet.
