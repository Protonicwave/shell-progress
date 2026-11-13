import type { Color, Elements, RenderNode } from 'claude-code'

import type { Job } from '../types'
import { POLL_INTERVAL_MS } from './poll'
import type { FinishedJob, RunningLine, UnfinishedJob } from './progress'
import { MS_PER_SECOND, barText, durationText, finishedText, isStalled, shownJobs } from './progress'

export const PANE_ID = 'shell-progress'
export const PANE_TITLE = 'Background jobs'

const MAX_BAR_CELLS = 40
// Columns kept clear to the right of the bar.
const BAR_GAP_COLUMNS = 2
const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// The pane is redrawn on each poll while a job runs, so the spinner turns
// one frame per poll.
const SPINNER_FRAME_MS = POLL_INTERVAL_MS

const BAR_COLOUR: Color = 'claude'
const STALLED_COLOUR: Color = 'warning'
const DONE_COLOUR: Color = 'success'
const FAILED_COLOUR: Color = 'error'

/** The two elements the pane draws with, which every surface's table holds. */
type PaneElements = Pick<Elements['terminal'], 'Box' | 'Text'>

/** What the pane draws at one moment. */
type PaneView = {
  readonly jobs: readonly Job[]
  readonly bodyColumns: number
  readonly nowMs: number
  readonly sessionStartedMs: number
  readonly stallMs: number
}

/** Draws the jobs as `docs/mockup.html` shows them: unfinished first, then the finished group. */
export function drawPane(ui: PaneElements, view: PaneView) {
  const { Box, Text } = ui
  const { unfinished, finished } = shownJobs(view.jobs, view.sessionStartedMs)
  const runningCount = unfinished.filter(
    job => job.line !== null && !isStalled(job, view.nowMs, view.stallMs),
  ).length
  const count = countText(runningCount, unfinished.length, finished.length)

  return (
    <Box flexDirection="column">
      {spreadRow(ui, <Text bold>{PANE_TITLE}</Text>, count === undefined ? undefined : <Text dimColor>{count}</Text>)}
      {unfinished.length === 0 && finished.length === 0 && (
        <Text dimColor>No jobs yet. A script that sources the helpers shows here.</Text>
      )}
      {unfinished.map(job => (
        <Box key={job.file} flexDirection="column" marginTop={1}>
          {unfinishedRows(ui, view, job)}
        </Box>
      ))}
      {finished.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>Finished</Text>
        </Box>
      )}
      {finished.map(job => (
        <Box key={job.file}>{finishedRow(ui, job)}</Box>
      ))}
    </Box>
  )
}

function countText(
  runningCount: number,
  unfinishedCount: number,
  finishedCount: number,
): string | undefined {
  if (runningCount > 0) return `${runningCount} running`
  return unfinishedCount === 0 && finishedCount > 0 ? 'all finished' : undefined
}

function unfinishedRows(ui: PaneElements, view: PaneView, job: UnfinishedJob): RenderNode[] {
  const { Text } = ui
  const name = <Text bold>{job.script}</Text>
  if (job.line === null) {
    return [spreadRow(ui, name, <Text color={FAILED_COLOUR}>unreadable progress line</Text>)]
  }

  const line = job.line
  const hasStalled = isStalled(job, view.nowMs, view.stallMs)
  const elapsed = durationText(view.nowMs / MS_PER_SECOND - line.startedSec)
  const time = hasStalled ? (
    <Text color={STALLED_COLOUR}>stalled {elapsed}</Text>
  ) : (
    <Text dimColor>{elapsed}</Text>
  )

  if (line.total === 0) {
    const glyph = hasStalled
      ? <Text dimColor>·</Text>
      : <Text color={BAR_COLOUR}>{spinnerFrame(view.nowMs)}</Text>
    return [
      spreadRow(ui, name, <Text dimColor>no step count</Text>),
      spreadRow(ui, <Text>{glyph} {line.label}</Text>, time),
    ]
  }

  return [
    spreadRow(ui, name, <Text>{stepText(line)}</Text>),
    barRow(ui, line, barCellsFor(view.bodyColumns), hasStalled),
    spreadRow(ui, <Text dimColor>{line.label}</Text>, time),
  ]
}

function stepText(line: RunningLine): string {
  const percent = Math.round((line.step / line.total) * 100)
  return `${line.step}/${line.total}  ${String(percent).padStart(3, ' ')}%`
}

function barRow({ Text }: PaneElements, line: RunningLine, cells: number, isStalled: boolean) {
  const { filled, empty } = barText(line.step / line.total, cells)
  return (
    <Text>
      {isStalled ? <Text dimColor>{filled}</Text> : <Text color={BAR_COLOUR}>{filled}</Text>}
      <Text dimColor>{empty}</Text>
    </Text>
  )
}

function finishedRow(ui: PaneElements, job: FinishedJob) {
  const { Text } = ui
  const colour = job.line.exitCode === 0 ? DONE_COLOUR : FAILED_COLOUR
  return spreadRow(
    ui,
    <Text dimColor>{job.script}</Text>,
    <Text color={colour}>{finishedText(job.line)}</Text>,
  )
}

/**
 * One row with `left` cut by an ellipsis where it would meet `right`, which
 * keeps its full width.
 */
function spreadRow({ Box, Text }: PaneElements, left: RenderNode, right?: RenderNode) {
  return (
    <Box justifyContent="space-between" gap={2}>
      <Text wrap="truncate-end">{left}</Text>
      {right !== undefined && <Box flexShrink={0}>{right}</Box>}
    </Box>
  )
}

function barCellsFor(bodyColumns: number): number {
  return Math.max(1, Math.min(MAX_BAR_CELLS, bodyColumns - BAR_GAP_COLUMNS))
}

function spinnerFrame(nowMs: number): string {
  return SPINNER_FRAMES.charAt(Math.floor(nowMs / SPINNER_FRAME_MS) % SPINNER_FRAMES.length)
}
