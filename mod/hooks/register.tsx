import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { pollJobs } from './poll'
import { statusSummary } from './progress'

const POLL_INTERVAL_MS = 500
const MS_PER_MINUTE = 60_000

// Change the tag when Job's fields change: it declines what an earlier
// version stored, which outlives a reload.
const jobs = atom({ plugin: 'shell-progress', key: 'jobs' } as const, [], {
  shape: 'jobs-1',
})

export const register: Register = (on, options) => {
  const stallMs = stallMinutesOf(options) * MS_PER_MINUTE

  on('session.start', async ($, e, next) => {
    startPolling($, await progressDir($), stallMs)
    return next(e)
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
  return statusSummary(current, await $.clock.now(), stallMs)
}
