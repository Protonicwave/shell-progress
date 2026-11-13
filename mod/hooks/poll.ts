import type { EngineInterface, FsEntry } from 'claude-code'

import type { Job } from '../types'
import { parseProgressLine } from './progress'

export const POLL_INTERVAL_MS = 500
const MAX_READS_PER_POLL = 20
const MAX_TRACKED_FILES = 200
// A progress line is a few dozen bytes; a larger file is not one, so it is
// marked unreadable without being read.
const MAX_LINE_BYTES = 4096
const PROGRESS_FILE_NAME = /^(.+)-\d+\.txt$/
const READ_FAILED = Symbol('read failed')

type ProgressFile = {
  readonly name: string
  readonly script: string
  readonly mtimeMs: number
  readonly size: number
}

/**
 * Lists `dir` once and returns its jobs, oldest start first, reading only
 * files whose modification time differs from `previous`, at most
 * MAX_READS_PER_POLL. Files never read come first, then those whose last
 * read is oldest, so a file left for a later poll moves up rather than wait
 * behind files that change on every poll. Returns `previous` itself when
 * nothing changed. A missing directory has no jobs.
 */
export async function pollJobs(
  $: EngineInterface,
  dir: string,
  previous: readonly Job[],
): Promise<readonly Job[]> {
  const files = progressFiles(await listOrEmpty($, dir))
  const known = new Map(previous.map(job => [job.file, job]))
  const changed = files
    .filter(file => file.size <= MAX_LINE_BYTES && known.get(file.name)?.mtimeMs !== file.mtimeMs)
    .sort((a, b) => lastReadMtimeMs(known.get(a.name)) - lastReadMtimeMs(known.get(b.name)))
    .slice(0, MAX_READS_PER_POLL)
  const reads = await readFiles($, dir, changed)

  const jobs = files
    .map(file => jobOf(file, known.get(file.name), reads.get(file.name)))
    .filter(job => job !== undefined)
    .sort(byStart)
  const isUnchanged =
    jobs.length === previous.length && jobs.every((job, index) => job === previous[index])
  return isUnchanged ? previous : jobs
}

/** The modification time a job was read at, or 0 for a file never read. */
function lastReadMtimeMs(job: Job | undefined): number {
  return job?.mtimeMs ?? 0
}

async function listOrEmpty($: EngineInterface, dir: string): Promise<readonly FsEntry[]> {
  try {
    return await $.fs.list(dir)
  } catch (error: unknown) {
    // No directory means no script has reported yet; any other failure is real.
    if (await $.fs.exists(dir)) throw error
    return []
  }
}

/** The listing's progress files, newest first, at most MAX_TRACKED_FILES. */
function progressFiles(entries: readonly FsEntry[]): readonly ProgressFile[] {
  const files: ProgressFile[] = []
  for (const entry of entries) {
    const script = PROGRESS_FILE_NAME.exec(entry.name)?.[1]
    if (entry.kind !== 'file' || script === undefined) continue
    files.push({ name: entry.name, script, mtimeMs: entry.mtimeMs, size: entry.size })
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_TRACKED_FILES)
}

async function readFiles(
  $: EngineInterface,
  dir: string,
  files: readonly ProgressFile[],
): Promise<ReadonlyMap<string, string | typeof READ_FAILED>> {
  const reads = await Promise.all(
    files.map(async file => {
      try {
        return [file.name, await $.fs.read(`${dir}/${file.name}`)] as const
      } catch {
        // The engine's errors carry no type to tell causes apart, and `jobOf`
        // treats them all alike: a known job is read again next poll, which
        // covers a helper renaming over the file, and a new file shows as
        // unreadable until it changes, which covers a file never readable.
        return [file.name, READ_FAILED] as const
      }
    }),
  )
  return new Map<string, string | typeof READ_FAILED>(reads)
}

/**
 * The job to show for `file`, given what this poll read from it, if anything.
 * A file left for a later poll keeps its earlier job, or has none yet.
 */
function jobOf(
  file: ProgressFile,
  known: Job | undefined,
  read: string | typeof READ_FAILED | undefined,
): Job | undefined {
  if (typeof read === 'string') return jobFrom(file, parseProgressLine(read))
  if (known?.mtimeMs === file.mtimeMs) return known
  if (file.size > MAX_LINE_BYTES) return jobFrom(file, null)
  // Changed since its last read, and that read failed or waits for a later
  // poll: what was shown stays until a read succeeds.
  if (known !== undefined) return known
  // Recorded at this modification time, so it is read again only once it changes.
  if (read === READ_FAILED) return jobFrom(file, null)
  return undefined
}

function jobFrom(file: ProgressFile, line: Job['line']): Job {
  return { file: file.name, script: file.script, mtimeMs: file.mtimeMs, line }
}

/** Oldest start first, unreadable jobs last, ties by file name, so rows keep their places. */
function byStart(a: Job, b: Job): number {
  const aStart = a.line?.startedSec ?? Number.MAX_SAFE_INTEGER
  const bStart = b.line?.startedSec ?? Number.MAX_SAFE_INTEGER
  if (aStart !== bStart) return aStart - bStart
  if (a.file === b.file) return 0
  return a.file < b.file ? -1 : 1
}
