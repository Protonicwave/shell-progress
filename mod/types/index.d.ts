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
}

declare module 'claude-code' {
  interface PluginState {
    'shell-progress': {
      jobs: Shaped<readonly Job[]>
      hasOpenedPane: boolean
      /** The file of the job whose row is expanded, or `null` when none is. */
      expandedJob: string | null
      /** The dismissal keys of the jobs the person dismissed, oldest first. */
      dismissedJobs: readonly string[]
    }
  }
}
