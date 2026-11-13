import { expect, test } from 'claude-code/testing'

import type { FakeFile } from './fake-world'
import { POLL_MS, START_MS, STARTED_SEC, fakeWorld, runningLine, startSession } from './fake-world'

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

test('the pane opens when the first running job appears, and only then', async ($, on) => {
  const files = new Map<string, FakeFile>()
  const { world, clock } = fakeWorld(on, files)
  await startSession($)

  await clock.advance(POLL_MS)
  expect(world.opens).toEqual([])

  files.set('build.sh-10.txt', { text: runningLine(1, 2), mtimeMs: START_MS })
  await clock.advance(POLL_MS)
  expect(world.opens).toEqual(['shell-progress'])

  files.set('build.sh-10.txt', { text: `${STARTED_SEC} done 0 ${STARTED_SEC + 1}\n`, mtimeMs: START_MS + 1 })
  files.set('test.sh-11.txt', { text: runningLine(1, 2), mtimeMs: START_MS + 1 })
  await clock.advance(POLL_MS * 2)
  expect(world.opens).toEqual(['shell-progress'])
})

test('a stalled job left from earlier does not open the pane', { options: { stallMinutes: 1 } }, async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['old.sh-10.txt', { text: runningLine(1, 2), mtimeMs: START_MS - 120_000 }],
  ])
  const { world, clock } = fakeWorld(on, files)
  await startSession($)

  await clock.advance(POLL_MS)
  expect(world.statuses).toEqual(['old stalled'])
  expect(world.opens).toEqual([])
})

test('a changed file is read on the next poll however many others keep changing', async ($, on) => {
  const files = new Map<string, FakeFile>()
  const touchBusyJobs = (mtimeMs: number) => {
    for (let pid = 1; pid <= 20; pid += 1) {
      files.set(`busy.sh-${pid}.txt`, { text: runningLine(1, 4), mtimeMs })
    }
  }
  files.set('quiet.sh-99.txt', { text: runningLine(1, 2), mtimeMs: START_MS })
  touchBusyJobs(START_MS + 1)
  const { world, clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS * 2)
  expect(world.reads.filter(name => name === 'quiet.sh-99.txt')).toHaveLength(1)

  files.set('quiet.sh-99.txt', { text: `${STARTED_SEC} done 0 ${STARTED_SEC + 1}\n`, mtimeMs: START_MS + 2 })
  touchBusyJobs(START_MS + 10)
  await clock.advance(POLL_MS)
  expect(world.reads.filter(name => name === 'quiet.sh-99.txt')).toHaveLength(2)
})

test('a new file that cannot be read is read again only once it changes', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['secret.sh-1.txt', { text: runningLine(1, 2), mtimeMs: START_MS, isUnreadable: true }],
  ])
  const { world, clock } = fakeWorld(on, files)
  await startSession($)

  await clock.advance(POLL_MS * 3)
  expect(world.reads).toEqual(['secret.sh-1.txt'])

  files.set('secret.sh-1.txt', { text: runningLine(1, 2), mtimeMs: START_MS + 1 })
  await clock.advance(POLL_MS)
  expect(world.reads).toEqual(['secret.sh-1.txt', 'secret.sh-1.txt'])
  expect(world.statuses).toEqual([undefined, 'secret 50%'])
})

test('the pane is redrawn on each poll while a job runs, and not for a stalled one', { options: { stallMinutes: 1 } }, async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['old.sh-10.txt', { text: runningLine(1, 2), mtimeMs: START_MS - 120_000 }],
  ])
  let redraws = 0
  on('ui.invalidate', () => {
    redraws += 1
    return { value: undefined }
  })
  const { clock } = fakeWorld(on, files)
  await startSession($)

  await clock.advance(POLL_MS * 3)
  expect(redraws).toBe(0)

  files.set('build.sh-11.txt', { text: runningLine(1, 2), mtimeMs: START_MS })
  await clock.advance(POLL_MS * 2)
  expect(redraws).toBe(2)
})
