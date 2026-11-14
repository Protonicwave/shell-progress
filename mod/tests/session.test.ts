import { describe, expect, test } from 'claude-code/testing'

import type { EndedCall, RunningCall, ToolCalls } from '../types'
import {
  NO_TOOL_CALLS,
  RECENT_CALL_COUNT,
  shortDurationText,
  endTurnCalls,
  recordEnd,
  recordStart,
  toolArgumentText,
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
    expect(RECENT_CALL_COUNT).toBe(3)
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
