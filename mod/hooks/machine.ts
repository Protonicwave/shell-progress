import type { Job, MachineReadings, MachineSample, ProcessReading, ProcessState } from '../types'
import { MS_PER_SECOND } from './progress'

// The sampler writes a line every five seconds, so a reading older than three
// of its intervals means it has stopped or hung.
const MAX_SAMPLE_AGE_MS = 15_000
// A sampler line takes about 30 characters a process, so this holds over
// 30,000 processes; anything longer without a line break is not a sampler
// line, and holding more of it would only grow the buffer.
const MAX_SAMPLE_LINE_CHARS = 1_000_000
// From this share of all cores a job's processes are working, whatever its
// file says; a shell waiting on input stays far below it.
const BUSY_JOB_CPU_PERCENT = 5
const PROCESS_FIELD_COUNT = 4
// From this CPU figure a speed under 100% means the CPU is held back; below
// it, a slow clock only means there is little to do.
const BUSY_CPU_PERCENT = 50
const FULL_PERCENT = 100
const BYTES_PER_GB = 1024 ** 3
const EXCERPT_CHARS = 80

/**
 * Splits what the sampler wrote into whole lines, carrying a part line over
 * in `rest` to be joined with the next piece. Throws when the part line passes
 * MAX_SAMPLE_LINE_CHARS.
 */
export function takeLines(rest: string, text: string): { lines: readonly string[]; rest: string } {
  const parts = `${rest}${text}`.split('\n')
  // `split` always gives at least one part: the text after the last break.
  const last = parts.pop() as string
  if (last.length > MAX_SAMPLE_LINE_CHARS) {
    throw new Error(`expected a sampler line under ${MAX_SAMPLE_LINE_CHARS} characters, got ${last.length} without a break`)
  }
  return { lines: parts.map(line => line.replace(/\r$/, '')), rest: last }
}

/**
 * The sampler's JSON line as a sample read at `atMs`. Throws, naming the
 * field, on a line that is not JSON, not an object, or holds a value of the
 * wrong type, a negative or non-finite number, or a battery charge over 100.
 */
export function parseSample(line: string, atMs: number): MachineSample {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error: unknown) {
    throw new Error(`expected a JSON sampler line, got ${excerpt(line)}`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object from the sampler, got ${excerpt(line)}`)
  }
  const fields = parsed as Readonly<Record<string, unknown>>
  return {
    atMs,
    cpuPercent: amountOf(fields, 'cpuPercent'),
    cpuSpeedPercent: amountOf(fields, 'cpuSpeedPercent'),
    gpuPercent: fields['gpuPercent'] === null ? null : amountOf(fields, 'gpuPercent'),
    freeMemoryBytes: amountOf(fields, 'freeMemoryBytes'),
    power: powerOf(fields),
    sampledMs: amountOf(fields, 'sampledMs'),
    cpuCount: cpuCountOf(fields),
    processes: processesOf(fields),
  }
}

function cpuCountOf(fields: Readonly<Record<string, unknown>>): number {
  const count = fields['cpuCount']
  if (!Number.isSafeInteger(count) || (count as number) < 1) {
    throw new Error(`expected the sampler's cpuCount to be a whole number of 1 or more, got ${excerpt(JSON.stringify(count) ?? 'nothing')}`)
  }
  return count as number
}

/** Each process as `[pid, parentPid, cpuMs, startedMs]`, all whole numbers of zero or more; `null` stays. */
function processesOf(fields: Readonly<Record<string, unknown>>): readonly ProcessReading[] | null {
  const listed: unknown = fields['processes']
  if (listed === null) return null
  if (!Array.isArray(listed)) {
    throw new Error(`expected the sampler's processes to be a list, got ${excerpt(JSON.stringify(listed) ?? 'nothing')}`)
  }
  return listed.map((entry: unknown, index) => {
    if (!isProcessEntry(entry)) {
      throw new Error(`expected the sampler's process ${index} to be four whole numbers of 0 or more, got ${excerpt(JSON.stringify(entry) ?? 'nothing')}`)
    }
    const [pid, parentPid, cpuMs, startedMs] = entry
    return { pid, parentPid, cpuMs, startedMs }
  })
}

function isProcessEntry(entry: unknown): entry is readonly [number, number, number, number] {
  return (
    Array.isArray(entry) &&
    entry.length === PROCESS_FIELD_COUNT &&
    entry.every((value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0)
  )
}

function powerOf(fields: Readonly<Record<string, unknown>>): MachineSample['power'] {
  const power = fields['power']
  if (power === 'mains') return { kind: 'mains' }
  if (power !== 'battery') {
    throw new Error(`expected the sampler's power to be mains or battery, got ${excerpt(JSON.stringify(power) ?? 'nothing')}`)
  }
  if (fields['batteryPercent'] === null) return { kind: 'battery', percentLeft: null }
  const percentLeft = amountOf(fields, 'batteryPercent')
  if (percentLeft > FULL_PERCENT) {
    throw new Error(`expected the sampler's batteryPercent to be at most ${FULL_PERCENT}, got ${percentLeft}`)
  }
  return { kind: 'battery', percentLeft }
}

/** The field as a finite number of zero or more. */
function amountOf(fields: Readonly<Record<string, unknown>>, name: string): number {
  const value = fields[name]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`expected the sampler's ${name} to be a finite number of 0 or more, got ${excerpt(JSON.stringify(value) ?? 'nothing')}`)
  }
  return value
}

function excerpt(text: string): string {
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}...` : text
}

/** Whether `sample` is recent enough at `nowMs` to show as the machine now. */
export function isCurrentSample(sample: MachineSample, nowMs: number): boolean {
  return nowMs - sample.atMs <= MAX_SAMPLE_AGE_MS
}

/** `cpu 34% · gpu 5% · 11.2 GB free`, leaving out the GPU where there are no GPU counters. */
export function machineText(sample: MachineSample): string {
  const readings = [`cpu ${Math.round(shownCpuPercent(sample))}%`]
  if (sample.gpuPercent !== null) readings.push(`gpu ${Math.round(sample.gpuPercent)}%`)
  // Gibibytes, called GB as Task Manager calls them, so the two figures agree.
  readings.push(`${(sample.freeMemoryBytes / BYTES_PER_GB).toFixed(1)} GB free`)
  return readings.join(' · ')
}

/**
 * `held at 78% speed` when a busy CPU runs under its base speed, which is
 * what heat or a power plan does to it, and `on battery, 41%` off mains.
 */
export function machineWarnings(sample: MachineSample): readonly string[] {
  const warnings: string[] = []
  const speedPercent = Math.round(sample.cpuSpeedPercent)
  if (shownCpuPercent(sample) >= BUSY_CPU_PERCENT && speedPercent < FULL_PERCENT) {
    warnings.push(`held at ${speedPercent}% speed`)
  }
  if (sample.power.kind === 'battery') {
    const left = sample.power.percentLeft
    warnings.push(left === null ? 'on battery' : `on battery, ${Math.round(left)}%`)
  }
  return warnings
}

/** A reading that lists the machine's processes. */
type ListedSample = MachineSample & { readonly processes: readonly ProcessReading[] }

function hasProcessList(sample: MachineSample): sample is ListedSample {
  return sample.processes !== null
}

/**
 * The state of each running job's process tree between the last two
 * readings, by job file. Empty before a sampler's second reading, once the
 * last is no longer current, when either lists no processes, and when the
 * readings are not in order or are further apart than a current reading may
 * be old.
 */
export function processStates(
  jobs: readonly Job[],
  readings: MachineReadings | null,
  nowMs: number,
): ReadonlyMap<string, ProcessState> {
  const states = new Map<string, ProcessState>()
  if (readings === null || readings.previous === null || !isCurrentSample(readings.current, nowMs)) {
    return states
  }
  const { previous, current } = readings
  if (!hasProcessList(previous) || !hasProcessList(current)) return states
  const intervalMs = current.sampledMs - previous.sampledMs
  if (intervalMs <= 0 || intervalMs > MAX_SAMPLE_AGE_MS) return states
  for (const job of jobs) {
    if (job.line?.kind !== 'running') continue
    states.set(job.file, stateOfProcess(job.pid, job.line.startedSec, previous, current))
  }
  return states
}

/**
 * What the process `pid` of a job that started at `startedSec` is doing:
 * ended when the pid is gone or names a process started after the job, else
 * busy or idle by its tree's CPU. `current` must be read after `previous`.
 */
function stateOfProcess(
  pid: string,
  startedSec: number,
  previous: ListedSample,
  current: ListedSample,
): ProcessState {
  const rootPid = Number(pid)
  const root = current.processes.find(process => process.pid === rootPid)
  // The job's process starts before its helper loads, and the helper cuts the
  // start time to the whole second, so the process starts before the next.
  if (root === undefined || root.startedMs >= (startedSec + 1) * MS_PER_SECOND) return { kind: 'ended' }
  const cpuPercent = treeCpu(previous, current, rootPid)
  return { kind: cpuPercent >= BUSY_JOB_CPU_PERCENT ? 'busy' : 'idle', cpuPercent }
}

/**
 * The CPU of `rootPid` and its descendants between two readings, as a share
 * of all cores, which is Task Manager's convention, capped at 100. A process
 * that ended between the readings is left out. `current` must be read after
 * `previous`.
 */
function treeCpu(previous: ListedSample, current: ListedSample, rootPid: number): number {
  const before = new Map(previous.processes.map(process => [process.pid, process]))
  let cpuMs = 0
  for (const process of processTree(current.processes, rootPid)) {
    const earlier = before.get(process.pid)
    if (earlier?.startedMs === process.startedMs) cpuMs += process.cpuMs - earlier.cpuMs
    // Started since the previous reading, so all its CPU falls between the two.
    else if (process.startedMs >= previous.sampledMs) cpuMs += process.cpuMs
  }
  const percent = (FULL_PERCENT * cpuMs) / ((current.sampledMs - previous.sampledMs) * current.cpuCount)
  return Math.min(FULL_PERCENT, percent)
}

/** `rootPid` and its descendants, or none when it is not among `processes`. */
function processTree(processes: readonly ProcessReading[], rootPid: number): readonly ProcessReading[] {
  const root = processes.find(process => process.pid === rootPid)
  if (root === undefined) return []
  const children = new Map<number, ProcessReading[]>()
  for (const process of processes) {
    const siblings = children.get(process.parentPid)
    if (siblings === undefined) children.set(process.parentPid, [process])
    else siblings.push(process)
  }
  // Breadth first; `seen` keeps it to one visit a process whatever the parent links say.
  const tree = [root]
  const seen = new Set([root.pid])
  for (let next = 0; next < tree.length; next += 1) {
    const parent = tree[next] as ProcessReading
    for (const child of children.get(parent.pid) ?? []) {
      // Older than the parent it names: that parent ended and its pid was reused.
      if (child.startedMs < parent.startedMs || seen.has(child.pid)) continue
      seen.add(child.pid)
      tree.push(child)
    }
  }
  return tree
}

/** Task Manager caps the CPU figure at 100, so the pane does too. */
function shownCpuPercent(sample: MachineSample): number {
  return Math.min(FULL_PERCENT, sample.cpuPercent)
}
