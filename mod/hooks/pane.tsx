import type { Color, Elements, RenderNode, SessionUsage } from 'claude-code'

import type { EndedCall, Job, ListedAgent, RunningCall, SessionTurn, ToolCalls } from '../types'
import { POLL_INTERVAL_MS } from './poll'
import type { FinishedJob, RunningLine, UnfinishedJob } from './progress'
import {
  MS_PER_SECOND,
  barText,
  clockTimeText,
  durationText,
  finishedText,
  isFinished,
  isStalled,
  remainingSeconds,
  remainingText,
  runKey,
  shownJobs,
} from './progress'
import { costText, shortDurationText, usageBars } from './session'

export const PANE_ID = 'shell-progress'
export const PANE_TITLE = 'This session'

const MAX_BAR_CELLS = 40
// Agents beyond this many, the oldest, are counted rather than drawn.
const MAX_SHOWN_AGENTS = 5
// A usage bar this full is drawn in HIGH_USAGE_COLOUR.
const HIGH_USAGE_FRACTION = 0.8
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
const HIGH_USAGE_COLOUR: Color = 'warning'

/** The elements the pane draws with, which every surface's table holds. */
type PaneElements = Pick<Elements['terminal'], 'Box' | 'Button' | 'Text'>

/** What the pane's buttons do. Each settles once the change is stored or shown. */
type PaneActions = {
  /** Expands the job's row, or collapses it if it is the expanded one. */
  readonly toggleJob: (file: string) => Promise<void>
  readonly dismissJob: (key: string) => Promise<void>
  readonly showHiddenJobs: () => Promise<void>
  /** Sends Claude a prompt about the failed job, and settles before Claude answers. */
  readonly askClaude: (job: FinishedJob) => Promise<void>
  /** Shows the agent's transcript in the main view, or says in a toast why it cannot. */
  readonly viewAgent: (agent: ListedAgent) => Promise<void>
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
  readonly usage: SessionUsage
  readonly stallMs: number
  readonly actions: PaneActions
  readonly toolCalls: ToolCalls
  readonly turn: SessionTurn
  /** Oldest first. */
  readonly agents: readonly ListedAgent[]
}

/**
 * Draws the session: the call running now, the jobs, the agents, the last
 * calls, then the usage bars and the cost. A group with nothing in it is left
 * out.
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
      {agentsGroup(ui, view)}
      {recentGroup(ui, view.toolCalls.recent)}
      {usageGroup(ui, view)}
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

/** The newest agents, newest first, each a button that shows its transcript. */
function agentsGroup(ui: PaneElements, view: PaneView): RenderNode | undefined {
  const { Box, Button, Text } = ui
  if (view.agents.length === 0) return undefined
  const shown = view.agents.slice(-MAX_SHOWN_AGENTS).reverse()
  const moreCount = view.agents.length - shown.length
  const more = moreCount > 0 ? <Text dimColor>{moreCount} more</Text> : undefined
  return (
    <Box flexDirection="column" marginTop={1}>
      {spreadRow(ui, <Text dimColor>Agents</Text>, more)}
      {shown.map(agent => {
        const colour = agentStatusColour(agent.status)
        const button = (
          <Button
            key={`agent:${agent.id}`}
            plain
            label={agent.label}
            onPress={() => view.actions.viewAgent(agent)}
          />
        )
        const status =
          colour === undefined ? (
            <Text dimColor>{agent.status}</Text>
          ) : (
            <Text color={colour}>{agent.status}</Text>
          )
        return <Box key={agent.id}>{nameRow(ui, button, status)}</Box>
      })}
    </Box>
  )
}

/** The colour of a working, succeeded or failed agent; `undefined` for one that waits. */
function agentStatusColour(status: ListedAgent['status']): Color | undefined {
  switch (status) {
    case 'running':
      return BAR_COLOUR
    case 'completed':
      return DONE_COLOUR
    case 'failed':
    case 'killed':
      return FAILED_COLOUR
    case 'pending':
    case 'waiting':
    case 'idle':
      return undefined
    default:
      // A status from an engine newer than these types is drawn as waiting
      // rather than breaking the pane; `satisfies` makes the type-check catch it.
      status satisfies never
      return undefined
  }
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

/** The context and five-hour bars, each with its figures, and the session's cost. */
function usageGroup(ui: PaneElements, view: PaneView): RenderNode | undefined {
  const { Box, Text } = ui
  const bars = usageBars(view.usage)
  const cost = costText(view.usage)
  if (bars.length === 0 && cost === undefined) return undefined
  const cells = barCellsFor(view.bodyColumns)
  return (
    <Box flexDirection="column" marginTop={1}>
      {bars.map(bar => {
        const colour = bar.fraction >= HIGH_USAGE_FRACTION ? HIGH_USAGE_COLOUR : BAR_COLOUR
        return (
          <Box key={bar.label} flexDirection="column">
            {spreadRow(ui, <Text dimColor>{bar.label}</Text>, <Text dimColor>{bar.figures}</Text>)}
            {barRow(ui, bar.fraction, cells, colour)}
          </Box>
        )
      })}
      {cost !== undefined && <Text dimColor>{cost}</Text>}
    </Box>
  )
}

/** The jobs: unfinished first, then the finished ones under their own label. */
function jobsGroup(ui: PaneElements, view: PaneView): RenderNode | undefined {
  const { Box, Text } = ui
  const { unfinished, finished, hiddenCount } = shownJobs(
    view.jobs,
    view.usage.startedAt,
    view.dismissedJobs,
  )
  if (unfinished.length === 0 && finished.length === 0 && hiddenCount === 0) return undefined
  const runningCount = unfinished.filter(
    job => job.line !== null && !isStalled(job, view.nowMs, view.stallMs),
  ).length
  const count = countText(runningCount, unfinished.length, finished.length)

  return (
    <Box flexDirection="column" marginTop={1}>
      {spreadRow(ui, <Text dimColor>Jobs</Text>, jobsHeadingEnd(ui, view, count, hiddenCount))}
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

/** The right of the Jobs heading: the count, then a button that shows the hidden jobs again. */
function jobsHeadingEnd(
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
    barRow(
      ui,
      line.step / line.total,
      barCellsFor(view.bodyColumns),
      hasStalled ? undefined : BAR_COLOUR,
    ),
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

/** A bar `fraction` full, its filled part in `colour`, or dim when that is `undefined`. */
function barRow({ Text }: PaneElements, fraction: number, cells: number, colour: Color | undefined) {
  const { filled, empty } = barText(fraction, cells)
  return (
    <Text>
      {colour === undefined ? <Text dimColor>{filled}</Text> : <Text color={colour}>{filled}</Text>}
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
  if (job.line !== null) facts.push(`started ${clockTimeText(job.line.startedSec * MS_PER_SECOND, true)}`)
  if (job.line?.kind === 'finished') facts.push(`exit ${job.line.exitCode}`)
  const key = canDismiss ? runKey(job) : undefined
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text dimColor wrap="truncate-start">{`${view.progressDir}/${job.file}`}</Text>
      <Text dimColor>{facts.join(' · ')}</Text>
      {isFinished(job) && job.line.exitCode !== 0 && askClaudeControl(ui, view, job)}
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

/**
 * A job's or an agent's row: its name button and `right`, which keeps its full width.
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
