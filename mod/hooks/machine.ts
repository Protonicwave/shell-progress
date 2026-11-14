import type { MachineSample } from '../types'

// The sampler writes a line every five seconds, so a reading older than three
// of its intervals means it has stopped or hung.
const MAX_SAMPLE_AGE_MS = 15_000
// A sampler line is under 200 characters; anything this long without a line
// break is not one, and holding more of it would only grow the buffer.
const MAX_SAMPLE_LINE_CHARS = 4096
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
  }
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

/** Task Manager caps the CPU figure at 100, so the pane does too. */
function shownCpuPercent(sample: MachineSample): number {
  return Math.min(FULL_PERCENT, sample.cpuPercent)
}
