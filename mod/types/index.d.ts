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

/** A subagent or teammate of the session, as the pane lists it. */
export type ListedAgent = {
  /** Its id in `$.agent.list()`, which `$.ui.view` takes. */
  readonly id: string
  /** Its description, else its name, else its type. */
  readonly label: string
  /**
   * The engine's AgentStatus, spelt out because this file may not import: a
   * status the engine adds fails the type-check where the mod copies it.
   */
  readonly status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
}

/** How a background shell ended, as its notification said; `ended` for a word the mod does not know. */
export type ShellEnd = 'completed' | 'failed' | 'stopped' | 'ended'

/** A shell command the main conversation moved to the background. */
export type BackgroundShell = {
  /** The call's `backgroundTaskId`, which its notification names as `<task-id>`. */
  readonly id: string
  readonly tool: string
  /** The command's first line, or empty. */
  readonly command: string
  /** When the call started, which for a command backgrounded mid-run is before it was. */
  readonly startedMs: number
  readonly state:
    | { readonly kind: 'running' }
    /** Missing from the in-flight list at a turn's end before its notification came. */
    | { readonly kind: 'gone'; readonly endedMs: number }
    | { readonly kind: 'ended'; readonly end: ShellEnd; readonly endedMs: number }
}

/** What a finished agent took, from the Agent tool's result. */
export type AgentCost = {
  /** The agent's id, the same in the Agent tool's result and `$.agent.list()`. */
  readonly id: string
  readonly durationMs: number
  readonly tokens: number
}

/** The main conversation's context at the start of the running turn, and what the last finished turn added. */
export type TurnContext = {
  /** Tokens when the running turn started; `null` when no turn runs or none had been counted yet. */
  readonly startTokens: number | null
  /** Negative when the turn compacted the context; `null` when either reading was missing. */
  readonly lastAddedTokens: number | null
}

/** The five-hour limit as it stood when a main turn ended. */
export type LimitReading = {
  readonly atMs: number
  readonly percentUsed: number
  /** When the window the reading belongs to resets. */
  readonly resetsMs: number
}

/** Whether the main conversation's turn is running, and how long the last one took. */
export type SessionTurn =
  | { readonly kind: 'running'; readonly startedMs: number }
  | {
      readonly kind: 'waiting'
      /** `null` before the first turn ends. */
      readonly lastDurationMs: number | null
    }

/** One reading of the machine, as the sampler wrote it. */
export type MachineSample = {
  /** When the mod read it. */
  readonly atMs: number
  /** Task Manager's CPU figure before its cap: above 100 while the CPU runs above base speed. */
  readonly cpuPercent: number
  /** The CPU's speed against its base speed: under 100 when it is held back. */
  readonly cpuSpeedPercent: number
  /** The busiest adapter's 3D engines; `null` where Windows has no GPU counters. */
  readonly gpuPercent: number | null
  readonly freeMemoryBytes: number
  readonly power:
    | { readonly kind: 'mains' }
    /** `percentLeft` is `null` when Windows does not know the charge. */
    | { readonly kind: 'battery'; readonly percentLeft: number | null }
  /** When the sampler read the processes, by its own clock. */
  readonly sampledMs: number
  /** Logical processors, which a share of all cores is taken against. */
  readonly cpuCount: number
  /** `null` where Windows has no Process V2 counters. */
  readonly processes: readonly ProcessReading[] | null
}

/** One process in a sampler reading. */
export type ProcessReading = {
  readonly pid: number
  /** The process that created it, which may have ended and its pid been reused since. */
  readonly parentPid: number
  /** CPU time since it started, summed over all cores. */
  readonly cpuMs: number
  readonly startedMs: number
}

/** The sampler's last two readings, so CPU can be taken between them. */
export type MachineReadings = {
  /** `null` until the sampler's second reading. */
  readonly previous: MachineSample | null
  readonly current: MachineSample
}

/** What a running job's process tree is doing, between the last two readings. */
export type ProcessState =
  | { readonly kind: 'ended' }
  /** Busy from BUSY_JOB_CPU_PERCENT; `cpuPercent` is a share of all cores. */
  | { readonly kind: 'busy' | 'idle'; readonly cpuPercent: number }

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
      turnContext: Shaped<TurnContext>
      /** Oldest first. */
      limitReadings: Shaped<readonly LimitReading[]>
      /** In the order the mod first saw them, oldest first. */
      agents: Shaped<readonly ListedAgent[]>
      /** Oldest first. */
      agentCosts: Shaped<readonly AgentCost[]>
      /** Oldest first. */
      backgroundShells: Shaped<readonly BackgroundShell[]>
      /** The usage figures the prompt hint ends with, or `null` while it shows none. */
      hintUsage: string | null
      /** `null` before the sampler's first reading. */
      machineReadings: Shaped<MachineReadings | null>
    }
  }
}
