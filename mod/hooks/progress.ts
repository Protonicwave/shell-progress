import type { Job, ProgressLine } from '../types'

export type RunningLine = ProgressLine & { kind: 'running' }
type FinishedLine = ProgressLine & { kind: 'finished' }

const SUMMARY_MAX_NAMED_JOBS = 2
const MAX_SHOWN_FINISHED_JOBS = 5
// Before this step, the average time per step rests on too few steps to say.
const FIRST_ESTIMATED_STEP = 3
// An estimate finer than this claims more than an average of steps can know.
const REMAINING_ROUNDING_SECONDS = 5
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600
export const MS_PER_SECOND = 1000

const EIGHTHS_PER_CELL = 8
const FULL_CELL = '█'
const EMPTY_CELL = '░'
// Index n is a cell n eighths full, drawn from the left.
const PARTIAL_CELLS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const

// Only ASCII digits, so a label never shifts the fields before it. A
// finished line's exit code alone may be negative.
const RUNNING_LINE = /^(\d+) (\d+) (\d+)(?: (.*))?$/
const FINISHED_LINE = /^(\d+) done (-?\d+) (\d+)$/

/**
 * Parses the line a helper wrote, with or without its line feed.
 *
 * Returns `null` for anything else, including a field too large to hold
 * exactly. A step above the total is capped at the total.
 */
export function parseProgressLine(text: string): ProgressLine | null {
  const line = text.endsWith('\n') ? text.slice(0, -1) : text
  if (/[\r\n\t]/.test(line)) return null

  const finished = FINISHED_LINE.exec(line)
  if (finished !== null) {
    const fields = numericFields(finished)
    if (fields === null) return null
    const [startedSec, exitCode, endedSec] = fields
    return { kind: 'finished', startedSec, exitCode, endedSec }
  }

  const running = RUNNING_LINE.exec(line)
  if (running === null) return null
  const fields = numericFields(running)
  if (fields === null) return null
  const [startedSec, step, total] = fields
  return {
    kind: 'running',
    startedSec,
    step: total > 0 ? Math.min(step, total) : step,
    total,
    label: running[4] ?? '',
  }
}

/** The match's first three groups as numbers, or `null` if one is not a safe integer. */
function numericFields(match: RegExpExecArray): readonly [number, number, number] | null {
  const fields = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  return fields.every(field => Number.isSafeInteger(field)) ? fields : null
}

/**
 * Whether a running job's file has gone unchanged for `stallMs` at `nowMs`,
 * which is how a killed script shows. A finished or unreadable job never stalls.
 */
export function isStalled(job: Job, nowMs: number, stallMs: number): boolean {
  return job.line?.kind === 'running' && nowMs - job.mtimeMs >= stallMs
}

/**
 * The status line text for the jobs still running, in the order given:
 * `build 58% · sync running · 1 more`. `undefined` when none is running.
 */
export function statusSummary(
  jobs: readonly Job[],
  nowMs: number,
  stallMs: number,
): string | undefined {
  const parts: string[] = []
  for (const job of jobs) {
    if (job.line?.kind !== 'running') continue
    parts.push(`${shortName(job.script)} ${runningState(job, job.line, nowMs, stallMs)}`)
  }
  if (parts.length === 0) return undefined

  const named = parts.slice(0, SUMMARY_MAX_NAMED_JOBS)
  const hidden = parts.length - named.length
  return [...named, ...(hidden > 0 ? [`${hidden} more`] : [])].join(' · ')
}

function runningState(
  job: Job,
  line: RunningLine,
  nowMs: number,
  stallMs: number,
): string {
  if (isStalled(job, nowMs, stallMs)) return 'stalled'
  if (line.total === 0) return 'running'
  return `${Math.round((line.step / line.total) * 100)}%`
}

function shortName(script: string): string {
  const dot = script.lastIndexOf('.')
  return dot > 0 ? script.slice(0, dot) : script
}

/**
 * A bar `cells` wide for `fraction`, rounded to the nearest eighth of a cell:
 * the filled part, ending in a partial cell where one is due, and the empty
 * rest. Throws on a fraction outside 0 to 1 or a width below one cell.
 */
export function barText(fraction: number, cells: number): { filled: string; empty: string } {
  if (!(fraction >= 0 && fraction <= 1)) {
    throw new RangeError(`expected a fraction from 0 to 1, got ${fraction}`)
  }
  if (!(Number.isInteger(cells) && cells >= 1)) {
    throw new RangeError(`expected at least one cell, got ${cells}`)
  }
  const eighths = Math.round(fraction * cells * EIGHTHS_PER_CELL)
  const fullCells = Math.floor(eighths / EIGHTHS_PER_CELL)
  const partial = PARTIAL_CELLS[eighths % EIGHTHS_PER_CELL] ?? ''
  const usedCells = fullCells + (partial === '' ? 0 : 1)
  return {
    filled: FULL_CELL.repeat(fullCells) + partial,
    empty: EMPTY_CELL.repeat(cells - usedCells),
  }
}

/** `1m 12s` below an hour, `2h 05m` from an hour. A negative span shows as none. */
export function durationText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  if (whole < SECONDS_PER_HOUR) {
    return `${Math.floor(whole / SECONDS_PER_MINUTE)}m ${twoDigits(whole % SECONDS_PER_MINUTE)}s`
  }
  const minutes = Math.floor((whole % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  return `${Math.floor(whole / SECONDS_PER_HOUR)}h ${twoDigits(minutes)}m`
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * The seconds a running job has left at `nowMs`, from its average time per
 * step so far. `undefined` for a job with no step count or before step
 * FIRST_ESTIMATED_STEP.
 */
export function remainingSeconds(line: RunningLine, nowMs: number): number | undefined {
  if (line.total === 0 || line.step < FIRST_ESTIMATED_STEP) return undefined
  const elapsedSec = Math.max(0, nowMs / MS_PER_SECOND - line.startedSec)
  return (elapsedSec / line.step) * (line.total - line.step)
}

/** `about 25s left` below a minute, otherwise as `durationText`; never under 5 seconds. */
export function remainingText(seconds: number): string {
  const rounded = Math.max(
    REMAINING_ROUNDING_SECONDS,
    Math.round(seconds / REMAINING_ROUNDING_SECONDS) * REMAINING_ROUNDING_SECONDS,
  )
  return rounded < SECONDS_PER_MINUTE
    ? `about ${rounded}s left`
    : `about ${durationText(rounded)} left`
}

/** `done in 0m 22s`, or `failed after 1m 04s, exit 1`. */
export function finishedText(line: FinishedLine): string {
  const duration = durationText(line.endedSec - line.startedSec)
  return line.exitCode === 0
    ? `done in ${duration}`
    : `failed after ${duration}, exit ${line.exitCode}`
}

/** A job still running, or one whose file does not hold a progress line. */
export type UnfinishedJob = Job & { readonly line: RunningLine | null }
export type FinishedJob = Job & { readonly line: FinishedLine }

/**
 * Splits jobs for the pane. Running and unreadable jobs are unfinished, in the
 * order given. Of the finished, only those that ended in or after the
 * session's first second show, newest first, at most MAX_SHOWN_FINISHED_JOBS.
 */
export function shownJobs(
  jobs: readonly Job[],
  sessionStartedMs: number,
): { unfinished: readonly UnfinishedJob[]; finished: readonly FinishedJob[] } {
  const sessionStartedSec = Math.floor(sessionStartedMs / MS_PER_SECOND)
  const unfinished = jobs.filter(isUnfinished)
  const finished = jobs
    .filter(isFinished)
    .filter(job => job.line.endedSec >= sessionStartedSec)
    .sort((a, b) => b.line.endedSec - a.line.endedSec)
  return { unfinished, finished: finished.slice(0, MAX_SHOWN_FINISHED_JOBS) }
}

function isUnfinished(job: Job): job is UnfinishedJob {
  return job.line?.kind !== 'finished'
}

function isFinished(job: Job): job is FinishedJob {
  return job.line?.kind === 'finished'
}
