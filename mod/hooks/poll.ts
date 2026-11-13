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

type ProgressFile = {
  readonly name: string
  readonly script: string
  readonly mtimeMs: number
  readonly size: number
}

/**
 * Lists `dir` once and returns its jobs, oldest start first, reading only
 * files whose modification time differs from `previous`, newest first and at
 * most MAX_READS_PER_POLL; the rest wait for a later poll. A file that cannot
 * be read keeps its earlier job. Returns `previous` itself when nothing
 * changed. A missing directory has no jobs.
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
    .slice(0, MAX_READS_PER_POLL)
  const texts = await readTexts($, dir, changed)

  const jobs = files
    .map(file => jobOf(file, known.get(file.name), texts.get(file.name)))
    .filter(job => job !== undefined)
    .sort(byStart)
  const isUnchanged =
    jobs.length === previous.length && jobs.every((job, index) => job === previous[index])
  return isUnchanged ? previous : jobs
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

async function readTexts(
  $: EngineInterface,
  dir: string,
  files: readonly ProgressFile[],
): Promise<ReadonlyMap<string, string>> {
  const reads = await Promise.all(
    files.map(async file => {
      try {
        return [file.name, await $.fs.read(`${dir}/${file.name}`)] as const
      } catch {
        // Every cause is transient or ends with the file gone: a helper
        // renaming over it (which Windows can refuse a reader), or a clean-up
        // deleting it. The caller keeps the earlier job and the next poll
        // reads again, so the cause does not change what happens.
        return undefined
      }
    }),
  )
  return new Map(reads.filter(read => read !== undefined))
}

function jobOf(file: ProgressFile, known: Job | undefined, text: string | undefined): Job | undefined {
  if (text !== undefined) return jobFrom(file, parseProgressLine(text))
  if (known?.mtimeMs === file.mtimeMs) return known
  if (file.size > MAX_LINE_BYTES) return jobFrom(file, null)
  return known
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
