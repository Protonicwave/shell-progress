import type { AgentInfo, SessionRateLimit, SessionUsage, ToolResultOf } from 'claude-code'

import type { AgentCost, EndedCall, LimitReading, ListedAgent, RunningCall, ToolCalls, TurnContext } from '../types'
import { MS_PER_SECOND, SECONDS_PER_MINUTE, clockTimeText, durationText } from './progress'

/** How many ended calls the pane lists, newest first. */
const RECENT_CALL_COUNT = 3
// Parallel calls are few; past this the oldest is dropped, as the end of the
// turn would drop it, so a call whose end is never heard cannot grow the list.
const MAX_RUNNING_CALLS = 20
// The pane draws at most five agents; past this the oldest cost is dropped,
// which only leaves its agent's row without one.
const MAX_AGENT_COSTS = 50
const PERCENT = 100
const TOKENS_PER_THOUSAND = 1_000
const TOKENS_PER_MILLION = 1_000_000
const FIVE_HOUR_LIMIT_KIND = 'five_hour'
// Readings closer together than this give too rough a rate to project.
const MIN_FORECAST_SPAN_MS = 5 * SECONDS_PER_MINUTE * MS_PER_SECOND
// One reading per turn. The forecast reads only the newest few, so past this
// many the oldest are dropped.
const MAX_LIMIT_READINGS = 20

export const NO_TOOL_CALLS: ToolCalls = { running: [], recent: [] }

/**
 * The one argument of a built-in tool's input worth showing beside its name,
 * on one line; empty for any other tool or an argument that is not text.
 */
export function toolArgumentText(tool: string, input: Readonly<Record<string, unknown>>): string {
  switch (tool) {
    case 'Bash':
      return textOf(input['command']).split('\n', 1)[0] ?? ''
    case 'Read':
    case 'Edit':
    case 'Write':
      return textOf(input['file_path'])
    case 'Grep': {
      const pattern = textOf(input['pattern'])
      const path = textOf(input['path'])
      if (pattern === '') return ''
      return path === '' ? `"${pattern}"` : `"${pattern}" in ${path}`
    }
    case 'Glob':
      return textOf(input['pattern'])
    default:
      return ''
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function recordStart(calls: ToolCalls, call: RunningCall): ToolCalls {
  return { ...calls, running: [...calls.running, call].slice(-MAX_RUNNING_CALLS) }
}

/** Moves the call from the running ones to the head of the recent ones. */
export function recordEnd(calls: ToolCalls, call: EndedCall): ToolCalls {
  return {
    running: calls.running.filter(one => one.id !== call.id),
    recent: [call, ...calls.recent].slice(0, RECENT_CALL_COUNT),
  }
}

/** Drops the calls still running, whose ends will not be heard once the turn is over. */
export function endTurnCalls(calls: ToolCalls): ToolCalls {
  return { ...calls, running: [] }
}

/** `6s` under a minute, `1m 04s` from one. */
export function shortDurationText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  return seconds < SECONDS_PER_MINUTE ? `${seconds}s` : durationText(seconds)
}

/**
 * The agents in `listed`, in the order they were first seen: those in
 * `previous` keep their place and new ones follow in the order listed, since
 * the engine does not promise an order. Gives back `previous` itself when
 * nothing listed changed.
 */
export function mergeAgents(
  previous: readonly ListedAgent[],
  listed: readonly AgentInfo[],
): readonly ListedAgent[] {
  const current = new Map(listed.map(agent => [agent.id, listedAgent(agent)]))
  const seenIds = new Set(previous.map(agent => agent.id))
  const merged = [
    ...previous.flatMap(agent => current.get(agent.id) ?? []),
    ...[...current.values()].filter(agent => !seenIds.has(agent.id)),
  ]
  return isSameAgents(previous, merged) ? previous : merged
}

/**
 * A completed agent's time and tokens; `undefined` for a background launch,
 * whose result comes before it has either, for a record that carries neither,
 * or for figures that are not finite.
 */
export function agentCostOf(record: ToolResultOf<'Agent'> | undefined): AgentCost | undefined {
  if (record === undefined || !('status' in record) || record.status !== 'completed') return undefined
  const { agentId, totalDurationMs, totalTokens } = record
  if (!Number.isFinite(totalDurationMs) || !Number.isFinite(totalTokens)) return undefined
  return { id: agentId, durationMs: totalDurationMs, tokens: totalTokens }
}

/** Adds `cost` as the newest, in place of any earlier one for the same agent. */
export function recordAgentCost(costs: readonly AgentCost[], cost: AgentCost): readonly AgentCost[] {
  return [...costs.filter(one => one.id !== cost.id), cost].slice(-MAX_AGENT_COSTS)
}

/** `0m 40s · 65k tokens`. */
export function agentCostText(cost: AgentCost): string {
  // Under 500 tokens would read `0k`.
  const isUnderThousands = Math.round(cost.tokens / TOKENS_PER_THOUSAND) === 0
  const tokens = isUnderThousands ? String(Math.round(cost.tokens)) : tokensText(cost.tokens)
  return `${durationText(cost.durationMs / MS_PER_SECOND)} · ${tokens} tokens`
}

function listedAgent(agent: AgentInfo): ListedAgent {
  // Last the id, which tells agents apart where nothing else names them.
  const label = [agent.description, agent.name ?? '', agent.type].find(text => text !== '') ?? agent.id
  return { id: agent.id, label, status: agent.status }
}

function isSameAgents(left: readonly ListedAgent[], right: readonly ListedAgent[]): boolean {
  return (
    left.length === right.length &&
    left.every((agent, index) => {
      const other = right[index]
      return (
        other !== undefined &&
        agent.id === other.id &&
        agent.label === other.label &&
        agent.status === other.status
      )
    })
  )
}

/** One usage bar at the foot of the pane: what it measures, how full it is, and its figures. */
export type UsageRow = {
  readonly label: string
  /** From 0 to 1; a limit past 100% fills the bar. */
  readonly fraction: number
  readonly figures: string
  /** Set when the figures say the limit fills before it resets. */
  readonly isWarning: boolean
}

export const NO_TURN_CONTEXT: TurnContext = { startTokens: null, lastAddedTokens: null }

export function startTurnContext(context: TurnContext, usage: SessionUsage): TurnContext {
  return { ...context, startTokens: usage.context.tokens ?? null }
}

/** Records what the turn added, which replaces the last turn's figure even when it is unknown. */
export function endTurnContext(context: TurnContext, usage: SessionUsage): TurnContext {
  const endTokens = usage.context.tokens
  const isCounted = context.startTokens !== null && endTokens !== undefined
  return {
    startTokens: null,
    lastAddedTokens: isCounted ? endTokens - context.startTokens : null,
  }
}

/**
 * The context window's bar and the five-hour limit's, each only when the
 * session has its reading: none before the first response, no limit off a
 * subscription, and neither for a percentage that is not a finite number.
 * The context figures end with `lastAddedTokens`, unless it rounds to none,
 * and the limit's give the time `limitReadings` say it fills, if that comes
 * before its reset.
 */
export function usageRows(
  usage: SessionUsage,
  lastAddedTokens: number | null,
  limitReadings: readonly LimitReading[],
  nowMs: number,
): readonly UsageRow[] {
  const rows: UsageRow[] = []
  const { tokens, window } = usage.context
  const percent = contextPercent(usage)
  if (percent !== undefined) {
    const tokenFigures = tokens === undefined ? '' : ` · ${tokensText(tokens)} of ${tokensText(window)}`
    rows.push(usageRow('context', percent, tokenFigures + addedTokensText(lastAddedTokens)))
  }
  const limit = fiveHourLimit(usage)
  if (limit !== undefined) {
    const resetsMs = resetsMsOf(limit)
    if (resetsMs === undefined) {
      rows.push(usageRow('5h limit', limit.percentUsed, ''))
    } else {
      const fullMs = limitForecast(limitReadings, nowMs, resetsMs)
      const laterFigures =
        fullMs === null
          ? ` · resets ${clockTimeText(resetsMs, false)}`
          : ` · full by ${clockTimeText(fullMs, false)}`
      rows.push(usageRow('5h limit', limit.percentUsed, laterFigures, fullMs !== null))
    }
  }
  return rows
}

/** The context window's percentage, when the session has a finite one. */
function contextPercent(usage: SessionUsage): number | undefined {
  const { percent } = usage.context
  return percent !== undefined && Number.isFinite(percent) ? percent : undefined
}

/** The five-hour limit, when the session has one with a finite percentage. */
function fiveHourLimit(usage: SessionUsage): SessionRateLimit | undefined {
  const limit = usage.rateLimits.find(one => one.kind === FIVE_HOUR_LIMIT_KIND)
  return limit !== undefined && Number.isFinite(limit.percentUsed) ? limit : undefined
}

function resetsMsOf(limit: SessionRateLimit): number | undefined {
  const resetsMs = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
  return Number.isNaN(resetsMs) ? undefined : resetsMs
}

/** Adds the five-hour reading, when the session has one with a reset time. */
export function recordLimitReading(
  readings: readonly LimitReading[],
  usage: SessionUsage,
  nowMs: number,
): readonly LimitReading[] {
  const limit = fiveHourLimit(usage)
  if (limit === undefined) return readings
  const resetsMs = resetsMsOf(limit)
  if (resetsMs === undefined) return readings
  return [...readings, { atMs: nowMs, percentUsed: limit.percentUsed, resetsMs }].slice(-MAX_LIMIT_READINGS)
}

/**
 * When the five-hour limit that resets at `resetsMs` fills, at the rate
 * between its newest reading and the newest one at least
 * MIN_FORECAST_SPAN_MS before it. `null` when no such pair exists, the
 * percentage did not rise, the limit is full, or the fill time is not
 * between now and the reset. Readings from another window are left out.
 */
function limitForecast(
  readings: readonly LimitReading[],
  nowMs: number,
  resetsMs: number,
): number | null {
  const sameWindow = readings.filter(one => one.resetsMs === resetsMs)
  const newest = sameWindow.at(-1)
  if (newest === undefined || newest.percentUsed >= PERCENT) return null
  const older = sameWindow.findLast(one => newest.atMs - one.atMs >= MIN_FORECAST_SPAN_MS)
  if (older === undefined || newest.percentUsed <= older.percentUsed) return null
  const percentPerMs = (newest.percentUsed - older.percentUsed) / (newest.atMs - older.atMs)
  const fullMs = newest.atMs + (PERCENT - newest.percentUsed) / percentPerMs
  return fullMs > nowMs && fullMs < resetsMs ? fullMs : null
}

/** A bar for `percent`, its figures the rounded percentage then `laterFigures`. */
function usageRow(label: string, percent: number, laterFigures: string, isWarning = false): UsageRow {
  return {
    label,
    fraction: Math.min(1, Math.max(0, percent / PERCENT)),
    figures: `${Math.round(percent)}%${laterFigures}`,
    isWarning,
  }
}

/** ` · +12k` or ` · -61k`; empty for `null` or what rounds to no thousands. */
function addedTokensText(addedTokens: number | null): string {
  if (addedTokens === null || Math.round(Math.abs(addedTokens) / TOKENS_PER_THOUSAND) === 0) return ''
  return ` · ${addedTokens > 0 ? '+' : '-'}${tokensText(Math.abs(addedTokens))}`
}

/** `76k`, or `1M` from a million. */
function tokensText(tokens: number): string {
  const thousands = Math.round(tokens / TOKENS_PER_THOUSAND)
  if (thousands < TOKENS_PER_THOUSAND) return `${thousands}k`
  return `${Number((tokens / TOKENS_PER_MILLION).toFixed(1))}M`
}

/** `session cost $1.84`, or `undefined` where the host keeps no cost. */
export function costText(usage: SessionUsage): string | undefined {
  return usage.cost === undefined ? undefined : `session cost ${dollarsText(usage.cost.usd)}`
}

function dollarsText(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/**
 * `ctx 38% · 5h 63% · $1.84`, for the prompt hint while the pane is not in
 * view: each figure the session has, or `undefined` with none.
 */
export function usageHintText(usage: SessionUsage): string | undefined {
  const percent = contextPercent(usage)
  const limit = fiveHourLimit(usage)
  const figures = [
    ...(percent === undefined ? [] : [`ctx ${Math.round(percent)}%`]),
    ...(limit === undefined ? [] : [`5h ${Math.round(limit.percentUsed)}%`]),
    ...(usage.cost === undefined ? [] : [dollarsText(usage.cost.usd)]),
  ]
  return figures.length === 0 ? undefined : figures.join(' · ')
}
