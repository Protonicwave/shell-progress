import type { AgentInfo, SessionUsage } from 'claude-code'

import type { EndedCall, ListedAgent, RunningCall, ToolCalls } from '../types'
import { MS_PER_SECOND, durationText } from './progress'

/** How many ended calls the pane lists, newest first. */
export const RECENT_CALL_COUNT = 3
// Parallel calls are few; past this the oldest is dropped, as the end of the
// turn would drop it, so a call whose end is never heard cannot grow the list.
const MAX_RUNNING_CALLS = 20
const SECONDS_PER_MINUTE = 60

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

function listedAgent(agent: AgentInfo): ListedAgent {
  const label = [agent.description, agent.name ?? '', agent.type].find(text => text !== '') ?? ''
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

/** One bar under the pane's groups: what it measures, how full it is, and its figures. */
export type UsageBar = {
  readonly label: string
  /** From 0 to 1; a limit past 100% fills the bar. */
  readonly fraction: number
  readonly figures: string
}

const PERCENT = 100
const TOKENS_PER_THOUSAND = 1_000
const TOKENS_PER_MILLION = 1_000_000
const FIVE_HOUR_LIMIT_KIND = 'five_hour'

/**
 * The context window's bar and the five-hour limit's, each only when the
 * session has its reading: none before the first response, and no limit off a
 * subscription.
 */
export function usageBars(usage: SessionUsage): readonly UsageBar[] {
  const bars: UsageBar[] = []
  const { tokens, window, percent } = usage.context
  if (percent !== undefined) {
    const of = tokens === undefined ? '' : ` · ${tokensText(tokens)} of ${tokensText(window)}`
    bars.push(usageBar('context', percent, of))
  }
  const limit = usage.rateLimits.find(one => one.kind === FIVE_HOUR_LIMIT_KIND)
  if (limit !== undefined) {
    const resets = limit.resetsAt === undefined ? undefined : new Date(limit.resetsAt)
    const isValid = resets !== undefined && !Number.isNaN(resets.getTime())
    // ECMA-262 fixes toTimeString's form as `HH:mm:ss GMT+hhmm (zone)`.
    const when = isValid ? ` · resets ${resets.toTimeString().slice(0, 5)}` : ''
    bars.push(usageBar('5-hour limit', limit.percentUsed, when))
  }
  return bars
}

function usageBar(label: string, percent: number, rest: string): UsageBar {
  return {
    label,
    fraction: Math.min(1, Math.max(0, percent / PERCENT)),
    figures: `${Math.round(percent)}%${rest}`,
  }
}

/** `76k`, or `1M` from a million. */
function tokensText(tokens: number): string {
  const thousands = Math.round(tokens / TOKENS_PER_THOUSAND)
  if (thousands < TOKENS_PER_THOUSAND) return `${thousands}k`
  return `${Number((tokens / TOKENS_PER_MILLION).toFixed(1))}M`
}

/** `session cost $1.84`, or `undefined` where the host keeps no cost. */
export function costText(usage: SessionUsage): string | undefined {
  return usage.cost === undefined ? undefined : `session cost $${usage.cost.usd.toFixed(2)}`
}
