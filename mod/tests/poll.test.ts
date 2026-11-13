import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

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

test('a poll that does not settle is logged once, and no second poll starts beside it', async ($, on) => {
  const files = new Map<string, FakeFile>()
  const { world, clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)
  world.isListingHung = true

  await clock.advance(29_000)
  expect(world.logs).toEqual([])
  await clock.advance(POLL_MS * 4)
  expect(world.logs).toEqual(['shell-progress: a poll of /work/progress has not finished after 30s'])
  await clock.advance(60_000)
  expect(world.logs).toHaveLength(1)
  expect(world.lists).toBe(2)
})

const finishedLine = (exitCode: number, seconds: number) =>
  `${STARTED_SEC} done ${exitCode} ${STARTED_SEC + seconds}\n`

/** Starts a session with each file in `endings` running, then has them all end as given in one poll. */
async function finishTogether(
  $: Engine,
  on: On,
  endings: ReadonlyMap<string, { exitCode: number; seconds: number }>,
) {
  const files = new Map<string, FakeFile>()
  for (const file of endings.keys()) files.set(file, { text: runningLine(1, 2), mtimeMs: START_MS })
  const fake = fakeWorld(on, files)
  await startSession($)
  await fake.clock.advance(POLL_MS)
  for (const [file, { exitCode, seconds }] of endings) {
    files.set(file, { text: finishedLine(exitCode, seconds), mtimeMs: START_MS + 1 })
  }
  await fake.clock.advance(POLL_MS)
  return fake
}

test('jobs that finish in one poll raise one toast, and a notification for the failed and the long', async ($, on) => {
  const { world } = await finishTogether($, on, new Map([
    ['lint.sh-1.txt', { exitCode: 0, seconds: 30 }],
    ['migrate.sh-2.txt', { exitCode: 1, seconds: 10 }],
    ['build.sh-3.txt', { exitCode: 0, seconds: 150 }],
  ]))
  expect(world.toasts).toEqual(['3 jobs finished, 1 failed'])
  expect(world.notifications).toEqual(['2 jobs finished, 1 failed'])
})

test('a short successful job raises a toast and no notification', async ($, on) => {
  const { world, clock } = await finishTogether($, on, new Map([
    ['lint.sh-1.txt', { exitCode: 0, seconds: 30 }],
  ]))
  await clock.advance(POLL_MS * 2)
  expect(world.toasts).toEqual(['lint.sh done in 0m 30s'])
  expect(world.notifications).toEqual([])
})

test('notifyMinutes sets how long a successful job runs before it notifies', { options: { notifyMinutes: 1 } }, async ($, on) => {
  const { world } = await finishTogether($, on, new Map([
    ['build.sh-3.txt', { exitCode: 0, seconds: 90 }],
  ]))
  expect(world.notifications).toEqual(['build.sh done in 1m 30s'])
})

test('a job already finished when first seen is not announced', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['lint.sh-1.txt', { text: finishedLine(1, 30), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS * 2)
  expect(world.toasts).toEqual([])
  expect(world.notifications).toEqual([])
})

test('a dismissed job that finishes is not announced', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-1.txt', { text: runningLine(1, 2), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  world.store.set('dismissedJobs', [`build.sh-1.txt:${STARTED_SEC}`])
  await startSession($)
  await clock.advance(POLL_MS)
  files.set('build.sh-1.txt', { text: finishedLine(1, 30), mtimeMs: START_MS + 1 })
  await clock.advance(POLL_MS)
  expect(world.toasts).toEqual([])
  expect(world.notifications).toEqual([])
})

test('a notification that is not sent is logged once and not retried', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['migrate.sh-2.txt', { text: runningLine(1, 2), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  world.notifyResult = { isSent: false, reason: 'no-channel' }
  await startSession($)
  await clock.advance(POLL_MS)
  files.set('migrate.sh-2.txt', { text: finishedLine(1, 10), mtimeMs: START_MS + 1 })
  await clock.advance(POLL_MS * 3)
  expect(world.notifications).toHaveLength(1)
  expect(world.logs).toEqual(['shell-progress: notification not sent: no-channel'])
})

test('a notification that fails is logged once and not retried', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['migrate.sh-2.txt', { text: runningLine(1, 2), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  world.notifyResult = { deny: 'denied by a hook' }
  await startSession($)
  await clock.advance(POLL_MS)
  files.set('migrate.sh-2.txt', { text: finishedLine(1, 10), mtimeMs: START_MS + 1 })
  await clock.advance(POLL_MS * 3)
  expect(world.notifications).toHaveLength(1)
  expect(world.logs).toHaveLength(1)
  expect(world.logs[0]).toMatch(/^shell-progress: notification failed: .*denied by a hook/)
})
