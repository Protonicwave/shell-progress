import type { Color, Elements, RenderNode, SessionUsage } from 'claude-code'

import type {
  AgentCost,
  EndedCall,
  Job,
  LimitReading,
  ListedAgent,
  MachineSample,
  ProcessState,
  RunningCall,
  SessionTurn,
  ToolCalls,
  TurnContext,
} from '../types'
import { isCurrentSample, machineText, machineWarnings } from './machine'
import { POLL_INTERVAL_MS } from './poll'
import type { FinishedJob, RunningLine, UnfinishedJob } from './progress'
import {
  MS_PER_SECOND,
  barText,
  clockTimeText,
  durationText,
  finishedText,
  hasRunningJob,
  isFinished,
  isQuietButBusy,
  isStalled,
  remainingSeconds,
  remainingText,
  runKey,
  shownJobs,
} from './progress'
import type { UsageRow } from './session'
import { agentCostText, costText, shortDurationText, usageRows } from './session'

export const PANE_ID = 'shell-progress'
export const PANE_TITLE = 'This session'
// The width the pane asks for when docked: room for a usage bar of 14 cells
// beside its label and the widest figures it usually has.
export const PANE_COLUMNS = 48

const MAX_BAR_CELLS = 40
// Agents beyond this many, the oldest, are counted rather than drawn.
const MAX_SHOWN_AGENTS = 5
// A usage bar this full is drawn in HIGH_USAGE_COLOUR.
const HIGH_USAGE_FRACTION = 0.8
// From this many body columns each usage bar shares a row with its label and
// figures; below it the figures would leave the bar too few cells.
const ONE_ROW_USAGE_MIN_COLUMNS = 40
// From this many body columns a running job's row gives its CPU; below it
// the figure would crowd out the job's name.
const JOB_CPU_MIN_COLUMNS = 40
// Wide enough for the longest labels, `5h limit` and `machine`.
const USAGE_LABEL_COLUMNS = 8
const USAGE_GAP_COLUMNS = 1
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
const WARNING_FIGURES_COLOUR: Color = 'warning'
const MACHINE_WARNING_COLOUR: Color = 'warning'

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
  readonly turnContext: TurnContext
  /** Oldest first. */
  readonly limitReadings: readonly LimitReading[]
  /** Oldest first. */
  readonly agents: readonly ListedAgent[]
  /** What each finished agent took, oldest first. */
  readonly agentCosts: readonly AgentCost[]
  /** The sampler's last reading, or `null` before its first. */
  readonly machineSample: MachineSample | null
  /** What each running job's processes are doing, by job file; a job without a state shows no CPU. */
  readonly processStates: ReadonlyMap<string, ProcessState>
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
  const costs = new Map(view.agentCosts.map(cost => [cost.id, cost]))
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
        const cost = costs.get(agent.id)
        return (
          <Box key={agent.id} flexDirection="column">
            {nameRow(ui, button, status)}
            {cost !== undefined && <Text dimColor>{agentCostText(cost)}</Text>}
          </Box>
        )
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

/**
 * The machine's readings while a job is still to finish, then the context and
 * five-hour bars, each on one row with its label and figures where the pane
 * is wide enough and under them where it is not, then the session's cost.
 */
function usageGroup(ui: PaneElements, view: PaneView): RenderNode | undefined {
  const { Box, Text } = ui
  const isOneRow = view.bodyColumns >= ONE_ROW_USAGE_MIN_COLUMNS
  const machine = machineRows(ui, view, isOneRow)
  const rows = usageRows(view.usage, view.turnContext.lastAddedTokens, view.limitReadings, view.nowMs)
  const cost = costText(view.usage)
  if (machine === undefined && rows.length === 0 && cost === undefined) return undefined
  const drawRow = isOneRow
    ? oneUsageRow(ui, oneRowBarCells(view.bodyColumns, rows))
    : (row: UsageRow) => twoUsageRows(ui, barCellsFor(view.bodyColumns), row)
  return (
    <Box flexDirection="column" marginTop={1}>
      {machine}
      {rows.map(drawRow)}
      {cost !== undefined && <Text dimColor>{cost}</Text>}
    </Box>
  )
}

/**
 * The `machine` label and readings, lined up with the usage rows, and any
 * warnings on a row of their own so a narrow pane cuts the readings rather
 * than a warning. Nothing once no job is running or the reading is old.
 */
function machineRows(ui: PaneElements, view: PaneView, isOneRow: boolean): RenderNode | undefined {
  const { Box, Text } = ui
  const sample = view.machineSample
  if (sample === null || !isCurrentSample(sample, view.nowMs)) return undefined
  if (!hasRunningJob(view.jobs, view.dismissedJobs)) return undefined
  const label = <Text dimColor>machine</Text>
  const readings = <Text dimColor wrap="truncate-end">{machineText(sample)}</Text>
  const warnings = machineWarnings(sample)
  const indent = isOneRow ? USAGE_LABEL_COLUMNS + USAGE_GAP_COLUMNS : 0
  return (
    <Box flexDirection="column">
      {isOneRow ? (
        <Box gap={USAGE_GAP_COLUMNS}>
          <Box width={USAGE_LABEL_COLUMNS} flexShrink={0}>{label}</Box>
          {readings}
        </Box>
      ) : (
        <Box flexDirection="column">
          {label}
          {readings}
        </Box>
      )}
      {warnings.length > 0 && (
        <Box marginLeft={indent}>
          <Text color={MACHINE_WARNING_COLOUR}>{warnings.join(' · ')}</Text>
        </Box>
      )}
    </Box>
  )
}

/** Draws a usage row as label, bar and figures, every row's bar `cells` wide so the bars line up. */
function oneUsageRow(ui: PaneElements, cells: number) {
  const { Box, Text } = ui
  return (row: UsageRow) => (
    <Box key={row.label} gap={USAGE_GAP_COLUMNS}>
      <Box width={USAGE_LABEL_COLUMNS} flexShrink={0}>
        <Text dimColor>{row.label}</Text>
      </Box>
      {barRow(ui, row.fraction, cells, usageColour(row))}
      {usageFigures(ui, row)}
    </Box>
  )
}

function twoUsageRows(ui: PaneElements, cells: number, row: UsageRow) {
  const { Box, Text } = ui
  return (
    <Box key={row.label} flexDirection="column">
      {spreadRow(ui, <Text dimColor>{row.label}</Text>, usageFigures(ui, row))}
      {barRow(ui, row.fraction, cells, usageColour(row))}
    </Box>
  )
}

/** What is left for the bars once the labels, the widest figures and the gaps between them have their room. */
function oneRowBarCells(bodyColumns: number, rows: readonly UsageRow[]): number {
  const figuresColumns = Math.max(...rows.map(row => row.figures.length))
  const free = bodyColumns - USAGE_LABEL_COLUMNS - figuresColumns - 2 * USAGE_GAP_COLUMNS
  return Math.max(1, Math.min(MAX_BAR_CELLS, free))
}

function usageFigures({ Text }: PaneElements, row: UsageRow) {
  return row.isWarning ? (
    <Text color={WARNING_FIGURES_COLOUR}>{row.figures}</Text>
  ) : (
    <Text dimColor>{row.figures}</Text>
  )
}

function usageColour(row: UsageRow): Color {
  return row.fraction >= HIGH_USAGE_FRACTION ? HIGH_USAGE_COLOUR : BAR_COLOUR
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
    job => job.line !== null && !isStalled(job, view.nowMs, view.stallMs, view.processStates),
  ).length
  const count = countText(runningCount, unfinished.length, finished.length)

  return (
    <Box flexDirection="column" marginTop={1}>
      {spreadRow(ui, <Text dimColor>Jobs</Text>, jobsHeadingEnd(ui, view, count, hiddenCount))}
      {unfinished.map(job => (
        <Box key={job.file} flexDirection="column" marginTop={1}>
          {unfinishedRows(ui, view, job)}
          {job.file === view.expandedJob &&
            jobDetails(ui, view, job, isStalled(job, view.nowMs, view.stallMs, view.processStates))}
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
  const hasStalled = isStalled(job, view.nowMs, view.stallMs, view.processStates)
  const time = jobTime(ui, view, job, line, hasStalled)

  const processPart = processText(view, job, hasStalled)
  if (line.total === 0) {
    const glyph = hasStalled
      ? <Text dimColor>·</Text>
      : <Text color={BAR_COLOUR}>{spinnerFrame(view.nowMs)}</Text>
    return [
      nameRow(ui, name, <Text dimColor>{processPart}no step count</Text>),
      spreadRow(ui, <Text>{glyph} {line.label}</Text>, time),
    ]
  }

  return [
    nameRow(ui, name, <Text>{processPart}{stepText(line)}</Text>),
    barRow(
      ui,
      line.step / line.total,
      barCellsFor(view.bodyColumns),
      hasStalled ? undefined : BAR_COLOUR,
    ),
    spreadRow(ui, <Text dimColor>{line.label}</Text>, time),
  ]
}

/**
 * `cpu 12% · ` while the job's processes are known, unless the pane is too
 * narrow; `process ended · ` once a stalled job's process has gone, whatever
 * the width, since that is why it stalled. Otherwise nothing.
 */
function processText(view: PaneView, job: Job, hasStalled: boolean): string {
  const state = view.processStates.get(job.file)
  if (state === undefined) return ''
  if (state.kind === 'ended') return hasStalled ? 'process ended · ' : ''
  if (view.bodyColumns < JOB_CPU_MIN_COLUMNS) return ''
  return `cpu ${Math.round(state.cpuPercent)}% · `
}

/**
 * The end of a running job's last row. A stalled job gives how long it ran
 * before its file went quiet, which stays put, so the pane need not be
 * redrawn for it; a quiet job whose processes are busy, how long its file has
 * been quiet; any other job, its running time.
 */
function jobTime({ Text }: PaneElements, view: PaneView, job: Job, line: RunningLine, hasStalled: boolean) {
  if (hasStalled) {
    return (
      <Text color={STALLED_COLOUR}>
        stalled after {durationText(job.mtimeMs / MS_PER_SECOND - line.startedSec)}
      </Text>
    )
  }
  if (isQuietButBusy(job, view.nowMs, view.stallMs, view.processStates)) {
    return <Text>quiet {durationText((view.nowMs - job.mtimeMs) / MS_PER_SECOND)} · busy</Text>
  }
  return <Text dimColor>{runningTimeText(line, view.nowMs)}</Text>
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
