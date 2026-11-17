import type { BackgroundShell, ShellEnd } from '../types'

// Past this many the oldest ended shell is dropped first, then the oldest
// running one, so a session that backgrounds many commands cannot grow the
// list without bound.
const MAX_KEPT_SHELLS = 20
/** Running shells beyond this many, the oldest, are counted rather than drawn. */
const MAX_SHOWN_RUNNING_SHELLS = 5
/** How many of the newest ended shells the pane lists under the running ones. */
const MAX_SHOWN_ENDED_SHELLS = 3

const NOTIFICATION_PATTERN = /<task-notification>([\s\S]*?)<\/task-notification>/g
const TASK_ID_PATTERN = /<task-id>([^<]+)<\/task-id>/
const STATUS_PATTERN = /<status>([^<]+)<\/status>/

/** A background task's notification: its id and the status word it gave, if any. */
export type TaskNotice = {
  readonly id: string
  readonly status: string | undefined
}

/** One row of the Shells group. */
export type ShellRow = {
  readonly id: string
  /** The command's first line, else the tool's name. */
  readonly label: string
  readonly status: 'running' | ShellEnd
  /** How long it has run, or ran. */
  readonly durationMs: number
}

/** The running shells newest first, then the newest ended ones, and how many running ones are left out. */
export type ShellRows = {
  readonly rows: readonly ShellRow[]
  readonly moreRunningCount: number
}

/**
 * The background task id of a shell call's result: set when the command ran
 * on in the background, by its own request, by Ctrl+B or after a timeout.
 * `undefined` for a foreground call or a result of another shape.
 */
export function backgroundTaskIdOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null || !('backgroundTaskId' in result)) return undefined
  const id = result.backgroundTaskId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** Adds `shell` as the newest, in place of any earlier one with its id. */
export function recordShellStart(
  shells: readonly BackgroundShell[],
  shell: BackgroundShell,
): readonly BackgroundShell[] {
  return boundShells([...shells.filter(one => one.id !== shell.id), shell])
}

/**
 * The notifications a `task-notification` prompt carries, in order. A block
 * without a task id is left out; one prompt may carry several.
 */
export function taskNoticesIn(text: string): readonly TaskNotice[] {
  return [...text.matchAll(NOTIFICATION_PATTERN)].flatMap(([, body = '']) => {
    const id = TASK_ID_PATTERN.exec(body)?.[1]?.trim()
    if (id === undefined || id === '') return []
    return [{ id, status: STATUS_PATTERN.exec(body)?.[1]?.trim() }]
  })
}

/**
 * Ends each shell a notice names, at `nowMs`, when it is running or only
 * known to be gone. A notice for an id the mod never recorded, or for a shell
 * already ended by a notice, changes nothing. Gives back `shells` itself when
 * nothing changed.
 */
export function recordShellEnds(
  shells: readonly BackgroundShell[],
  notices: readonly TaskNotice[],
  nowMs: number,
): readonly BackgroundShell[] {
  const ends = new Map(notices.map(notice => [notice.id, shellEndOf(notice.status)]))
  let hasChanged = false
  const updated = shells.map(shell => {
    const end = ends.get(shell.id)
    if (end === undefined || shell.state.kind === 'ended') return shell
    hasChanged = true
    return { ...shell, state: { kind: 'ended', end, endedMs: nowMs } } as const
  })
  return hasChanged ? updated : shells
}

/**
 * Marks gone, at `nowMs`, each running shell whose id is not in `inFlightIds`,
 * the background work a turn's end reported still running. Gives back
 * `shells` itself when nothing changed.
 */
export function settleShells(
  shells: readonly BackgroundShell[],
  inFlightIds: ReadonlySet<string>,
  nowMs: number,
): readonly BackgroundShell[] {
  let hasChanged = false
  const updated = shells.map(shell => {
    if (shell.state.kind !== 'running' || inFlightIds.has(shell.id)) return shell
    hasChanged = true
    return { ...shell, state: { kind: 'gone', endedMs: nowMs } } as const
  })
  return hasChanged ? updated : shells
}

export function hasRunningShell(shells: readonly BackgroundShell[]): boolean {
  return shells.some(shell => shell.state.kind === 'running')
}

/** What the Shells group lists at `nowMs`. */
export function shellRows(shells: readonly BackgroundShell[], nowMs: number): ShellRows {
  const newestFirst = [...shells].reverse()
  const running = newestFirst.filter(shell => shell.state.kind === 'running')
  const ended = newestFirst.filter(shell => shell.state.kind !== 'running')
  const shown = [...running.slice(0, MAX_SHOWN_RUNNING_SHELLS), ...ended.slice(0, MAX_SHOWN_ENDED_SHELLS)]
  return {
    rows: shown.map(shell => shellRow(shell, nowMs)),
    moreRunningCount: Math.max(0, running.length - MAX_SHOWN_RUNNING_SHELLS),
  }
}

function shellRow(shell: BackgroundShell, nowMs: number): ShellRow {
  const label = shell.command === '' ? shell.tool : shell.command
  const { state } = shell
  switch (state.kind) {
    case 'running':
      return { id: shell.id, label, status: 'running', durationMs: nowMs - shell.startedMs }
    case 'gone':
      return { id: shell.id, label, status: 'ended', durationMs: state.endedMs - shell.startedMs }
    case 'ended':
      return { id: shell.id, label, status: state.end, durationMs: state.endedMs - shell.startedMs }
    default:
      return state satisfies never
  }
}

function shellEndOf(status: string | undefined): ShellEnd {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'stopped'
    default:
      return 'ended'
  }
}

/** Drops the oldest ended shells, then the oldest running ones, down to MAX_KEPT_SHELLS. */
function boundShells(shells: readonly BackgroundShell[]): readonly BackgroundShell[] {
  const excess = shells.length - MAX_KEPT_SHELLS
  if (excess <= 0) return shells
  const dropped = new Set(
    shells
      .filter(shell => shell.state.kind !== 'running')
      .slice(0, excess)
      .map(shell => shell.id),
  )
  return shells.filter(shell => !dropped.has(shell.id)).slice(-MAX_KEPT_SHELLS)
}
