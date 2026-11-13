import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Job } from '../types'
import { PANE_ID, PANE_TITLE, drawPane } from './pane'
import { pollJobs } from './poll'
import { isStalled, statusSummary } from './progress'

const POLL_INTERVAL_MS = 500
const COMMAND_NAME = 'progress'
const MS_PER_MINUTE = 60_000

// Change the tag when Job's fields change: it declines what an earlier
// version stored, which outlives a reload.
const jobs = atom({ plugin: 'shell-progress', key: 'jobs' } as const, [], {
  shape: 'jobs-1',
})
// Set once the pane has opened by itself, so a person who closes it is not
// shown it again in the same session.
const hasOpenedPane = atom({ plugin: 'shell-progress', key: 'hasOpenedPane' } as const, false)

export const register: Register = (on, options) => {
  const stallMs = stallMinutesOf(options) * MS_PER_MINUTE

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND_NAME,
      description: 'Show the background jobs pane',
    })
    startPolling($, await progressDir($), stallMs)
    return next(e)
  })

  on('command.run', { command: COMMAND_NAME }, async $ => {
    const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    return {
      text: opened.isPlaced
        ? `${PANE_TITLE} pane opened.`
        : `${PANE_TITLE} pane opened but not shown: ${opened.reason}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const [jobList, nowMs, usage] = await Promise.all([
      read($, jobs),
      $.clock.now(),
      $.session.usage(),
    ])
    return drawPane($.ui.resolve(e), {
      jobs: jobList,
      bodyColumns: e.props.bodyColumns,
      nowMs,
      sessionStartedMs: usage.startedAt,
      stallMs,
    })
  })
}

function stallMinutesOf(options: PluginOptions): number {
  const minutes = options['stallMinutes']
  if (typeof minutes !== 'number' || !(minutes > 0)) {
    throw new Error(`expected stallMinutes to be a positive number, got ${String(minutes)}`)
  }
  return minutes
}

/** Where the helpers write: the same rule as theirs, with the session root for their working directory. */
async function progressDir($: EngineInterface): Promise<string> {
  const configured = await $.env.get('CLAUDE_PROGRESS_DIR')
  if (configured !== undefined && configured !== '') return configured
  return `${await $.session.root()}/.claude/progress`
}

function startPolling($: EngineInterface, dir: string, stallMs: number): void {
  let isPolling = false
  // `null` until the first poll, so a reload always replaces whatever the
  // previous copy of the module left on the status line.
  let shownStatus: string | undefined | null = null
  let loggedError: string | undefined

  // The timer lives until the module reloads, which drops it with the
  // environment, so nothing needs to cancel it.
  $.clock.every(POLL_INTERVAL_MS, () => {
    if (isPolling) return
    isPolling = true
    // Settled by its own handlers, and the flag keeps polls from overlapping.
    void pollOnce($, dir, stallMs)
      .then(
        summary => {
          loggedError = undefined
          if (summary === shownStatus) return
          shownStatus = summary
          $.ui.status(summary)
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          if (message === loggedError) return
          loggedError = message
          $.ui.log(`shell-progress: cannot poll ${dir}: ${message}`)
        },
      )
      .finally(() => {
        isPolling = false
      })
  })
}

async function pollOnce(
  $: EngineInterface,
  dir: string,
  stallMs: number,
): Promise<string | undefined> {
  const previous = await read($, jobs)
  const current = await pollJobs($, dir, previous)
  if (current !== previous) await update($, jobs, () => current)

  const nowMs = await $.clock.now()
  const isAnyLive = current.some(job => isLive(job, nowMs, stallMs))
  if (isAnyLive && !(await read($, hasOpenedPane))) await openPaneOnce($)

  const summary = statusSummary(current, nowMs, stallMs)
  // A running job's elapsed time and spinner move on every poll even when no
  // file changed, so the pane is drawn again while one runs.
  if (summary !== undefined) $.ui.invalidate('ui.render')
  return summary
}

function isLive(job: Job, nowMs: number, stallMs: number): boolean {
  return job.line?.kind === 'running' && !isStalled(job, nowMs, stallMs)
}

async function openPaneOnce($: EngineInterface): Promise<void> {
  // Marked first, so a slow open cannot let the next poll open it again.
  await update($, hasOpenedPane, () => true)
  // Too narrow a terminal leaves the pane unplaced, waiting for more width or
  // for /progress, which is the behaviour wanted, so the answer is not used.
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
}
