import type { Job, ProgressLine } from '../types'

export type JobStatus =
  | 'running'
  | 'no-step-count'
  | 'stalled'
  | 'done'
  | 'failed'
  | 'unreadable'

const SUMMARY_MAX_NAMED_JOBS = 2

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
 * Classifies a job at `nowMs`. A running job whose file has not changed for
 * `stallMs` is stalled, which is how a killed script shows.
 */
export function jobStatus(job: Job, nowMs: number, stallMs: number): JobStatus {
  const { line } = job
  if (line === null) return 'unreadable'
  if (line.kind === 'finished') return line.exitCode === 0 ? 'done' : 'failed'
  if (nowMs - job.mtimeMs >= stallMs) return 'stalled'
  return line.total === 0 ? 'no-step-count' : 'running'
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
  line: ProgressLine & { kind: 'running' },
  nowMs: number,
  stallMs: number,
): string {
  if (jobStatus(job, nowMs, stallMs) === 'stalled') return 'stalled'
  if (line.total === 0) return 'running'
  return `${Math.round((line.step / line.total) * 100)}%`
}

function shortName(script: string): string {
  const dot = script.lastIndexOf('.')
  return dot > 0 ? script.slice(0, dot) : script
}
