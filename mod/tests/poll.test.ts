import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const DIR = '/work/progress'
// The engine hands paths on in the platform's form, a drive letter and
// backslashes on Windows, so the fake compares them without the root.
const segments = (path: string) =>
  path.split(/[\\/]/).filter(part => part !== '' && !/^[A-Za-z]:$/.test(part))
const fileNameOf = (path: string) => segments(path).at(-1) ?? ''
const POLL_MS = 500
const START_MS = 1_700_000_000_000
const STARTED_SEC = START_MS / 1000

type FakeFile = { text: string; mtimeMs: number; isUnreadable?: boolean }

/**
 * A progress directory beneath the mod, counting what the mod asks of it,
 * and a record of the status line.
 */
function fakeWorld(on: On, files: Map<string, FakeFile> | undefined) {
  const world = { lists: 0, reads: [] as string[], statuses: [] as (string | undefined)[], logs: [] as string[] }
  const clock = mock.clock(on, { now: START_MS })
  mock.env(on, { CLAUDE_PROGRESS_DIR: DIR })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', (_, e) => {
    expect(segments(e.path)).toEqual(segments(DIR))
    world.lists += 1
    if (files === undefined) throw new Error(`ENOENT: ${e.path}`)
    const entries = [...files].map(([name, file]) => ({
      name,
      kind: 'file' as const,
      size: file.text.length,
      mtimeMs: file.mtimeMs,
      isLink: false,
    }))
    return { value: entries }
  })
  on('fs.exists', () => ({ value: files !== undefined }))
  on('fs.read', (_, e) => {
    expect(segments(e.path).slice(0, -1)).toEqual(segments(DIR))
    const name = fileNameOf(e.path)
    world.reads.push(name)
    const file = files?.get(name)
    if (file === undefined || file.isUnreadable === true) throw new Error(`EBUSY: ${e.path}`)
    return { value: file.text }
  })
  on('ui.status', (_, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
  return { world, clock }
}

async function startSession($: Engine): Promise<void> {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

const runningLine = (step: number, total: number, label = '') =>
  `${STARTED_SEC} ${step} ${total}${label === '' ? '' : ` ${label}`}\n`

test('each poll lists once and reads only changed files, at most 20', async ($, on) => {
  const files = new Map<string, FakeFile>()
  for (let pid = 1; pid <= 25; pid += 1) {
    files.set(`job.sh-${pid}.txt`, { text: runningLine(1, 4), mtimeMs: START_MS + pid })
  }
  const { world, clock } = fakeWorld(on, files)
  await startSession($)

  await clock.advance(POLL_MS)
  expect(world.lists).toBe(1)
  expect(world.reads.length).toBe(20)
  expect(world.reads).not.toContain('job.sh-1.txt')

  await clock.advance(POLL_MS)
  expect(world.lists).toBe(2)
  expect(world.reads.slice(20).sort()).toEqual(
    [1, 2, 3, 4, 5].map(pid => `job.sh-${pid}.txt`).sort(),
  )

  for (const pid of [3, 11, 19]) {
    files.set(`job.sh-${pid}.txt`, { text: runningLine(2, 4), mtimeMs: START_MS + 1000 })
  }
  await clock.advance(POLL_MS)
  expect(world.lists).toBe(3)
  expect(world.reads.slice(25).sort()).toEqual(
    [3, 11, 19].map(pid => `job.sh-${pid}.txt`).sort(),
  )

  await clock.advance(POLL_MS)
  expect(world.lists).toBe(4)
  expect(world.reads.length).toBe(28)
})

test('the status line shows a running job and clears when it finishes', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-10.txt', { text: runningLine(1, 2, 'compiling'), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  await startSession($)

  await clock.advance(POLL_MS)
  expect(world.statuses).toEqual(['build 50%'])

  files.set('build.sh-10.txt', { text: `${STARTED_SEC} done 0 ${STARTED_SEC + 1}\n`, mtimeMs: START_MS + 1 })
  await clock.advance(POLL_MS)
  expect(world.statuses).toEqual(['build 50%', undefined])
})

test('the status line is set only when its text changes', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-10.txt', { text: runningLine(1, 2), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  await startSession($)

  await clock.advance(POLL_MS * 4)
  expect(world.statuses).toEqual(['build 50%'])
})

test('a missing directory shows no jobs and logs nothing', async ($, on) => {
  const { world, clock } = fakeWorld(on, undefined)
  await startSession($)

  await clock.advance(POLL_MS * 2)
  expect(world.lists).toBe(2)
  expect(world.statuses).toEqual([undefined])
  expect(world.logs).toEqual([])
})

test('a failed read keeps the last state and is retried on the next poll', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-10.txt', { text: runningLine(1, 4), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  files.set('build.sh-10.txt', { text: runningLine(2, 4), mtimeMs: START_MS + 1, isUnreadable: true })
  await clock.advance(POLL_MS)
  expect(world.statuses).toEqual(['build 25%'])

  files.set('build.sh-10.txt', { text: runningLine(2, 4), mtimeMs: START_MS + 1 })
  await clock.advance(POLL_MS)
  expect(world.reads.length).toBe(3)
  expect(world.statuses).toEqual(['build 25%', 'build 50%'])
})

test('a file too large for a progress line is not read', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['huge.sh-10.txt', { text: 'x'.repeat(5000), mtimeMs: START_MS }],
    ['notes.md', { text: runningLine(1, 2), mtimeMs: START_MS }],
    ['build.sh-11.txt.tmp', { text: runningLine(1, 2), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  await startSession($)

  await clock.advance(POLL_MS)
  expect(world.reads).toEqual([])
  expect(world.statuses).toEqual([undefined])
})

test('jobs show in the order they started', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['late.sh-1.txt', { text: `${STARTED_SEC + 5} 1 2\n`, mtimeMs: START_MS }],
    ['early.sh-2.txt', { text: `${STARTED_SEC} 1 4\n`, mtimeMs: START_MS + 1 }],
  ])
  const { world, clock } = fakeWorld(on, files)
  await startSession($)

  await clock.advance(POLL_MS)
  expect(world.statuses).toEqual(['early 25% · late 50%'])
})

test('a job stalls once its file is unchanged for stallMinutes', { options: { stallMinutes: 1 } }, async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-10.txt', { text: runningLine(1, 2), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  await startSession($)

  await clock.advance(60_000 - POLL_MS)
  expect(world.statuses).toEqual(['build 50%'])

  await clock.advance(POLL_MS)
  expect(world.statuses).toEqual(['build 50%', 'build stalled'])
})
