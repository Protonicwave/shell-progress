import { describe, expect, test } from 'claude-code/testing'

import type { BackgroundShell } from '../types'
import { endShellsNotInFlight, recordShellEnds, recordShellStart, shellRows, taskNoticesIn } from '../hooks/shells'

const running = (id: string, startedMs = 0): BackgroundShell => ({
  id,
  tool: 'Bash',
  command: `sleep 100 # ${id}`,
  startedMs,
  state: { kind: 'running' },
})

function notification(id: string, status: string): string {
  return [
    '<task-notification>',
    `<task-id>${id}</task-id>`,
    '<tool-use-id>toolu_1</tool-use-id>',
    `<status>${status}</status>`,
    '<summary>Background command completed</summary>',
    '</task-notification>',
  ].join('\n')
}

/** Each shell's label and status as the pane lists it. */
function listed(shells: readonly BackgroundShell[], nowMs = 0): readonly string[] {
  return shellRows(shells, nowMs).rows.map(row => `${row.label}: ${row.status} ${row.durationMs}`)
}

describe('taskNoticesIn', () => {
  test('reads each notification of a prompt, in order', () => {
    const text = `${notification('b1', 'completed')}\n${notification('b2', 'killed')}`
    expect(taskNoticesIn(text)).toEqual([
      { id: 'b1', status: 'completed' },
      { id: 'b2', status: 'killed' },
    ])
  })

  test('leaves out a block without a task id and keeps one without a status', () => {
    const text = [
      '<task-notification><status>completed</status></task-notification>',
      '<task-notification><task-id> b3 </task-id></task-notification>',
    ].join('')
    expect(taskNoticesIn(text)).toEqual([{ id: 'b3', status: undefined }])
  })

  test('finds nothing in a prompt without a notification', () => {
    expect(taskNoticesIn('fix the tests')).toEqual([])
  })
})

describe('recordShellEnds', () => {
  test('ends each shell named with the status it was given, at the time it came', () => {
    const shells = ['b1', 'b2', 'b3', 'b4'].map(id => running(id))
    const ended = recordShellEnds(
      shells,
      [
        { id: 'b1', status: 'completed' },
        { id: 'b2', status: 'failed' },
        { id: 'b3', status: 'killed' },
        { id: 'b4', status: 'paused' },
      ],
      7_000,
    )
    expect(listed(ended)).toEqual([
      'sleep 100 # b4: ended 7000',
      'sleep 100 # b3: stopped 7000',
      'sleep 100 # b2: failed 7000',
    ])
    expect(ended.find(shell => shell.id === 'b1')?.state).toEqual({ kind: 'ended', end: 'completed', endedMs: 7_000 })
  })

  test('a notice for another task, or a second one for an ended shell, changes nothing', () => {
    const shells = recordShellEnds([running('b1')], [{ id: 'b1', status: 'completed' }], 3_000)
    expect(recordShellEnds(shells, [{ id: 'b1', status: 'failed' }], 6_000)).toBe(shells)
    expect(recordShellEnds(shells, [{ id: 'elsewhere', status: 'failed' }], 6_000)).toBe(shells)
  })

  test("gives the status of a shell a turn's end had already marked ended", () => {
    const unheard = endShellsNotInFlight([running('b1')], new Set(), 4_000)
    expect(listed(unheard)).toEqual(['sleep 100 # b1: ended 4000'])
    expect(listed(recordShellEnds(unheard, [{ id: 'b1', status: 'completed' }], 5_000))).toEqual([
      'sleep 100 # b1: completed 5000',
    ])
  })
})

describe('endShellsNotInFlight', () => {
  test('ends only the running shells missing from the list', () => {
    const shells = [running('b1'), running('b2')]
    expect(listed(endShellsNotInFlight(shells, new Set(['b2']), 4_000), 5_000)).toEqual([
      'sleep 100 # b2: running 5000',
      'sleep 100 # b1: ended 4000',
    ])
  })

  test('gives back the same list when every running shell is in flight', () => {
    const shells = [running('b1')]
    expect(endShellsNotInFlight(shells, new Set(['b1']), 4_000)).toBe(shells)
  })
})

describe('recordShellStart', () => {
  test('a shell started again under its id keeps one row', () => {
    const shells = recordShellStart([running('b1')], { ...running('b1'), command: 'second' })
    expect(listed(shells)).toEqual(['second: running 0'])
  })

  test('past 20 shells the oldest ended go first, then the oldest running', () => {
    let shells: readonly BackgroundShell[] = []
    for (const id of ['e1', 'e2', 'e3', 'e4']) shells = recordShellStart(shells, running(id))
    shells = endShellsNotInFlight(shells, new Set(), 0)
    for (let index = 1; index <= 18; index += 1) shells = recordShellStart(shells, running(`r${index}`))

    expect(shells.map(shell => shell.id).slice(0, 2)).toEqual(['e3', 'e4'])
    expect(shells).toHaveLength(20)

    for (let index = 19; index <= 22; index += 1) shells = recordShellStart(shells, running(`r${index}`))
    expect(shells.map(shell => shell.id).slice(0, 2)).toEqual(['r3', 'r4'])
    expect(shells).toHaveLength(20)
  })
})

describe('shellRows', () => {
  test('lists a shell with no command by its tool', () => {
    expect(listed([{ ...running('b1'), command: '' }])).toEqual(['Bash: running 0'])
  })

  test('counts the running shells past five', () => {
    const shells = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'].map(id => running(id))
    expect(shellRows(shells, 0).moreRunningCount).toBe(2)
    expect(shellRows(shells.slice(0, 5), 0).moreRunningCount).toBe(0)
  })
})
