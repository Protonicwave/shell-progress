/** One progress line, as a script's helper last wrote it. */
export type ProgressLine =
  | {
      readonly kind: 'running'
      readonly startedSec: number
      /** At most `total` when `total` is above 0. */
      readonly step: number
      /** 0 when the script has no step count. */
      readonly total: number
      readonly label: string
    }
  | {
      readonly kind: 'finished'
      readonly startedSec: number
      /** Signed: Windows reports some failures with a negative code. */
      readonly exitCode: number
      readonly endedSec: number
    }

/** One progress file in the progress directory, and what was last read from it. */
export type Job = {
  /** The file's name, `<script>-<pid>.txt`, which identifies the job. */
  readonly file: string
  readonly script: string
  /** The process id in the file's name, as written: digits only. */
  readonly pid: string
  /** The file's modification time when its line was read. */
  readonly mtimeMs: number
  /** `null` when the file does not hold a valid progress line. */
  readonly line: ProgressLine | null
  /**
   * The label of the last running line read for this run, kept once it
   * finishes; empty when none was read or it had no label.
   */
  readonly lastLabel: string
}

/** A tool call of the main conversation that has started and not ended. */
export type RunningCall = {
  /** The call's `tool_use_id`. */
  readonly id: string
  readonly tool: string
  /** The one argument worth showing, or empty. */
  readonly argument: string
  readonly startedMs: number
}

export type EndedCall = RunningCall & {
  readonly endedMs: number
  /** True when the tool reported an error, the call was denied, or it rejected. */
  readonly hasFailed: boolean
}

export type ToolCalls = {
  /** Oldest first, so the last is the call shown as running now. */
  readonly running: readonly RunningCall[]
  /** Newest first. */
  readonly recent: readonly EndedCall[]
}

/** Whether the main conversation's turn is running, and how long the last one took. */
export type SessionTurn =
  | { readonly kind: 'running'; readonly startedMs: number }
  | {
      readonly kind: 'waiting'
      /** `null` before the first turn ends. */
      readonly lastDurationMs: number | null
    }

declare module 'claude-code' {
  interface PluginState {
    'shell-progress': {
      jobs: Shaped<readonly Job[]>
      hasOpenedPane: boolean
      /** The file of the job whose row is expanded, or `null` when none is. */
      expandedJob: string | null
      /** The run keys of the jobs the person dismissed, oldest first. */
      dismissedJobs: readonly string[]
      /** The run keys of the failed jobs Claude has been asked about in this session. */
      askedJobs: readonly string[]
      toolCalls: Shaped<ToolCalls>
      sessionTurn: Shaped<SessionTurn>
    }
  }
}
