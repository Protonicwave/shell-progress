import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PluginOptions, ProcessSpawnResult, Register, Timer } from 'claude-code'

import type { Job, ListedAgent, MachineSample, ProcessState, RunningCall, SessionTurn } from '../types'
import { parseSample, processStates, takeLines } from './machine'
import type { FinishedJob } from './progress'
import { PANE_COLUMNS, PANE_ID, PANE_TITLE, drawPane } from './pane'
import { POLL_INTERVAL_MS, pollJobs } from './poll'
import {
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
  announcementText,
  askClaudeText,
  runKey,
  finishedSince,
  hasRunningJob,
  isDismissed,
  isStalled,
  isWorthNotifying,
  statusSummary,
} from './progress'
import {
  NO_TOOL_CALLS,
  NO_TURN_CONTEXT,
  agentCostOf,
  endTurnCalls,
  endTurnContext,
  mergeAgents,
  recordAgentCost,
  recordEnd,
  recordLimitReading,
  recordStart,
  startTurnContext,
  toolArgumentText,
  usageHintText,
} from './session'

const COMMAND_NAME = 'progress'
// A poll still running after this long is logged, once, as stuck.
const STUCK_POLL_MS = 30_000
const DISMISSED_STORE_KEY = 'dismissedJobs'
// A run key names one run, so an old key never hides a new job; past
// this many, the oldest are dropped, which only brings their jobs back.
const MAX_DISMISSED_JOBS = 200
// A width the person dragged the pane to wins over `columns`.
const PANE_REQUEST = { id: PANE_ID, title: PANE_TITLE, columns: PANE_COLUMNS } as const
// `tail` is drawn at the end of the engine's hint, so it brings its own
// separator.
const HINT_TAIL_SEPARATOR = ' · '
// A sampler that could not start, exited or wrote a bad line is started again
// at most this often, so a machine without Windows PowerShell costs one
// attempt a minute while a job runs.
const SAMPLER_RESTART_MS = 60_000
// A sampler that writes no line for this long, six of its intervals and room
// for a slow start, has hung, and is stopped and restarted as a failed one.
const MAX_SAMPLER_SILENCE_MS = 30_000
const SAMPLER_ARGV = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
const SAMPLER_SCRIPT = 'hooks/sampler.ps1'
// The end of what a failed sampler wrote to stderr goes in its log line,
// which is where PowerShell names the error.
const MAX_SAMPLER_ERROR_CHARS = 500

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
const turnContext = atom({ plugin: 'shell-progress', key: 'turnContext' } as const, NO_TURN_CONTEXT, {
  shape: 'turn-context-1',
})
const limitReadings = atom({ plugin: 'shell-progress', key: 'limitReadings' } as const, [], {
  shape: 'limit-readings-1',
})
const agents = atom({ plugin: 'shell-progress', key: 'agents' } as const, [], { shape: 'agents-1' })
const agentCosts = atom({ plugin: 'shell-progress', key: 'agentCosts' } as const, [], {
  shape: 'agent-costs-1',
})
// Written only when it changes, so the prompt hint is drawn again once per
// change rather than once a poll.
const hintUsage = atom({ plugin: 'shell-progress', key: 'hintUsage' } as const, null)
const machineReadings = atom({ plugin: 'shell-progress', key: 'machineReadings' } as const, null, {
  shape: 'machine-readings-1',
})

export const register: Register = (on, options) => {
  const stallMs = positiveMinutesOf(options, 'stallMinutes') * SECONDS_PER_MINUTE * MS_PER_SECOND
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
    const opened = await $.ui.open(PANE_REQUEST)
    return {
      text: opened.isPlaced
        ? 'Session pane opened.'
        : `Session pane opened but not shown: ${opened.reason}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const [
      jobList,
      dir,
      expanded,
      dismissed,
      asked,
      calls,
      turn,
      context,
      readings,
      agentList,
      costs,
      machine,
      nowMs,
      usage,
    ] = await Promise.all([
        read($, jobs),
        progressDir($),
        read($, expandedJob),
        read($, dismissedJobs),
        read($, askedJobs),
        read($, toolCalls),
        read($, sessionTurn),
        read($, turnContext),
        read($, limitReadings),
        read($, agents),
        read($, agentCosts),
        read($, machineReadings),
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
      turnContext: context,
      limitReadings: readings,
      agents: agentList,
      agentCosts: costs,
      machineSample: machine?.current ?? null,
      processStates: processStates(jobList, machine, nowMs),
    })
  })

  // Adds to the engine's hint rather than rewriting it, so the permission
  // mode keeps its colour and the agent count stays live.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const usageText = await read($, hintUsage)
    if (usageText === null) return next(e)
    const tail = `${e.props.tail ?? ''}${HINT_TAIL_SEPARATOR}${usageText}`
    return next({ ...e, props: { ...e.props, tail } })
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
    const [startedMs, usage] = await Promise.all([$.clock.now(), $.session.usage()])
    await update($, sessionTurn, (): SessionTurn => ({ kind: 'running', startedMs }))
    await update($, turnContext, context => startTurnContext(context, usage))
    turnTimer ??= $.clock.every(POLL_INTERVAL_MS, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    turnTimer?.cancel()
    turnTimer = undefined
    await update($, sessionTurn, (): SessionTurn => ({ kind: 'waiting', lastDurationMs: e.durationMs }))
    const [endedMs, usage] = await Promise.all([$.clock.now(), $.session.usage()])
    await update($, turnContext, context => endTurnContext(context, usage))
    await update($, limitReadings, readings => recordLimitReading(readings, usage, endedMs))
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

  // Any loop's, unlike the hooks above, so an agent a subagent started shows
  // its cost in the agents list too. The result passes through unchanged.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    // The matcher already selects Agent; the check types the result.
    if (e.tool !== 'Agent') return next(e)
    const result = await next(e)
    if (result.deny !== undefined || result.isError === true) return result
    const cost = agentCostOf(result.result)
    if (cost === undefined) return result
    // A cost that cannot be stored costs only its row, so the result still goes on.
    await update($, agentCosts, costs => recordAgentCost(costs, cost)).catch((error: unknown) => {
      $.ui.log(`shell-progress: cannot record an agent's cost: ${errorMessage(error)}`)
    })
    return result
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
  const keys = await storedDismissals($)
  await update($, dismissedJobs, () => keys)
}

/**
 * The dismissals the store holds. A store that cannot be read, or that holds
 * something else, is logged and gives none: the jobs matter more than which of
 * them were hidden.
 */
async function storedDismissals($: EngineInterface): Promise<readonly string[]> {
  let stored: unknown
  try {
    stored = await $.store.get(DISMISSED_STORE_KEY)
  } catch (error: unknown) {
    $.ui.log(`shell-progress: cannot read ${DISMISSED_STORE_KEY} from the store: ${errorMessage(error)}`)
    return []
  }
  if (stored === undefined || isStringList(stored)) return stored ?? []
  // Only this mod writes the key, so another value is a hand edit; the next
  // dismissal replaces it.
  $.ui.log(`shell-progress: ignoring ${DISMISSED_STORE_KEY} in the store: expected a list of strings`)
  return []
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
  const usageFailure = failureLog($, 'cannot read usage')
  const sampleWhile = machineSampler($)
  // Separate, so a hung job poll, agent list or usage reading cannot hold up
  // the others.
  const tickJobs = unlessUnsettled($, `a poll of ${dir}`, () =>
    pollOnce($, dir, stallMs, notifySeconds).then(polled => {
      jobsFailure.clear()
      sampleWhile(polled.hasRunningJob, polled.atMs)
      if (polled.status === shownStatus) return
      shownStatus = polled.status
      $.ui.status(polled.status)
    }, jobsFailure.record),
  )
  // On a failure the stored agents stay, so the pane keeps the last list.
  const tickAgents = unlessUnsettled($, 'a listing of agents', () =>
    pollAgents($).then(agentsFailure.clear, agentsFailure.record),
  )
  // On a failure the hint keeps the last figures.
  const tickUsage = unlessUnsettled($, 'a reading of usage', () =>
    pollHintUsage($).then(usageFailure.clear, usageFailure.record),
  )

  // The timer lives until the module reloads, which drops it with the
  // environment, so nothing needs to cancel it.
  $.clock.every(POLL_INTERVAL_MS, () => {
    tickJobs()
    tickAgents()
    tickUsage()
  })
}

function exitText(result: ProcessSpawnResult | undefined): string {
  if (result === undefined) return 'before it could be read'
  return result.signal === null ? `with code ${result.code}` : `on ${result.signal}`
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
        $.ui.log(`shell-progress: ${work} has not finished after ${STUCK_POLL_MS / MS_PER_SECOND}s`)
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

/** What one poll of the jobs found: the status line, whether a job is running, and when. */
type JobsPoll = {
  readonly status: string | undefined
  readonly hasRunningJob: boolean
  readonly atMs: number
}

async function pollOnce(
  $: EngineInterface,
  dir: string,
  stallMs: number,
  notifySeconds: number,
): Promise<JobsPoll> {
  const previous = await read($, jobs)
  const current = await pollJobs($, dir, previous)
  if (current !== previous) await update($, jobs, () => current)

  // A dismissed job is gone from everything the poll drives, not only the pane.
  const dismissed = new Set(await read($, dismissedJobs))
  const shown = current.filter(job => !isDismissed(job, dismissed))
  const nowMs = await $.clock.now()
  const states = processStates(shown, await read($, machineReadings), nowMs)
  const isAnyLive = shown.some(job => isLive(job, nowMs, stallMs, states))
  const finished = finishedSince(previous, shown)
  if (finished.length > 0) announceFinished($, finished, notifySeconds)

  // A running job's elapsed time and spinner move on every poll even when no
  // file changed, so the pane is drawn again while one runs. A stalled job's
  // row does not move, so it alone does not keep the pane redrawing.
  if (isAnyLive) $.ui.invalidate('ui.render')
  return {
    status: statusSummary(shown, nowMs, stallMs, states),
    hasRunningJob: hasRunningJob(shown, dismissed),
    atMs: nowMs,
  }
}

/**
 * Keeps one sampler running while `isWanted`, storing its last two readings
 * in `machineReadings`, and stops it when not. A sampler that cannot start,
 * exits, writes a bad line or writes nothing for MAX_SAMPLER_SILENCE_MS is
 * logged, once for a lasting fault, and started again on a later call at most
 * once every SAMPLER_RESTART_MS while it stays wanted.
 */
function machineSampler($: EngineInterface): (isWanted: boolean, nowMs: number) => void {
  const failure = failureLog($, 'cannot sample the machine')
  let running: SamplerRun | undefined
  let lastStartMs = Number.NEGATIVE_INFINITY
  let lastLineMs = Number.NEGATIVE_INFINITY
  return (isWanted, nowMs) => {
    if (!isWanted) {
      running?.stop()
      running = undefined
      // The next job starts a sampler at once, even after a failed one.
      lastStartMs = Number.NEGATIVE_INFINITY
      return
    }
    if (running !== undefined && nowMs - lastLineMs > MAX_SAMPLER_SILENCE_MS) {
      running.stop()
      running = undefined
      failure.record(new Error(`the sampler wrote nothing for ${MAX_SAMPLER_SILENCE_MS / MS_PER_SECOND}s`))
    }
    if (running !== undefined || nowMs - lastStartMs < SAMPLER_RESTART_MS) return
    lastStartMs = nowMs
    lastLineMs = nowMs
    const run = startSampler($, atMs => {
      lastLineMs = atMs
      failure.clear()
    })
    running = run
    // Settles without rejecting, so nothing else need wait on it.
    void run.ended
      .then(undefined, failure.record)
      .finally(() => {
        if (running === run) running = undefined
      })
  }
}

type SamplerRun = {
  readonly stop: () => void
  /** Settles once the sampler is stopped; rejects, saying why, when it fails or exits by itself. */
  readonly ended: Promise<void>
}

function startSampler($: EngineInterface, onSample: (atMs: number) => void): SamplerRun {
  const child = $.process.spawn({ argv: [...SAMPLER_ARGV, `${$.plugin.root}/${SAMPLER_SCRIPT}`] })
  // Rejects when the stream is closed before the child exits, as a stop or a
  // bad line closes it; neither needs the exit code, so that is not a fault.
  const exit = child.result.catch(() => undefined)
  let isStopped = false
  const ended = (async () => {
    let rest = ''
    let errorText = ''
    // Each run converts process start times on its own, to the millisecond,
    // so a reading is paired only with the one before it in the same run.
    let previous: MachineSample | null = null
    for await (const { stream, text } of child) {
      if (stream === 'stderr') {
        errorText = `${errorText}${text}`.slice(-MAX_SAMPLER_ERROR_CHARS)
        continue
      }
      const taken = takeLines(rest, text)
      rest = taken.rest
      for (const line of taken.lines) {
        const sample = parseSample(line, await $.clock.now())
        const readings = { previous, current: sample }
        await update($, machineReadings, () => readings)
        previous = sample
        onSample(sample.atMs)
      }
    }
    if (isStopped) return
    // PowerShell spreads an error over several lines; the log takes one.
    const said = errorText.replace(/\s+/g, ' ').trim()
    throw new Error(`the sampler exited ${exitText(await exit)}${said === '' ? '' : `: ${said}`}`)
  })()
  return {
    stop: () => {
      isStopped = true
      // Ending the stream kills the child, and `ended` settles as the loop
      // leaves. The value is only what this call resolves with.
      void child.return({ code: null, signal: null }).then(undefined, (error: unknown) => {
        $.ui.log(`shell-progress: cannot stop the sampler: ${errorMessage(error)}`)
      })
    },
    ended,
  }
}

/**
 * Stores the usage figures for the prompt hint, or none while the pane is
 * placed and in front, where its bars already show them.
 */
async function pollHintUsage($: EngineInterface): Promise<void> {
  const [panes, usage] = await Promise.all([$.ui.panes(), $.session.usage()])
  const isPaneInView = panes.some(pane => pane.id === PANE_ID && pane.isPlaced && pane.isShown)
  const text = isPaneInView ? null : (usageHintText(usage) ?? null)
  if (text !== (await read($, hintUsage))) await update($, hintUsage, () => text)
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

function isLive(
  job: Job,
  nowMs: number,
  stallMs: number,
  states: ReadonlyMap<string, ProcessState>,
): boolean {
  return job.line?.kind === 'running' && !isStalled(job, nowMs, stallMs, states)
}

async function openPaneOnce($: EngineInterface): Promise<void> {
  await update($, hasOpenedPane, () => true)
  // Too narrow a terminal leaves the pane unplaced, waiting for more width or
  // for /progress, which is the behaviour wanted, so the answer is not used.
  await $.ui.open(PANE_REQUEST)
}
