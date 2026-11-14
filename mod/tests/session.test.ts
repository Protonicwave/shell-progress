import { describe, expect, test } from 'claude-code/testing'
import type { AgentInfo, AgentStatus, SessionUsage } from 'claude-code'

import type { EndedCall, RunningCall, ToolCalls } from '../types'
import {
  NO_TOOL_CALLS,
  costText,
  shortDurationText,
  endTurnCalls,
  mergeAgents,
  recordEnd,
  recordStart,
  toolArgumentText,
  usageBars,
} from '../hooks/session'

const runningCall = (id: string, startedMs = 0): RunningCall => ({
  id,
  tool: 'Bash',
  argument: `echo ${id}`,
  startedMs,
})

const endedCall = (id: string, hasFailed = false): EndedCall => ({
  ...runningCall(id),
  endedMs: 1_000,
  hasFailed,
})

const ARGUMENT_CASES: readonly (readonly [string, Record<string, unknown>, string])[] = [
  ['Bash', { command: 'npm test -- orders' }, 'npm test -- orders'],
  ['Bash', { command: 'cd mod\nnpm test' }, 'cd mod'],
  ['Read', { file_path: 'docs/migrations.md' }, 'docs/migrations.md'],
  ['Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'src/a.ts'],
  ['Write', { file_path: 'src/b.ts', content: 'x' }, 'src/b.ts'],
  ['Grep', { pattern: 'orders' }, '"orders"'],
  ['Grep', { pattern: 'orders', path: 'migrations/' }, '"orders" in migrations/'],
  ['Glob', { pattern: '**/*.sql' }, '**/*.sql'],
  ['mcp__docs__search', { query: 'orders' }, ''],
]

describe('toolArgumentText', () => {
  for (const [tool, input, expected] of ARGUMENT_CASES) {
    test(`${tool} with ${JSON.stringify(input)} shows ${JSON.stringify(expected)}`, () => {
      expect(toolArgumentText(tool, input)).toBe(expected)
    })
  }

  test('an argument of the wrong type shows nothing', () => {
    expect(toolArgumentText('Bash', { command: 42 })).toBe('')
    expect(toolArgumentText('Read', {})).toBe('')
  })
})

describe('recordStart and recordEnd', () => {
  test('an ended call leaves the running calls and leads the recent ones', () => {
    const started = recordStart(recordStart(NO_TOOL_CALLS, runningCall('a')), runningCall('b'))
    expect(started.running.map(call => call.id)).toEqual(['a', 'b'])

    const ended = recordEnd(started, endedCall('a', true))
    expect(ended.running.map(call => call.id)).toEqual(['b'])
    expect(ended.recent).toEqual([endedCall('a', true)])
  })

  test('recent keeps the newest calls, newest first', () => {
    let calls: ToolCalls = NO_TOOL_CALLS
    for (const id of ['a', 'b', 'c', 'd']) {
      calls = recordEnd(recordStart(calls, runningCall(id)), endedCall(id))
    }
    expect(calls.recent.map(call => call.id)).toEqual(['d', 'c', 'b'])
  })

  test('a call that ends without a recorded start still joins the recent ones', () => {
    const calls = recordEnd(NO_TOOL_CALLS, endedCall('a'))
    expect(calls).toEqual({ running: [], recent: [endedCall('a')] })
  })

  test('past 20 running calls the oldest is dropped', () => {
    let calls: ToolCalls = NO_TOOL_CALLS
    for (let index = 0; index < 21; index += 1) {
      calls = recordStart(calls, runningCall(String(index)))
    }
    expect(calls.running).toHaveLength(20)
    expect(calls.running[0]?.id).toBe('1')
  })

  test('the end of a turn drops the calls still running and keeps the recent ones', () => {
    const calls = recordEnd(recordStart(recordStart(NO_TOOL_CALLS, runningCall('a')), runningCall('b')), endedCall('a'))
    expect(endTurnCalls(calls)).toEqual({ running: [], recent: [endedCall('a')] })
  })
})

describe('shortDurationText', () => {
  const cases = [
    [0, '0s'],
    [999, '0s'],
    [6_400, '6s'],
    [59_999, '59s'],
    [64_000, '1m 04s'],
  ] as const
  for (const [ms, expected] of cases) {
    test(`${ms} ms reads ${expected}`, () => {
      expect(shortDurationText(ms)).toBe(expected)
    })
  }
})

const agentInfo = (id: string, status: AgentStatus = 'running', description = `task ${id}`): AgentInfo => ({
  id,
  description,
  type: 'Explore',
  status,
})

describe('mergeAgents', () => {
  test('lists each agent by its description and status', () => {
    expect(mergeAgents([], [agentInfo('a'), agentInfo('b', 'completed')])).toEqual([
      { id: 'a', label: 'task a', status: 'running' },
      { id: 'b', label: 'task b', status: 'completed' },
    ])
  })

  test('an agent with no description is labelled by its name, else its type', () => {
    const named = { ...agentInfo('a', 'idle', ''), name: 'reviewer' }
    const unnamed = agentInfo('b', 'idle', '')
    expect(mergeAgents([], [named, unnamed]).map(agent => agent.label)).toEqual(['reviewer', 'Explore'])
  })

  test('an agent with no description, name or type is labelled by its id', () => {
    const blank = { ...agentInfo('a7f3', 'idle', ''), type: '' }
    expect(mergeAgents([], [blank]).map(agent => agent.label)).toEqual(['a7f3'])
  })

  test('agents keep the order they were first seen in, whatever order they are listed in', () => {
    const first = mergeAgents([], [agentInfo('a'), agentInfo('b')])
    const second = mergeAgents(first, [agentInfo('c'), agentInfo('b', 'completed'), agentInfo('a')])
    expect(second.map(agent => [agent.id, agent.status])).toEqual([
      ['a', 'running'],
      ['b', 'completed'],
      ['c', 'running'],
    ])
  })

  test('an agent no longer listed is dropped', () => {
    const first = mergeAgents([], [agentInfo('a'), agentInfo('b')])
    expect(mergeAgents(first, [agentInfo('b')]).map(agent => agent.id)).toEqual(['b'])
  })

  test('an id listed twice is kept once', () => {
    expect(mergeAgents([], [agentInfo('a'), agentInfo('a', 'completed')])).toEqual([
      { id: 'a', label: 'task a', status: 'completed' },
    ])
  })

  test('an unchanged listing gives back the same list, so nothing is stored or drawn again', () => {
    const first = mergeAgents([], [agentInfo('a'), agentInfo('b')])
    expect(mergeAgents(first, [agentInfo('b'), agentInfo('a')])).toBe(first)
    expect(mergeAgents([], [])).toEqual([])
  })
})

const RESETS_MS = Date.UTC(2026, 10, 14, 16, 0)
// The reset is shown in local time, so the expected text is worked out here.
const resetsClock = (() => {
  const resets = new Date(RESETS_MS)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(resets.getHours())}:${pad(resets.getMinutes())}`
})()

const usage = (fields: Partial<SessionUsage>): SessionUsage => ({
  startedAt: 0,
  context: { window: 200_000 },
  rateLimits: [],
  ...fields,
})

describe('usageBars', () => {
  test('gives the context and five-hour bars with their figures', () => {
    const bars = usageBars(
      usage({
        context: { tokens: 76_000, window: 200_000, percent: 38 },
        rateLimits: [
          { kind: 'seven_day', percentUsed: 12 },
          { kind: 'five_hour', percentUsed: 63.5, resetsAt: new Date(RESETS_MS).toISOString() },
        ],
      }),
    )
    expect(bars).toEqual([
      { label: 'context', fraction: 0.38, figures: '38% · 76k of 200k' },
      { label: '5-hour limit', fraction: 0.635, figures: `64% · resets ${resetsClock}` },
    ])
  })

  test('a percentage that is not a finite number leaves its bar out', () => {
    const bars = usageBars(
      usage({
        context: { window: 200_000, percent: Number.NaN },
        rateLimits: [{ kind: 'five_hour', percentUsed: Number.POSITIVE_INFINITY }],
      }),
    )
    expect(bars).toEqual([])
  })

  test('a fresh session with no limit reading has no bars', () => {
    expect(usageBars(usage({}))).toEqual([])
  })

  test('a context reading without tokens, or a limit without a reset, shows the percentage alone', () => {
    const bars = usageBars(
      usage({
        context: { window: 200_000, percent: 5 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 7 }],
      }),
    )
    expect(bars.map(bar => bar.figures)).toEqual(['5%', '7%'])
  })

  test('a reset time that is not a date is left out', () => {
    const bars = usageBars(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 7, resetsAt: 'soon' }] }))
    expect(bars.map(bar => bar.figures)).toEqual(['7%'])
  })

  test('a window of a million tokens or more is counted in millions', () => {
    const bars = usageBars(usage({ context: { tokens: 250_000, window: 1_000_000, percent: 25 } }))
    expect(bars[0]?.figures).toBe('25% · 250k of 1M')
  })

  test('a limit past 100% fills its bar and no more', () => {
    const bars = usageBars(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 104 }] }))
    expect(bars[0]).toEqual({ label: '5-hour limit', fraction: 1, figures: '104%' })
  })
})

describe('costText', () => {
  test('gives the cost in dollars and cents', () => {
    expect(costText(usage({ cost: { usd: 1.8361 } }))).toBe('session cost $1.84')
  })

  test('is undefined where the host keeps no cost', () => {
    expect(costText(usage({}))).toBeUndefined()
  })
})
