import { describe, expect, test } from 'claude-code/testing'

import type { MachineSample } from '../types'
import { isCurrentSample, machineText, machineWarnings, parseSample, takeLines } from '../hooks/machine'

const AT_MS = 1_700_000_000_000
const GB = 1024 ** 3

const fields = {
  cpuPercent: 34.2,
  cpuSpeedPercent: 160.4,
  gpuPercent: 5.3,
  freeMemoryBytes: 11.2 * GB,
  power: 'mains',
  batteryPercent: null,
}
const lineWith = (changes: Record<string, unknown>) => JSON.stringify({ ...fields, ...changes })

const sample = (changes: Partial<MachineSample> = {}): MachineSample => ({
  atMs: AT_MS,
  cpuPercent: 34.2,
  cpuSpeedPercent: 160.4,
  gpuPercent: 5.3,
  freeMemoryBytes: 11.2 * GB,
  power: { kind: 'mains' },
  ...changes,
})

describe('parseSample', () => {
  test('reads a line on mains', () => {
    expect(parseSample(lineWith({}), AT_MS)).toEqual(sample())
  })

  test('reads a line on battery, with and without a known charge', () => {
    expect(parseSample(lineWith({ power: 'battery', batteryPercent: 41 }), AT_MS).power).toEqual({
      kind: 'battery',
      percentLeft: 41,
    })
    expect(parseSample(lineWith({ power: 'battery', batteryPercent: null }), AT_MS).power).toEqual({
      kind: 'battery',
      percentLeft: null,
    })
  })

  test('reads a GPU figure of null as no GPU counters', () => {
    expect(parseSample(lineWith({ gpuPercent: null }), AT_MS).gpuPercent).toBeNull()
  })

  const notObjects: readonly [string, RegExp][] = [
    ['', /expected a JSON sampler line/],
    ['{"cpuPercent":', /expected a JSON sampler line/],
    ['[1, 2]', /expected a JSON object/],
    ['null', /expected a JSON object/],
    ['41', /expected a JSON object/],
  ]
  for (const [line, message] of notObjects) {
    test(`rejects ${JSON.stringify(line)}, which is not a JSON object`, () => {
      expect(() => parseSample(line, AT_MS)).toThrow(message)
    })
  }

  const badFields: readonly [string, Record<string, unknown>, RegExp][] = [
    ['a missing field', { cpuPercent: undefined }, /cpuPercent/],
    ['a string for a number', { freeMemoryBytes: '12' }, /freeMemoryBytes/],
    ['a negative number', { cpuSpeedPercent: -1 }, /cpuSpeedPercent/],
    ['a GPU figure that is not a number', { gpuPercent: 'none' }, /gpuPercent/],
    ['an unknown power source', { power: 'solar' }, /power to be mains or battery, got "solar"/],
    ['a missing power source', { power: undefined }, /power to be mains or battery, got nothing/],
    ['a battery charge over 100', { power: 'battery', batteryPercent: 255 }, /batteryPercent to be at most 100/],
    ['a battery charge that is not a number', { power: 'battery', batteryPercent: '41' }, /batteryPercent/],
  ]
  for (const [name, changes, message] of badFields) {
    test(`rejects ${name}`, () => {
      expect(() => parseSample(lineWith(changes), AT_MS)).toThrow(message)
    })
  }

  test('rejects a number too large to be finite', () => {
    const line = lineWith({}).replace('"cpuPercent":34.2', '"cpuPercent":1e999')
    expect(() => parseSample(line, AT_MS)).toThrow(/cpuPercent to be a finite number/)
  })

  test('cuts a long bad line in its message', () => {
    expect(() => parseSample('x'.repeat(500), AT_MS)).toThrow(/x{80}\.\.\.$/)
  })
})

describe('takeLines', () => {
  test('carries a part line over to the next piece', () => {
    const first = takeLines('', '{"a":1}\r\n{"b"')
    expect(first).toEqual({ lines: ['{"a":1}'], rest: '{"b"' })
    expect(takeLines(first.rest, ':2}\n')).toEqual({ lines: ['{"b":2}'], rest: '' })
  })

  test('gives no lines for a piece without a break', () => {
    expect(takeLines('', '{"a"')).toEqual({ lines: [], rest: '{"a"' })
  })

  test('rejects a part line past 4096 characters', () => {
    expect(() => takeLines('x'.repeat(4000), 'x'.repeat(100))).toThrow(/under 4096 characters, got 4100/)
  })
})

describe('isCurrentSample', () => {
  test('holds for 15 s after the reading and not after', () => {
    expect(isCurrentSample(sample(), AT_MS + 15_000)).toBe(true)
    expect(isCurrentSample(sample(), AT_MS + 15_001)).toBe(false)
  })
})

describe('machineText', () => {
  test('gives CPU, GPU and free memory', () => {
    expect(machineText(sample())).toBe('cpu 34% · gpu 5% · 11.2 GB free')
  })

  test('caps the CPU at 100% and leaves out a GPU with no counters', () => {
    expect(machineText(sample({ cpuPercent: 131, gpuPercent: null }))).toBe('cpu 100% · 11.2 GB free')
  })
})

describe('machineWarnings', () => {
  test('says nothing on mains at full speed', () => {
    expect(machineWarnings(sample({ cpuPercent: 90 }))).toEqual([])
  })

  test('says a busy CPU is held back', () => {
    expect(machineWarnings(sample({ cpuPercent: 50, cpuSpeedPercent: 78.4 }))).toEqual(['held at 78% speed'])
  })

  test('says nothing of a slow clock while the CPU is idle', () => {
    expect(machineWarnings(sample({ cpuPercent: 49, cpuSpeedPercent: 40 }))).toEqual([])
  })

  test('says nothing of a speed that rounds to 100%', () => {
    expect(machineWarnings(sample({ cpuPercent: 90, cpuSpeedPercent: 99.6 }))).toEqual([])
  })

  test('says the machine is on battery, with the charge when known', () => {
    expect(machineWarnings(sample({ power: { kind: 'battery', percentLeft: 41 } }))).toEqual(['on battery, 41%'])
    expect(machineWarnings(sample({ power: { kind: 'battery', percentLeft: null } }))).toEqual(['on battery'])
  })

  test('gives both warnings, the CPU first', () => {
    const warnings = machineWarnings(
      sample({ cpuPercent: 80, cpuSpeedPercent: 70, power: { kind: 'battery', percentLeft: 41 } }),
    )
    expect(warnings).toEqual(['held at 70% speed', 'on battery, 41%'])
  })
})
