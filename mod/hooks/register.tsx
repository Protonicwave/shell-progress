import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, Register, Timer } from 'claude-code'

import type { Job, ListedAgent, RunningCall, SessionTurn } from '../types'
import type { FinishedJob } from './progress'
import { PANE_ID, PANE_TITLE, drawPane } from './pane'
import { POLL_INTERVAL_MS, pollJobs } from './poll'
import {
  announcementText,
  askClaudeText,
  runKey,
  finishedSince,
  isStalled,
  isWorthNotifying,
  statusSummary,
} from './progress'
import {
  NO_TOOL_CALLS,
  endTurnCalls,
  mergeAgents,
  recordEnd,
  recordStart,
  toolArgumentText,
} from './session'

const COMMAND_NAME = 'progress'
// A poll still running after this long is logged, once, as stuck.
const STUCK_POLL_MS = 30_000
const MS_PER_MINUTE = 60_000
const SECONDS_PER_MINUTE = 60
const DISMISSED_STORE_KEY = 'dismissedJobs'
// A run key names one run, so an old key never hides a new job; past
// this many, the oldest are dropped, which only brings their jobs back.
const MAX_DISMISSED_JOBS = 200

// Change the tag when Job's fields change: it declines what an earlier
// version stored, which outlives a reload.
const jobs = atom({ plugin: 'shell-progress', key: 'jobs' } as const, [], {
  shape: 'jobs-3',
})
// Set once the pane has opened by itself, so a person who closes it is not
// shown it again when the module reloads.
const hasOpenedPane = atom({ plugin: 'shell-progress', key: 'hasOpenedPane' } as const, false)
const expandedJob = atom({ plugin: 'shell-progress', key: 'expandedJob' } as const, null)
// Loaded from the plugin's store at session start and written back on each
// change, so a dismissed job stays hidden in later sessions.
const dismissedJobs = atom({ plugin: 'shell-progress', key: 'dismissedJobs' } as const, [])
// One key per press of a button that then goes, so it stays small without a cap.
const askedJobs = atom({ plugin: 'shell-progress', key: 'askedJobs' } as const, [])
// Shaped like `jobs`, so a later change to their types declines what this
// version stored.
const toolCalls = atom({ plugin: 'shell-progress', key: 'toolCalls' } as const, NO_TOOL_CALLS, {
  shape: 'tool-calls-1',
})
const sessionTurn = atom(
  { plugin: 'shell-progress', key: 'sessionTurn' } as const,
  { kind: 'waiting', lastDurationMs: null },
  { shape: 'session-turn-1' },
)
const agents = atom({ plugin: 'shell-progress', key: 'agents' } as const, [], { shape: 'agents-1' })

export const register: Register = (on, options) => {
  const stallMs = positiveMinutesOf(options, 'stallMinutes') * MS_PER_MINUTE
  const notifySeconds = positiveMinutesOf(options, 'notifyMinutes') * SECONDS_PER_MINUTE

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND_NAME,
      description: 'Show the session pane',
    })
    await loadDismissedJobs($)
    startPolling($, await progressDir($), stallMs, notifySeconds)
    if (!(await read($, hasOpenedPane))) await openPaneOnce($)
    return next(e)
  })

  followSession(on)

  on('command.run', { command: COMMAND_NAME }, async $ => {
    const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    return {
      text: opened.isPlaced
        ? 'Session pane opened.'
        : `Session pane opened but not shown: ${opened.reason}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const [jobList, dir, expanded, dismissed, asked, calls, turn, agentList, nowMs, usage] =
      await Promise.all([
        read($, jobs),
        progressDir($),
        read($, expandedJob),
        read($, dismissedJobs),
        read($, askedJobs),
        read($, toolCalls),
        read($, sessionTurn),
        read($, agents),
        $.clock.now(),
        $.session.usage(),
      ])
    return drawPane($.ui.resolve(e), {
      jobs: jobList,
      progressDir: dir,
      expandedJob: expanded,
      dismissedJobs: new Set(dismissed),
      askedJobs: new Set(asked),
      bodyColumns: e.props.bodyColumns,
      nowMs,
      usage,
      stallMs,
      actions: paneActions($),
      toolCalls: calls,
      turn,
      agents: agentList,
    })
  })
}

/**
 * Records the main conversation's turns and tool calls for the pane. A
 * subagent's are left to its own row: listed here they would crowd out the
 * main conversation's.
 */
function followSession(on: On): void {
  // Moves the pane's timers on while a turn runs. Kept by this copy of the
  // module, which drops it on reload; the next turn starts another.
  let turnTimer: Timer | undefined

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const startedMs = await $.clock.now()
    await update($, sessionTurn, (): SessionTurn => ({ kind: 'running', startedMs }))
    turnTimer ??= $.clock.every(POLL_INTERVAL_MS, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    turnTimer?.cancel()
    turnTimer = undefined
    await update($, sessionTurn, (): SessionTurn => ({ kind: 'waiting', lastDurationMs: e.durationMs }))
    await update($, toolCalls, endTurnCalls)
    return next(e)
  })

  // Only times the call: the result and any rejection pass through unchanged.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const call: RunningCall = {
      id: e.tool_use_id,
      tool: e.tool,
      argument: toolArgumentText(e.tool, e),
      startedMs: await $.clock.now(),
    }
    await update($, toolCalls, calls => recordStart(calls, call))
    let hasFailed = true
    try {
      const result = await next(e)
      hasFailed = result.deny !== undefined || result.isError === true
      return result
    } finally {
      const endedMs = await $.clock.now()
      await update($, toolCalls, calls => recordEnd(calls, { ...call, endedMs, hasFailed }))
    }
  })
}

function paneActions($: EngineInterface) {
  return {
    toggleJob: async (file: string) => {
      await update($, expandedJob, current => (current === file ? null : file))
    },
    dismissJob: async (key: string) => {
      await update($, expandedJob, () => null)
      await changeDismissedJobs($, keys => [...keys.filter(one => one !== key), key])
    },
    showHiddenJobs: () => changeDismissedJobs($, () => []),
    askClaude: async (job: FinishedJob) => {
      const key = runKey(job)
      // Two presses before a redraw both land here; only the one that adds the
      // key asks. `update` may run the change again on a missed write, so the
      // run that lands sets the flag last.
      let isFirstPress = false
      await update($, askedJobs, keys => {
        isFirstPress = !keys.includes(key)
        return isFirstPress ? [...keys, key] : keys
      })
      if (!isFirstPress) return
      // Not awaited: a prompt sent while Claude works waits for the session to
      // go idle, and the press should not wait with it.
      void submitQuestion($, job, key)
    },
    viewAgent: async ({ id, label }: ListedAgent) => {
      const shown = await $.ui.view({ agentId: id })
      if (shown.deny !== undefined) $.ui.toast(`Cannot show ${label}: ${shown.deny}`)
    },
  }
}

/**
 * Asks Claude about `job`, and forgets that it was asked if the prompt does
 * not enter, so its button shows again. Settles without rejecting.
 */
async function submitQuestion($: EngineInterface, job: FinishedJob, key: string): Promise<void> {
  let hasEntered = false
  try {
    hasEntered = (await $.prompt.submit({ text: askClaudeText(job) })).drop === undefined
  } catch (error: unknown) {
    // Nothing awaits this promise, so the failure is logged here, once.
    $.ui.log(`shell-progress: cannot ask Claude about ${job.script}: ${errorMessage(error)}`)
  }
  if (!hasEntered) await update($, askedJobs, keys => keys.filter(one => one !== key))
}

async function loadDismissedJobs($: EngineInterface): Promise<void> {
  const stored = await $.store.get(DISMISSED_STORE_KEY)
  const isValid = stored === undefined || isStringList(stored)
  if (!isValid) {
    // Only this mod writes the key, so another value is a hand edit; the next
    // dismissal replaces it.
    $.ui.log(`shell-progress: ignoring ${DISMISSED_STORE_KEY} in the store: expected a list of strings`)
  }
  await update($, dismissedJobs, () => (isStringList(stored) ? stored : []))
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

async function changeDismissedJobs(
  $: EngineInterface,
  change: (keys: readonly string[]) => readonly string[],
): Promise<void> {
  const keys = await update($, dismissedJobs, current => change(current).slice(-MAX_DISMISSED_JOBS))
  await $.store.set(DISMISSED_STORE_KEY, keys)
}

function positiveMinutesOf(options: PluginOptions, name: 'stallMinutes' | 'notifyMinutes'): number {
  const minutes = options[name]
  if (typeof minutes !== 'number' || !(minutes > 0)) {
    throw new Error(`expected ${name} to be a positive number, got ${String(minutes)}`)
  }
  return minutes
}

/** Where the helpers write: the same rule as theirs, with the session root for their working directory. */
async function progressDir($: EngineInterface): Promise<string> {
  const configured = await $.env.get('CLAUDE_PROGRESS_DIR')
  if (configured !== undefined && configured !== '') return configured
  return `${await $.session.root()}/.claude/progress`
}

function startPolling(
  $: EngineInterface,
  dir: string,
  stallMs: number,
  notifySeconds: number,
): void {
  // `null` until the first poll, so a reload always replaces whatever the
  // previous copy of the module left on the status line.
  let shownStatus: string | undefined | null = null
  const jobsFailure = failureLog($, `cannot poll ${dir}`)
  const agentsFailure = failureLog($, 'cannot list agents')
  // Separate, so a hung agent list cannot hold up the jobs, or the reverse.
  const tickJobs = unlessUnsettled($, `a poll of ${dir}`, () =>
    pollOnce($, dir, stallMs, notifySeconds).then(summary => {
      jobsFailure.clear()
      if (summary === shownStatus) return
      shownStatus = summary
      $.ui.status(summary)
    }, jobsFailure.record),
  )
  // On a failure the stored agents stay, so the pane keeps the last list.
  const tickAgents = unlessUnsettled($, 'a listing of agents', () =>
    pollAgents($).then(agentsFailure.clear, agentsFailure.record),
  )

  // The timer lives until the module reloads, which drops it with the
  // environment, so nothing needs to cancel it.
  $.clock.every(POLL_INTERVAL_MS, () => {
    tickJobs()
    tickAgents()
  })
}

/**
 * A tick that starts `work` unless its last run has not settled, so runs never
 * overlap. `work` must not reject. Neither fs calls nor `agent.list` take a
 * timeout, so a hung run cannot be cancelled: it is left to settle, and once
 * it has run for STUCK_POLL_MS the log says, once, why the pane stopped moving.
 */
function unlessUnsettled($: EngineInterface, work: string, run: () => Promise<void>): () => void {
  let isRunning = false
  let skippedTicks = 0
  return () => {
    if (isRunning) {
      skippedTicks += 1
      if (skippedTicks === Math.ceil(STUCK_POLL_MS / POLL_INTERVAL_MS)) {
        $.ui.log(`shell-progress: ${work} has not finished after ${STUCK_POLL_MS / 1000}s`)
      }
      return
    }
    isRunning = true
    skippedTicks = 0
    void run().finally(() => {
      isRunning = false
    })
  }
}

/**
 * Logs a failure of `work` once, and again only when the message changes or
 * after a success, so a lasting fault is one line rather than one a poll.
 */
function failureLog($: EngineInterface, work: string) {
  let loggedMessage: string | undefined
  return {
    clear: () => {
      loggedMessage = undefined
    },
    record: (error: unknown) => {
      const message = errorMessage(error)
      if (message === loggedMessage) return
      loggedMessage = message
      $.ui.log(`shell-progress: ${work}: ${message}`)
    },
  }
}

async function pollAgents($: EngineInterface): Promise<void> {
  const listed = await $.agent.list()
  const previous = await read($, agents)
  const merged = mergeAgents(previous, listed)
  if (merged !== previous) await update($, agents, () => merged)
}

async function pollOnce(
  $: EngineInterface,
  dir: string,
  stallMs: number,
  notifySeconds: number,
): Promise<string | undefined> {
  const previous = await read($, jobs)
  const current = await pollJobs($, dir, previous)
  if (current !== previous) await update($, jobs, () => current)

  // A dismissed job is gone from everything the poll drives, not only the pane.
  const dismissed = new Set(await read($, dismissedJobs))
  const shown = current.filter(job => !dismissed.has(runKey(job) ?? ''))
  const nowMs = await $.clock.now()
  const isAnyLive = shown.some(job => isLive(job, nowMs, stallMs))
  const finished = finishedSince(previous, shown)
  if (finished.length > 0) announceFinished($, finished, notifySeconds)

  // A running job's elapsed time and spinner move on every poll even when no
  // file changed, so the pane is drawn again while one runs. A stalled job's
  // row does not move, so it alone does not keep the pane redrawing.
  if (isAnyLive) $.ui.invalidate('ui.render')
  return statusSummary(shown, nowMs, stallMs)
}

/** One toast for the jobs that finished, and one notification for those worth one. */
function announceFinished(
  $: EngineInterface,
  finished: readonly FinishedJob[],
  notifySeconds: number,
): void {
  $.ui.toast(announcementText(finished))
  const notable = finished.filter(job => isWorthNotifying(job, notifySeconds))
  if (notable.length === 0) return
  // Not awaited, so a notification channel that hangs cannot hold up the
  // poll; both outcomes are settled here, and neither is retried.
  void $.ui.notify(announcementText(notable)).then(
    result => {
      if (!result.isSent) $.ui.log(`shell-progress: notification not sent: ${result.reason}`)
    },
    (error: unknown) => {
      $.ui.log(`shell-progress: notification failed: ${errorMessage(error)}`)
    },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isLive(job: Job, nowMs: number, stallMs: number): boolean {
  return job.line?.kind === 'running' && !isStalled(job, nowMs, stallMs)
}

async function openPaneOnce($: EngineInterface): Promise<void> {
  await update($, hasOpenedPane, () => true)
  // Too narrow a terminal leaves the pane unplaced, waiting for more width or
  // for /progress, which is the behaviour wanted, so the answer is not used.
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
}
