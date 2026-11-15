import { describe, expect, test } from 'claude-code/testing'

import type { Job, MachineSample, ProcessReading } from '../types'
import {
  isCurrentSample,
  machineText,
  machineWarnings,
  parseSample,
  processStates,
  takeLines,
} from '../hooks/machine'

const AT_MS = 1_700_000_000_000
const GB = 1024 ** 3

const fields = {
  cpuPercent: 34.2,
  cpuSpeedPercent: 160.4,
  gpuPercent: 5.3,
  freeMemoryBytes: 11.2 * GB,
  power: 'mains',
  batteryPercent: null,
  sampledMs: AT_MS - 3,
  cpuCount: 8,
  processes: [[4120, 812, 1500, AT_MS - 60_000]],
}
const lineWith = (changes: Record<string, unknown>) => JSON.stringify({ ...fields, ...changes })

const sample = (changes: Partial<MachineSample> = {}): MachineSample => ({
  atMs: AT_MS,
  cpuPercent: 34.2,
  cpuSpeedPercent: 160.4,
  gpuPercent: 5.3,
  freeMemoryBytes: 11.2 * GB,
  power: { kind: 'mains' },
  sampledMs: AT_MS - 3,
  cpuCount: 8,
  processes: [{ pid: 4120, parentPid: 812, cpuMs: 1500, startedMs: AT_MS - 60_000 }],
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

  test('reads an empty process list', () => {
    expect(parseSample(lineWith({ processes: [] }), AT_MS).processes).toEqual([])
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
    ['a missing sampling time', { sampledMs: undefined }, /sampledMs/],
    ['no processors', { cpuCount: 0 }, /cpuCount to be a whole number of 1 or more, got 0/],
    ['part of a processor', { cpuCount: 7.5 }, /cpuCount to be a whole number of 1 or more, got 7.5/],
    ['processes that are not a list', { processes: {} }, /processes to be a list, got \{\}/],
    ['a process of three numbers', { processes: [[1, 2, 3]] }, /process 0 to be four whole numbers of 0 or more, got \[1,2,3\]/],
    ['a process with a fraction', { processes: [[1, 2, 3, 4], [5, 6, 7.5, 8]] }, /process 1 to be four/],
    ['a process with a negative number', { processes: [[1, -2, 3, 4]] }, /process 0 to be four/],
    ['a process that is not a list', { processes: [7] }, /process 0 to be four.*, got 7$/],
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

  test('takes a line that lists thousands of processes', () => {
    const line = 'x'.repeat(200_000)
    expect(takeLines('', `${line}\n`)).toEqual({ lines: [line], rest: '' })
  })

  test('rejects a part line past 1000000 characters', () => {
    expect(() => takeLines('x'.repeat(999_990), 'x'.repeat(20))).toThrow(/under 1000000 characters, got 1000010/)
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

// The sampler reads every five seconds; the job's process started a minute
// before its helper loaded at STARTED_SEC.
const INTERVAL_MS = 5_000
const STARTED_SEC = 1_699_999_000
const ROOT_STARTED_MS = (STARTED_SEC - 60) * 1000
const BEFORE_MS = STARTED_SEC * 1000 + 600_000
const AFTER_MS = BEFORE_MS + INTERVAL_MS

const process = (pid: number, parentPid: number, cpuMs: number, startedMs = ROOT_STARTED_MS): ProcessReading => ({
  pid,
  parentPid,
  cpuMs,
  startedMs,
})
const reading = (sampledMs: number, processes: readonly ProcessReading[]) =>
  sample({ atMs: sampledMs, sampledMs, cpuCount: 8, processes })
const job = (file: string, kind: 'running' | 'finished'): Job => ({
  file,
  script: 'build.sh',
  pid: file.replace(/\D/g, ''),
  mtimeMs: BEFORE_MS,
  line:
    kind === 'running'
      ? { kind: 'running', startedSec: STARTED_SEC, step: 1, total: 4, label: '' }
      : { kind: 'finished', startedSec: STARTED_SEC, exitCode: 0, endedSec: STARTED_SEC + 9 },
  lastLabel: '',
})
const ROOT_JOB = job('build.sh-10.txt', 'running')
/** The state of the job whose process is pid 10, between two readings. */
const stateBetween = (before: MachineSample, after: MachineSample) =>
  processStates([ROOT_JOB], { previous: before, current: after }, after.atMs).get(ROOT_JOB.file)
/** The CPU of that job's process tree, or `undefined` once its process has ended. */
const cpuBetween = (before: MachineSample, after: MachineSample) => {
  const state = stateBetween(before, after)
  return state?.kind === 'ended' ? undefined : state?.cpuPercent
}

describe("the CPU of a job's process tree", () => {
  test('sums the root and its descendants as a share of all cores', () => {
    const before = reading(BEFORE_MS, [process(10, 1, 1000), process(11, 10, 0), process(12, 11, 500)])
    const after = reading(AFTER_MS, [process(10, 1, 2000), process(11, 10, 2000), process(12, 11, 1500)])
    // 4000 ms of CPU over 5000 ms on 8 cores.
    expect(cpuBetween(before, after)).toBe(10)
  })

  test("leaves out other trees, including the root's parent", () => {
    const before = reading(BEFORE_MS, [process(1, 0, 0), process(10, 1, 0), process(20, 1, 0)])
    const after = reading(AFTER_MS, [process(1, 0, 9000), process(10, 1, 2000), process(20, 1, 9000)])
    expect(cpuBetween(before, after)).toBe(5)
  })

  test('counts all the CPU of a process started since the previous reading', () => {
    const before = reading(BEFORE_MS, [process(10, 1, 0)])
    const after = reading(AFTER_MS, [process(10, 1, 0), process(11, 10, 4000, BEFORE_MS + 1)])
    expect(cpuBetween(before, after)).toBe(10)
  })

  test('survives a process that ended between the readings', () => {
    const before = reading(BEFORE_MS, [process(10, 1, 0), process(11, 10, 3000)])
    const after = reading(AFTER_MS, [process(10, 1, 2000)])
    expect(cpuBetween(before, after)).toBe(5)
  })

  test('takes a reused pid as a new process', () => {
    const before = reading(BEFORE_MS, [process(10, 1, 0), process(11, 10, 9000)])
    const after = reading(AFTER_MS, [process(10, 1, 0), process(11, 10, 2000, BEFORE_MS + 1)])
    expect(cpuBetween(before, after)).toBe(5)
  })

  test('leaves out a process missing from the previous reading that started before it', () => {
    const before = reading(BEFORE_MS, [process(10, 1, 0)])
    const after = reading(AFTER_MS, [process(10, 1, 0), process(11, 10, 9000, BEFORE_MS - 1)])
    expect(cpuBetween(before, after)).toBe(0)
  })

  test('leaves out a process older than the parent it names, whose pid was reused', () => {
    const before = reading(BEFORE_MS, [process(10, 1, 0), process(11, 10, 0, ROOT_STARTED_MS - 1)])
    const after = reading(AFTER_MS, [process(10, 1, 0), process(11, 10, 9000, ROOT_STARTED_MS - 1)])
    expect(cpuBetween(before, after)).toBe(0)
  })

  test('visits each process once whatever the parent links say', () => {
    const before = reading(BEFORE_MS, [process(10, 11, 0), process(11, 10, 0)])
    const after = reading(AFTER_MS, [process(10, 11, 2000), process(11, 10, 2000)])
    expect(cpuBetween(before, after)).toBe(10)
  })

  test('caps the share at 100%', () => {
    const before = reading(BEFORE_MS, [process(10, 1, 0)])
    const after = reading(AFTER_MS, [process(10, 1, 41_000)])
    expect(cpuBetween(before, after)).toBe(100)
  })
})

describe("the state of a job's process", () => {
  const before = reading(BEFORE_MS, [process(10, 1, 0)])

  test('is busy from 5% of all cores', () => {
    expect(stateBetween(before, reading(AFTER_MS, [process(10, 1, 2000)]))).toEqual({
      kind: 'busy',
      cpuPercent: 5,
    })
  })

  test('is idle below 5%', () => {
    expect(stateBetween(before, reading(AFTER_MS, [process(10, 1, 1999)]))).toEqual({
      kind: 'idle',
      cpuPercent: 4.9975,
    })
  })

  test('has ended when its pid is gone', () => {
    expect(stateBetween(before, reading(AFTER_MS, [process(11, 1, 9000)]))).toEqual({ kind: 'ended' })
  })

  test('has ended when its pid names a process started after the job', () => {
    const reused = reading(AFTER_MS, [process(10, 1, 9000, (STARTED_SEC + 1) * 1000)])
    expect(stateBetween(before, reused)).toEqual({ kind: 'ended' })
  })

  test("is running when its process started within the job's first second", () => {
    // The helper writes its start time cut to the whole second.
    const same = reading(AFTER_MS, [process(10, 1, 0, (STARTED_SEC + 1) * 1000 - 1)])
    expect(stateBetween(before, same)?.kind).toBe('idle')
  })
})

describe('processStates', () => {
  const jobs = [job('build.sh-10.txt', 'running'), job('sync.sh-11.txt', 'finished')]
  const before = reading(BEFORE_MS, [process(10, 1, 0), process(11, 1, 0)])
  const after = reading(AFTER_MS, [process(10, 1, 2000), process(11, 1, 0)])

  test('gives the state of each running job', () => {
    const states = processStates(jobs, { previous: before, current: after }, AFTER_MS)
    expect([...states]).toEqual([['build.sh-10.txt', { kind: 'busy', cpuPercent: 5 }]])
  })

  test('gives none before the second reading', () => {
    expect(processStates(jobs, { previous: null, current: after }, AFTER_MS).size).toBe(0)
    expect(processStates(jobs, null, AFTER_MS).size).toBe(0)
  })

  test('gives none once the last reading is 15 s old', () => {
    expect(processStates(jobs, { previous: before, current: after }, AFTER_MS + 15_001).size).toBe(0)
  })

  test('gives none across a gap of over 15 s between readings, or a clock that went back', () => {
    const late = reading(BEFORE_MS + 15_001, after.processes)
    expect(processStates(jobs, { previous: before, current: late }, late.atMs).size).toBe(0)
    expect(processStates(jobs, { previous: after, current: before }, BEFORE_MS).size).toBe(0)
  })
})
