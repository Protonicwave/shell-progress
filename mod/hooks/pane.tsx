import type { Color, Elements, RenderNode } from 'claude-code'

import type { Job } from '../types'
import type { ActiveJob, FinishedJob, RunningLine } from './progress'
import { barText, durationText, finishedText, isStalled, shownJobs } from './progress'

export const PANE_ID = 'shell-progress'
export const PANE_TITLE = 'Background jobs'

const MIN_BAR_CELLS = 10
const MAX_BAR_CELLS = 40
const MS_PER_SECOND = 1000
const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// The pane is redrawn on each poll while a job runs, so the spinner turns
// one frame per poll.
const SPINNER_FRAME_MS = 500

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

/** Draws the jobs as `docs/mockup.html` shows them: active first, then the finished group. */
export function drawPane(ui: PaneElements, view: PaneView) {
  const { Box, Text } = ui
  const { active, finished } = shownJobs(view.jobs, view.sessionStartedMs)
  const runningCount = active.filter(job => job.line !== null).length
  const count = countText(runningCount, finished.length)

  return (
    <Box flexDirection="column">
      {spreadRow(ui, <Text bold>{PANE_TITLE}</Text>, count && <Text dimColor>{count}</Text>)}
      {active.length === 0 && finished.length === 0 && (
        <Text dimColor>No jobs yet. A script that sources the helpers shows here.</Text>
      )}
      {active.map(job => (
        <Box key={job.file} flexDirection="column" marginTop={1}>
          {activeRows(ui, view, job)}
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

function countText(runningCount: number, finishedCount: number): string {
  if (runningCount > 0) return `${runningCount} running`
  return finishedCount > 0 ? 'all finished' : ''
}

function activeRows(ui: PaneElements, view: PaneView, job: ActiveJob): RenderNode[] {
  const { Text } = ui
  const name = <Text bold>{job.script}</Text>
  if (job.line === null) {
    return [spreadRow(ui, name, <Text color={FAILED_COLOUR}>unreadable progress line</Text>)]
  }

  const line = job.line
  const hasStalled = isStalled(job, view.nowMs, view.stallMs)
  const elapsed = durationText((view.nowMs - line.startedSec * MS_PER_SECOND) / MS_PER_SECOND)
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
function spreadRow({ Box, Text }: PaneElements, left: RenderNode, right: RenderNode | '') {
  return (
    <Box justifyContent="space-between" gap={2}>
      <Text wrap="truncate-end">{left}</Text>
      {right !== '' && <Box flexShrink={0}>{right}</Box>}
    </Box>
  )
}

function barCellsFor(bodyColumns: number): number {
  return Math.min(MAX_BAR_CELLS, Math.max(MIN_BAR_CELLS, bodyColumns - 2))
}

function spinnerFrame(nowMs: number): string {
  return SPINNER_FRAMES.charAt(Math.floor(nowMs / SPINNER_FRAME_MS) % SPINNER_FRAMES.length)
}
