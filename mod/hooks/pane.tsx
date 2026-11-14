import type { Color, Elements, RenderNode } from 'claude-code'

import type { EndedCall, Job, RunningCall, SessionTurn, ToolCalls } from '../types'
import { POLL_INTERVAL_MS } from './poll'
import type { FinishedJob, RunningLine, UnfinishedJob } from './progress'
import {
  MS_PER_SECOND,
  barText,
  durationText,
  finishedText,
  isStalled,
  remainingSeconds,
  remainingText,
  runKey,
  shownJobs,
} from './progress'
import { shortDurationText } from './session'

export const PANE_ID = 'shell-progress'
export const PANE_TITLE = 'This session'

const MAX_BAR_CELLS = 40
// Columns kept clear to the right of the bar.
const BAR_GAP_COLUMNS = 2
const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
// The pane is redrawn on each poll while a job or a turn runs, so the
// spinner turns one frame per poll.
const SPINNER_FRAME_MS = POLL_INTERVAL_MS

const BAR_COLOUR: Color = 'claude'
const STALLED_COLOUR: Color = 'warning'
const DONE_COLOUR: Color = 'success'
const FAILED_COLOUR: Color = 'error'

/** The elements the pane draws with, which every surface's table holds. */
type PaneElements = Pick<Elements['terminal'], 'Box' | 'Button' | 'Text'>

/** What the pane's buttons do. Each settles once the change is stored. */
type JobActions = {
  /** Expands the job's row, or collapses it if it is the expanded one. */
  readonly toggleJob: (file: string) => Promise<void>
  readonly dismissJob: (key: string) => Promise<void>
  readonly showHiddenJobs: () => Promise<void>
  /** Sends Claude a prompt about the failed job, and settles before Claude answers. */
  readonly askClaude: (job: FinishedJob) => Promise<void>
}

/** What the pane draws at one moment. */
type PaneView = {
  readonly jobs: readonly Job[]
  readonly progressDir: string
  readonly expandedJob: string | null
  readonly dismissedJobs: ReadonlySet<string>
  /** The run keys of the failed jobs Claude has been asked about. */
  readonly askedJobs: ReadonlySet<string>
  readonly bodyColumns: number
  readonly nowMs: number
  readonly sessionStartedMs: number
  readonly stallMs: number
  readonly actions: JobActions
  readonly toolCalls: ToolCalls
  readonly turn: SessionTurn
}

/**
 * Draws the session as `docs/mockup.html` shows it: the call running now, the
 * jobs, then the last calls. A group with nothing in it is left out.
 */
export function drawPane(ui: PaneElements, view: PaneView) {
  const { Box, Text } = ui
  const turnTime =
    view.turn.kind === 'running' ? (
      <Text dimColor>turn {shortDurationText(view.nowMs - view.turn.startedMs)}</Text>
    ) : undefined
  return (
    <Box flexDirection="column">
      {spreadRow(ui, <Text bold>{PANE_TITLE}</Text>, turnTime)}
      <Box marginTop={1}>{nowRow(ui, view)}</Box>
      {jobsGroup(ui, view)}
      {recentGroup(ui, view.toolCalls.recent)}
    </Box>
  )
}

/** The call running now, else what the turn is doing. */
function nowRow(ui: PaneElements, view: PaneView): RenderNode {
  const { Text } = ui
  const call = view.toolCalls.running.at(-1)
  if (call !== undefined) return runningCallRow(ui, view.nowMs, call)
  if (view.turn.kind === 'running') {
    return <Text><Text color={BAR_COLOUR}>{spinnerFrame(view.nowMs)}</Text> Thinking</Text>
  }
  const last = view.turn.lastDurationMs
  return (
    <Text dimColor>
      Waiting for you{last === null ? '' : ` · last turn took ${shortDurationText(last)}`}
    </Text>
  )
}

function runningCallRow(ui: PaneElements, nowMs: number, call: RunningCall): RenderNode {
  const { Text } = ui
  return spreadRow(
    ui,
    <Text>
      <Text color={BAR_COLOUR}>{spinnerFrame(nowMs)}</Text> <Text bold>{call.tool}</Text>{' '}
      <Text dimColor>{call.argument}</Text>
    </Text>,
    <Text dimColor>{shortDurationText(nowMs - call.startedMs)}</Text>,
  )
}

/** The last calls, newest first, each with how long it took. */
function recentGroup(ui: PaneElements, calls: readonly EndedCall[]): RenderNode | undefined {
  const { Box, Text } = ui
  if (calls.length === 0) return undefined
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>Recent</Text>
      {calls.map(call => {
        const took = shortDurationText(call.endedMs - call.startedMs)
        const time = call.hasFailed
          ? <Text color={FAILED_COLOUR}>failed after {took}</Text>
          : <Text dimColor>{took}</Text>
        return (
          <Box key={call.id}>
            {spreadRow(ui, <Text>{call.tool} <Text dimColor>{call.argument}</Text></Text>, time)}
          </Box>
        )
      })}
    </Box>
  )
}

/** The jobs: unfinished first, then the finished ones under their own label. */
function jobsGroup(ui: PaneElements, view: PaneView): RenderNode | undefined {
  const { Box, Text } = ui
  const { unfinished, finished, hiddenCount } = shownJobs(
    view.jobs,
    view.sessionStartedMs,
    view.dismissedJobs,
  )
  if (unfinished.length === 0 && finished.length === 0 && hiddenCount === 0) return undefined
  const runningCount = unfinished.filter(
    job => job.line !== null && !isStalled(job, view.nowMs, view.stallMs),
  ).length
  const count = countText(runningCount, unfinished.length, finished.length)

  return (
    <Box flexDirection="column" marginTop={1}>
      {spreadRow(ui, <Text dimColor>Jobs</Text>, jobsCount(ui, view, count, hiddenCount))}
      {unfinished.map(job => (
        <Box key={job.file} flexDirection="column" marginTop={1}>
          {unfinishedRows(ui, view, job)}
          {job.file === view.expandedJob &&
            jobDetails(ui, view, job, isStalled(job, view.nowMs, view.stallMs))}
        </Box>
      ))}
      {finished.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>Finished</Text>
        </Box>
      )}
      {finished.map(job => (
        <Box key={job.file} flexDirection="column">
          {finishedRow(ui, view, job)}
          {job.file === view.expandedJob && jobDetails(ui, view, job, true)}
        </Box>
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

/** The jobs label's right side: the count, then a button that shows the hidden jobs again. */
function jobsCount(
  { Box, Button, Text }: PaneElements,
  view: PaneView,
  count: string | undefined,
  hiddenCount: number,
): RenderNode | undefined {
  const countNode = count === undefined ? undefined : <Text dimColor>{count}</Text>
  if (hiddenCount === 0) return countNode
  return (
    <Box gap={1}>
      {countNode}
      {countNode !== undefined && <Text dimColor>·</Text>}
      <Button
        key="show-hidden"
        plain
        dimColor
        label={`${hiddenCount} hidden`}
        onPress={view.actions.showHiddenJobs}
      />
    </Box>
  )
}

function unfinishedRows(ui: PaneElements, view: PaneView, job: UnfinishedJob): RenderNode[] {
  const { Text } = ui
  const name = nameButton(ui, view, job)
  if (job.line === null) {
    return [nameRow(ui, name, <Text color={FAILED_COLOUR}>unreadable progress line</Text>)]
  }

  const line = job.line
  const hasStalled = isStalled(job, view.nowMs, view.stallMs)
  // A stalled row gives how long the job ran before its file went quiet, which
  // stays put, so the pane need not be redrawn for it.
  const time = hasStalled ? (
    <Text color={STALLED_COLOUR}>
      stalled after {durationText(job.mtimeMs / MS_PER_SECOND - line.startedSec)}
    </Text>
  ) : (
    <Text dimColor>{runningTimeText(line, view.nowMs)}</Text>
  )

  if (line.total === 0) {
    const glyph = hasStalled
      ? <Text dimColor>·</Text>
      : <Text color={BAR_COLOUR}>{spinnerFrame(view.nowMs)}</Text>
    return [
      nameRow(ui, name, <Text dimColor>no step count</Text>),
      spreadRow(ui, <Text>{glyph} {line.label}</Text>, time),
    ]
  }

  return [
    nameRow(ui, name, <Text>{stepText(line)}</Text>),
    barRow(ui, line, barCellsFor(view.bodyColumns), hasStalled),
    spreadRow(ui, <Text dimColor>{line.label}</Text>, time),
  ]
}

/** `1m 12s`, and from the third step `1m 12s · about 25s left`. */
function runningTimeText(line: RunningLine, nowMs: number): string {
  const elapsed = durationText(nowMs / MS_PER_SECOND - line.startedSec)
  const remaining = remainingSeconds(line, nowMs)
  return remaining === undefined ? elapsed : `${elapsed} · ${remainingText(remaining)}`
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

function finishedRow(ui: PaneElements, view: PaneView, job: FinishedJob) {
  const { Text } = ui
  const colour = job.line.exitCode === 0 ? DONE_COLOUR : FAILED_COLOUR
  return nameRow(
    ui,
    nameButton(ui, view, job),
    <Text color={colour}>{finishedText(job.line)}</Text>,
  )
}

/** The job's name, which expands or collapses its row when pressed. */
function nameButton({ Button }: PaneElements, view: PaneView, job: Job) {
  return (
    <Button
      key={job.file}
      plain
      dimColor={job.line?.kind === 'finished'}
      label={job.script}
      onPress={() => view.actions.toggleJob(job.file)}
    />
  )
}

/**
 * The lines under an expanded row: the file, the process, Ask Claude for a
 * failed job, and a Dismiss button when `canDismiss` and the job has a start
 * to be dismissed by.
 */
function jobDetails(ui: PaneElements, view: PaneView, job: Job, canDismiss: boolean) {
  const { Box, Button, Text } = ui
  const facts = [`pid ${job.pid}`]
  if (job.line !== null) facts.push(`started ${clockTimeText(job.line.startedSec)}`)
  if (job.line?.kind === 'finished') facts.push(`exit ${job.line.exitCode}`)
  const key = canDismiss ? runKey(job) : undefined
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text dimColor wrap="truncate-start">{`${view.progressDir}/${job.file}`}</Text>
      <Text dimColor>{facts.join(' · ')}</Text>
      {job.line?.kind === 'finished' &&
        job.line.exitCode !== 0 &&
        askClaudeControl(ui, view, { ...job, line: job.line })}
      {key !== undefined && (
        <Button
          key={`dismiss:${job.file}`}
          label={`Dismiss ${job.script}`}
          onPress={() => view.actions.dismissJob(key)}
        />
      )}
    </Box>
  )
}

/** A failed job's Ask Claude button, or `Asked Claude` once pressed. */
function askClaudeControl({ Button, Text }: PaneElements, view: PaneView, job: FinishedJob) {
  if (view.askedJobs.has(runKey(job))) return <Text dimColor>Asked Claude</Text>
  return (
    <Button
      key={`ask:${job.file}`}
      label={`Ask Claude about ${job.script}`}
      onPress={() => view.actions.askClaude(job)}
    />
  )
}

/** The local time of day, `14:02:31`. */
function clockTimeText(epochSec: number): string {
  // ECMA-262 fixes toTimeString's form as `HH:mm:ss GMT+hhmm (zone)`.
  return new Date(epochSec * MS_PER_SECOND).toTimeString().slice(0, 8)
}

/**
 * A job's first row: its name button and `right`, which keeps its full width.
 * A Button cannot be cut with an ellipsis, so a name wider than the pane wraps.
 */
function nameRow({ Box }: PaneElements, name: RenderNode, right: RenderNode) {
  return (
    <Box justifyContent="space-between" gap={2}>
      {name}
      <Box flexShrink={0}>{right}</Box>
    </Box>
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
