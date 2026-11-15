import { describe, expect, test } from 'claude-code/testing'
import type { AgentInfo, AgentStatus, BuiltinToolResults, SessionUsage } from 'claude-code'

import type { AgentCost, EndedCall, LimitReading, RunningCall, ToolCalls } from '../types'
import {
  NO_TOOL_CALLS,
  NO_TURN_CONTEXT,
  agentCostOf,
  agentCostText,
  costText,
  endTurnContext,
  shortDurationText,
  endTurnCalls,
  mergeAgents,
  recordAgentCost,
  recordEnd,
  recordLimitReading,
  recordStart,
  startTurnContext,
  toolArgumentText,
  usageRows,
  usageHintText,
} from '../hooks/session'
import { completedAgentRecord } from './fake-world'

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
const localClock = (ms: number) => {
  const time = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(time.getHours())}:${pad(time.getMinutes())}`
}
const resetsClock = localClock(RESETS_MS)

const usage = (fields: Partial<SessionUsage>): SessionUsage => ({
  startedAt: 0,
  context: { window: 200_000 },
  rateLimits: [],
  ...fields,
})

describe('usageRows', () => {
  test('gives the context and five-hour bars with their figures', () => {
    const rows = usageRows(
      usage({
        context: { tokens: 76_000, window: 200_000, percent: 38 },
        rateLimits: [
          { kind: 'seven_day', percentUsed: 12 },
          { kind: 'five_hour', percentUsed: 63.5, resetsAt: new Date(RESETS_MS).toISOString() },
        ],
      }),
      null,
      [],
      0,
    )
    expect(rows).toEqual([
      { label: 'context', fraction: 0.38, figures: '38% · 76k of 200k', isWarning: false },
      { label: '5h limit', fraction: 0.635, figures: `64% · resets ${resetsClock}`, isWarning: false },
    ])
  })

  test('a percentage that is not a finite number leaves its bar out', () => {
    const rows = usageRows(
      usage({
        context: { window: 200_000, percent: Number.NaN },
        rateLimits: [{ kind: 'five_hour', percentUsed: Number.POSITIVE_INFINITY }],
      }),
      null,
      [],
      0,
    )
    expect(rows).toEqual([])
  })

  test('a fresh session with no limit reading has no bars', () => {
    expect(usageRows(usage({}), null, [], 0)).toEqual([])
  })

  test('a context reading without tokens, or a limit without a reset, shows the percentage alone', () => {
    const rows = usageRows(
      usage({
        context: { window: 200_000, percent: 5 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 7 }],
      }),
      null,
      [],
      0,
    )
    expect(rows.map(row => row.figures)).toEqual(['5%', '7%'])
  })

  test('a reset time that is not a date is left out', () => {
    const soon = usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 7, resetsAt: 'soon' }] })
    const rows = usageRows(soon, null, [], 0)
    expect(rows.map(row => row.figures)).toEqual(['7%'])
  })

  test('a window of a million tokens or more is counted in millions', () => {
    const million = usage({ context: { tokens: 250_000, window: 1_000_000, percent: 25 } })
    const rows = usageRows(million, null, [], 0)
    expect(rows[0]?.figures).toBe('25% · 250k of 1M')
  })

  test('a limit past 100% fills its bar and no more', () => {
    const rows = usageRows(usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 104 }] }), null, [], 0)
    expect(rows[0]).toEqual({ label: '5h limit', fraction: 1, figures: '104%', isWarning: false })
  })
})

describe('usageRows with the context the last turn added', () => {
  const at88k = usage({ context: { tokens: 88_000, window: 200_000, percent: 44 } })
  const contextOf = (lastAddedTokens: number | null) => usageRows(at88k, lastAddedTokens, [], 0)[0]?.figures

  test('ends the context figures with what the turn added', () => {
    expect(contextOf(12_400)).toBe('44% · 88k of 200k · +12k')
  })

  test('shows a context that shrank, as after compaction, as a negative figure', () => {
    expect(contextOf(-61_000)).toBe('44% · 88k of 200k · -61k')
  })

  for (const added of [0, 400, -499, null]) {
    test(`shows nothing for ${added} tokens added`, () => {
      expect(contextOf(added)).toBe('44% · 88k of 200k')
    })
  }
})

const MINUTE_MS = 60_000
const reading = (minutesBeforeReset: number, percentUsed: number, resetsMs = RESETS_MS): LimitReading => ({
  atMs: RESETS_MS - minutesBeforeReset * MINUTE_MS,
  percentUsed,
  resetsMs,
})

describe('the five-hour forecast', () => {
  // 10 points in 20 minutes: the 40 left take 80 minutes from the newest reading.
  const rising = [reading(120, 50), reading(100, 60)]
  const newestMs = RESETS_MS - 100 * MINUTE_MS
  const fullBy80 = `full by ${localClock(newestMs + 80 * MINUTE_MS)}`
  const resets = `resets ${resetsClock}`
  /** The five-hour row's figures after the percentage, at `nowMs`, with the limit at the newest reading. */
  const laterFigures = (readings: readonly LimitReading[], nowMs = newestMs) => {
    const percentUsed = readings.at(-1)?.percentUsed ?? 60
    const limit = { kind: 'five_hour', percentUsed, resetsAt: new Date(RESETS_MS).toISOString() } as const
    const figures = usageRows(usage({ rateLimits: [limit] }), null, readings, nowMs)[0]?.figures
    return figures?.slice(figures.indexOf(' · ') + ' · '.length)
  }

  test('projects the rate between two readings to when the limit fills', () => {
    expect(laterFigures(rising)).toBe(fullBy80)
  })

  test('takes the rate from the newest reading at least 5 minutes before the newest', () => {
    const readings = [reading(160, 10), reading(120, 50), reading(103, 59), reading(100, 60)]
    expect(laterFigures(readings)).toBe(fullBy80)
  })

  test('gives none for readings under 5 minutes apart', () => {
    expect(laterFigures([reading(104, 50), reading(100, 60)])).toBe(resets)
  })

  test('gives none for a single reading or none', () => {
    expect(laterFigures([reading(100, 60)])).toBe(resets)
    expect(laterFigures([])).toBe(resets)
  })

  test('gives none for a percentage that held or fell', () => {
    expect(laterFigures([reading(120, 60), reading(100, 60)])).toBe(resets)
    expect(laterFigures([reading(120, 70), reading(100, 60)])).toBe(resets)
  })

  test('gives none when the limit resets before it would fill', () => {
    expect(laterFigures([reading(60, 50), reading(40, 60)], RESETS_MS - 40 * MINUTE_MS)).toBe(resets)
  })

  test('gives none once the reset has passed', () => {
    expect(laterFigures(rising, RESETS_MS)).toBe(resets)
  })

  test('gives none for a fill time already past', () => {
    expect(laterFigures(rising, newestMs + 81 * MINUTE_MS)).toBe(resets)
  })

  test('gives none for a limit already full', () => {
    expect(laterFigures([reading(120, 90), reading(100, 100)])).toBe(resets)
  })

  test('leaves out readings from an earlier window', () => {
    const earlierResetMs = RESETS_MS - 300 * MINUTE_MS
    expect(laterFigures([reading(120, 5, earlierResetMs), reading(100, 60)])).toBe(resets)
  })
})

describe('recordLimitReading', () => {
  const fiveHour = (percentUsed: number, resetsAt?: string) =>
    usage({
      rateLimits: [{ kind: 'five_hour', percentUsed, ...(resetsAt === undefined ? {} : { resetsAt }) }],
    })

  test('adds the five-hour reading with when it was taken', () => {
    const recorded = recordLimitReading([], fiveHour(42.5, new Date(RESETS_MS).toISOString()), 1_000)
    expect(recorded).toEqual([{ atMs: 1_000, percentUsed: 42.5, resetsMs: RESETS_MS }])
  })

  test('adds nothing for a limit with no reset, a reset that is not a date, or no limit', () => {
    expect(recordLimitReading([], fiveHour(42), 1_000)).toEqual([])
    expect(recordLimitReading([], fiveHour(42, 'soon'), 1_000)).toEqual([])
    expect(recordLimitReading([], fiveHour(Number.NaN, new Date(RESETS_MS).toISOString()), 1_000)).toEqual([])
    expect(recordLimitReading([], usage({}), 1_000)).toEqual([])
  })

  test('keeps the newest 20', () => {
    const resetsAt = new Date(RESETS_MS).toISOString()
    let readings: readonly LimitReading[] = []
    for (let turn = 0; turn < 25; turn += 1) {
      readings = recordLimitReading(readings, fiveHour(turn, resetsAt), turn)
    }
    expect(readings.map(one => one.atMs)).toEqual(Array.from({ length: 20 }, (_, index) => index + 5))
  })
})

describe('usageRows with a forecast', () => {
  const at = (percentUsed: number) =>
    usage({ rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt: new Date(RESETS_MS).toISOString() }] })
  const newestMs = RESETS_MS - 100 * MINUTE_MS

  test('gives the time the limit fills, in place of the reset, as a warning', () => {
    const rows = usageRows(at(60), null, [reading(120, 50), reading(100, 60)], newestMs)
    const fullClock = localClock(newestMs + 80 * MINUTE_MS)
    expect(rows[0]).toMatchObject({ figures: `60% · full by ${fullClock}`, isWarning: true })
  })

  test('keeps the reset time when the limit resets first', () => {
    const rows = usageRows(at(60), null, [reading(120, 58), reading(100, 60)], newestMs)
    expect(rows[0]).toMatchObject({ figures: `60% · resets ${resetsClock}`, isWarning: false })
  })
})

describe('turn context', () => {
  const at = (tokens: number | undefined) =>
    usage({ context: tokens === undefined ? { window: 200_000 } : { tokens, window: 200_000 } })

  test('a finished turn records what it added since it started', () => {
    const started = startTurnContext(NO_TURN_CONTEXT, at(76_000))
    expect(endTurnContext(started, at(88_000))).toEqual({ startTokens: null, lastAddedTokens: 12_000 })
  })

  test('a turn that started before the first response records nothing', () => {
    const started = startTurnContext(NO_TURN_CONTEXT, at(undefined))
    expect(endTurnContext(started, at(30_000))).toEqual(NO_TURN_CONTEXT)
  })

  test('a turn whose end has no reading replaces the last figure with none', () => {
    const earlier = { startTokens: 76_000, lastAddedTokens: 5_000 }
    expect(endTurnContext(earlier, at(undefined))).toEqual(NO_TURN_CONTEXT)
  })

  test('starting a turn keeps the figure the last turn left', () => {
    const earlier = { startTokens: null, lastAddedTokens: 5_000 }
    expect(startTurnContext(earlier, at(80_000))).toEqual({ startTokens: 80_000, lastAddedTokens: 5_000 })
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

describe('usageHintText', () => {
  test('gives the context, the five-hour limit and the cost', () => {
    const full = usage({
      context: { tokens: 76_000, window: 200_000, percent: 37.6 },
      rateLimits: [
        { kind: 'seven_day', percentUsed: 12 },
        { kind: 'five_hour', percentUsed: 63.2 },
      ],
      cost: { usd: 1.8361 },
    })
    expect(usageHintText(full)).toBe('ctx 38% · 5h 63% · $1.84')
  })

  test('leaves out each figure the session lacks', () => {
    expect(usageHintText(usage({ cost: { usd: 0.5 } }))).toBe('$0.50')
    const limitOnly = usage({ rateLimits: [{ kind: 'five_hour', percentUsed: 104 }] })
    expect(usageHintText(limitOnly)).toBe('5h 104%')
  })

  test('leaves out a percentage that is not a finite number', () => {
    const broken = usage({
      context: { window: 200_000, percent: Number.NaN },
      rateLimits: [{ kind: 'five_hour', percentUsed: Number.POSITIVE_INFINITY }],
    })
    expect(usageHintText(broken)).toBeUndefined()
  })
})

const cost = (id: string, durationMs = 40_000, tokens = 65_200): AgentCost => ({ id, durationMs, tokens })

describe('agentCostOf', () => {
  test("records a completed agent's time and tokens", () => {
    expect(agentCostOf(completedAgentRecord('a1', 40_000, 65_200))).toEqual(cost('a1'))
  })

  test('records nothing for a background launch, which has neither yet', () => {
    const launched: BuiltinToolResults['Agent'] = {
      status: 'async_launched',
      agentId: 'a1',
      description: 'find callers',
      prompt: 'find the callers',
      outputFile: '/tmp/a1.txt',
    }
    expect(agentCostOf(launched)).toBeUndefined()
  })

  test('records nothing for a missing record or figures that are not finite', () => {
    expect(agentCostOf(undefined)).toBeUndefined()
    expect(agentCostOf(completedAgentRecord('a1', Number.NaN, 65_200))).toBeUndefined()
    expect(agentCostOf(completedAgentRecord('a1', 40_000, Number.POSITIVE_INFINITY))).toBeUndefined()
  })
})

describe('recordAgentCost', () => {
  test("replaces an agent's earlier cost and keeps the newest last", () => {
    const costs = recordAgentCost([cost('a1'), cost('a2')], cost('a1', 90_000, 120_000))
    expect(costs).toEqual([cost('a2'), cost('a1', 90_000, 120_000)])
  })

  test('keeps the newest 50', () => {
    let costs: readonly AgentCost[] = []
    for (let index = 0; index < 51; index += 1) costs = recordAgentCost(costs, cost(`a${index}`))
    expect(costs).toHaveLength(50)
    expect(costs[0]?.id).toBe('a1')
    expect(costs.at(-1)?.id).toBe('a50')
  })
})

describe('agentCostText', () => {
  for (const [durationMs, tokens, text] of [
    [40_000, 65_200, '0m 40s · 65k tokens'],
    [3_725_000, 1_250_000, '1h 02m · 1.3M tokens'],
    [900, 420, '0m 00s · 420 tokens'],
  ] as const) {
    test(`shows ${durationMs} ms and ${tokens} tokens as ${text}`, () => {
      expect(agentCostText(cost('a1', durationMs, tokens))).toBe(text)
    })
  }
})
