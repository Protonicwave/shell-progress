import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { FakeFile } from './fake-world'
import { POLL_MS, START_MS, STARTED_SEC, fakeWorld, runningLine, startSession } from './fake-world'

const BODY_COLUMNS = 40

const PANE = {
  plugin: 'shell-progress',
  component: 'Pane',
  requestId: 'shell-progress',
  props: {
    title: 'Background jobs',
    isFocused: false,
    bodyColumns: BODY_COLUMNS,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const finishedLine = (exitCode: number, seconds: number) =>
  `${STARTED_SEC} done ${exitCode} ${STARTED_SEC + seconds}\n`

async function runProgressCommand($: Engine) {
  return $.command.run({
    command: 'progress',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
}

async function mountPane($: Engine) {
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

test('the pane draws running, finished and failed jobs', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-1.txt', { text: runningLine(7, 12, 'compiling assets'), mtimeMs: START_MS }],
    ['sync.sh-2.txt', { text: runningLine(0, 0, 'downloading users.json'), mtimeMs: START_MS }],
    ['odd.sh-3.txt', { text: 'not a progress line\n', mtimeMs: START_MS }],
    ['lint.sh-4.txt', { text: finishedLine(0, 22), mtimeMs: START_MS }],
    ['migrate.sh-5.txt', { text: finishedLine(1, 64), mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  const textOf = async (text: string | RegExp) => (await ui.find({ type: 'Text', text }))?.text

  expect(await textOf('2 running')).toBe('2 running')
  expect(await textOf('7/12')).toBe('7/12   58%')
  // 7/12 of 38 cells is 177 eighths: 22 full cells and one eighth.
  // Anchored, so the bar's own Text, which holds both parts, does not match.
  const filled = await ui.find({ type: 'Text', text: new RegExp(`^${'█'.repeat(22)}▏$`) })
  expect(filled?.props['color']).toBe('claude')
  expect(await textOf(/^░+$/)).toBe('░'.repeat(15))
  expect(await textOf('compiling assets')).toBe('compiling assets')
  expect(await textOf('no step count')).toBe('no step count')
  expect(await textOf(/downloading users\.json/)).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] downloading users\.json$/)
  expect(await textOf('unreadable progress line')).toBe('unreadable progress line')
  expect(await textOf('Finished')).toBe('Finished')

  const done = await ui.find({ type: 'Text', text: 'done in 0m 22s' })
  expect(done?.props['color']).toBe('success')
  const failed = await ui.find({ type: 'Text', text: 'failed after 1m 04s, exit 1' })
  expect(failed?.props['color']).toBe('error')
  await ui.unmount()
})

test('the finished group lists the newest job first', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['first.sh-1.txt', { text: finishedLine(0, 5), mtimeMs: START_MS }],
    ['second.sh-2.txt', { text: finishedLine(0, 9), mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  const names = (await ui.findAll({ type: 'Button', text: /^(first|second)\.sh$/ })).map(
    found => found.text,
  )
  expect(names).toEqual(['second.sh', 'first.sh'])
  expect((await ui.find({ type: 'Text', text: 'all finished' }))?.text).toBe('all finished')
  await ui.unmount()
})

test('the header counts neither a stalled nor an unreadable job as running', { options: { stallMinutes: 1 } }, async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-1.txt', { text: runningLine(1, 2), mtimeMs: START_MS - 120_000 }],
    ['odd.sh-2.txt', { text: 'not a progress line\n', mtimeMs: START_MS }],
    ['lint.sh-3.txt', { text: finishedLine(0, 22), mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /running$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'all finished' })).toBeUndefined()
  await ui.unmount()
})

test('a job that finished before the session started is not drawn', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['old.sh-1.txt', { text: `${STARTED_SEC - 100} done 0 ${STARTED_SEC - 1}\n`, mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'old.sh' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /No jobs yet/ }))?.text).toBe(
    'No jobs yet. A script that sources the helpers shows here.',
  )
  await ui.unmount()
})

test('a stalled job says how long it ran before its file went quiet', { options: { stallMinutes: 1 } }, async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-1.txt', { text: runningLine(1, 2), mtimeMs: START_MS + 30_000 }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(90_000)

  const ui = await mountPane($)
  const stalled = await ui.find({ type: 'Text', text: /^stalled/ })
  expect(stalled?.text).toBe('stalled after 0m 30s')
  expect(stalled?.props['color']).toBe('warning')
  await ui.unmount()
})

test('the elapsed time moves on while a job runs', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-1.txt', { text: runningLine(1, 2), mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  expect((await ui.find({ type: 'Text', text: /^\dm \d\ds$/ }))?.text).toBe('0m 00s')
  await clock.advance(POLL_MS * 4)
  expect((await ui.find({ type: 'Text', text: /^\dm \d\ds$/ }))?.text).toBe('0m 02s')
  await ui.unmount()
})

test('the bar fits a narrow pane', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-1.txt', { text: runningLine(1, 2), mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 8 }, surface: 'terminal' })
  // Half of 6 cells: 3 full, 3 empty.
  expect((await ui.find({ type: 'Text', text: /^░+$/ }))?.text).toBe('░░░')
  expect((await ui.find({ type: 'Text', text: /^█+$/ }))?.text).toBe('███')
  await ui.unmount()
})

test('a long label is cut at the edge of the pane', async ($, on) => {
  const label = 'compiling '.repeat(10).trim()
  const files = new Map<string, FakeFile>([
    ['build.sh-1.txt', { text: runningLine(1, 2, label), mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  const row = await ui.find({ type: 'Text', text: label })
  expect(row?.props['wrap']).toBe('truncate-end')
  await ui.unmount()
})

test('/progress opens the pane', async ($, on) => {
  const { world } = fakeWorld(on, new Map())
  await startSession($)

  const result = await runProgressCommand($)
  expect(world.opens).toEqual(['shell-progress'])
  expect(result.text).toBe('Background jobs pane opened.')
})

test('/progress says why the pane is not shown where nothing can draw it', async ($, on) => {
  const { world } = fakeWorld(on, new Map())
  world.openResult = { isPlaced: false, reason: 'no-surface: none is attached' }
  await startSession($)

  const result = await runProgressCommand($)
  expect(result.text).toBe('Background jobs pane opened but not shown: no-surface: none is attached')
})

test('a new file that cannot be read shows as unreadable', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['secret.sh-1.txt', { text: runningLine(1, 2), mtimeMs: START_MS, isUnreadable: true }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  expect((await ui.find({ type: 'Button', text: 'secret.sh' }))?.text).toBe('secret.sh')
  expect((await ui.find({ type: 'Text', text: 'unreadable progress line' }))?.text).toBe(
    'unreadable progress line',
  )
  await ui.unmount()
})

test('an unreadable job expands to its file and pid alone, and cannot be dismissed', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['odd.sh-7.txt', { text: 'not a progress line\n', mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  await ui.press({ key: 'odd.sh-7.txt' })
  expect((await ui.find({ type: 'Text', text: /^pid/ }))?.text).toBe('pid 7')
  expect(await ui.find({ type: 'Button', text: /^Dismiss/ })).toBeUndefined()
  await ui.unmount()
})

test('a running job says about how long it has left from its third step', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-1.txt', { text: runningLine(4, 10), mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(100_000)

  const ui = await mountPane($)
  // 100 s over 4 steps is 25 s a step, and 6 steps are left.
  expect((await ui.find({ type: 'Text', text: /left$/ }))?.text).toBe('1m 40s · about 2m 30s left')
  await ui.unmount()
})

const localClockTime = (epochSec: number) => {
  const date = new Date(epochSec * 1000)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(part => String(part).padStart(2, '0'))
    .join(':')
}

test('pressing a job row shows its file, pid and start, and pressing it again hides them', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-48213.txt', { text: runningLine(1, 2), mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  const path = { type: 'Text', text: /build\.sh-48213\.txt$/ } as const
  expect(await ui.find(path)).toBeUndefined()

  await ui.press({ key: 'build.sh-48213.txt' })
  expect((await ui.find(path))?.text).toBe('/work/progress/build.sh-48213.txt')
  expect((await ui.find({ type: 'Text', text: /^pid/ }))?.text).toBe(
    `pid 48213 · started ${localClockTime(STARTED_SEC)}`,
  )
  // A job still running cannot be dismissed.
  expect(await ui.find({ type: 'Button', text: /^Dismiss/ })).toBeUndefined()

  await ui.press({ key: 'build.sh-48213.txt' })
  expect(await ui.find(path)).toBeUndefined()
  await ui.unmount()
})

test('a finished job shows its exit code when expanded', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['migrate.sh-5.txt', { text: finishedLine(1, 64), mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  await ui.press({ key: 'migrate.sh-5.txt' })
  expect((await ui.find({ type: 'Text', text: /^pid/ }))?.text).toBe(
    `pid 5 · started ${localClockTime(STARTED_SEC)} · exit 1`,
  )
  await ui.unmount()
})

test('expanding one row collapses the other', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-1.txt', { text: runningLine(1, 2), mtimeMs: START_MS }],
    ['lint.sh-2.txt', { text: finishedLine(0, 22), mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  await ui.press({ key: 'build.sh-1.txt' })
  await ui.press({ key: 'lint.sh-2.txt' })
  const paths = (await ui.findAll({ type: 'Text', text: /^\/work\/progress\// })).map(found => found.text)
  expect(paths).toEqual(['/work/progress/lint.sh-2.txt'])
  await ui.unmount()
})

test('dismissed stalled and finished jobs are stored, counted as hidden and shown again', { options: { stallMinutes: 1 } }, async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-1.txt', { text: runningLine(1, 2), mtimeMs: START_MS - 120_000 }],
    ['lint.sh-2.txt', { text: finishedLine(0, 22), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  for (const file of ['build.sh-1.txt', 'lint.sh-2.txt']) {
    await ui.press({ key: file })
    await ui.press({ key: `dismiss:${file}` })
  }
  expect(await ui.find({ type: 'Button', text: /\.sh$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /No jobs yet/ })).toBeUndefined()
  expect(world.store.get('dismissedJobs')).toEqual([
    `build.sh-1.txt:${STARTED_SEC}`,
    `lint.sh-2.txt:${STARTED_SEC}`,
  ])

  expect((await ui.find({ type: 'Button', text: /hidden$/ }))?.text).toBe('2 hidden')
  await ui.press({ key: 'show-hidden' })
  const names = (await ui.findAll({ type: 'Button', text: /\.sh$/ })).map(found => found.text)
  expect(names).toEqual(['build.sh', 'lint.sh'])
  expect(world.store.get('dismissedJobs')).toEqual([])
  await ui.unmount()
})

test('a dismissed stalled job leaves the status line and comes back with the hidden jobs', { options: { stallMinutes: 1 } }, async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-1.txt', { text: runningLine(1, 2), mtimeMs: START_MS - 120_000 }],
  ])
  const { world, clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(POLL_MS)
  expect(world.statuses).toEqual(['build stalled'])

  const ui = await mountPane($)
  await ui.press({ key: 'build.sh-1.txt' })
  await ui.press({ key: 'dismiss:build.sh-1.txt' })
  await clock.advance(POLL_MS)
  expect(world.statuses).toEqual(['build stalled', undefined])

  await ui.press({ key: 'show-hidden' })
  await clock.advance(POLL_MS)
  expect(world.statuses).toEqual(['build stalled', undefined, 'build stalled'])
  await ui.unmount()
})

test('a job dismissed in an earlier session stays hidden', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['lint.sh-2.txt', { text: finishedLine(0, 22), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  world.store.set('dismissedJobs', [`lint.sh-2.txt:${STARTED_SEC}`])
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: 'lint.sh' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', text: /hidden$/ }))?.text).toBe('1 hidden')
  await ui.unmount()
})

test('a stored dismissal list that is not a list of strings is logged and ignored', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['lint.sh-2.txt', { text: finishedLine(0, 22), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  world.store.set('dismissedJobs', { 'lint.sh-2.txt': true })
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  expect((await ui.find({ type: 'Button', text: 'lint.sh' }))?.text).toBe('lint.sh')
  expect(world.logs).toEqual([
    'shell-progress: ignoring dismissedJobs in the store: expected a list of strings',
  ])
  await ui.unmount()
})

test('the store keeps the newest 200 dismissals', async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['lint.sh-2.txt', { text: finishedLine(0, 22), mtimeMs: START_MS }],
  ])
  const { world, clock } = fakeWorld(on, files)
  const earlier = Array.from({ length: 200 }, (_, index) => `old.sh-${index}.txt:1`)
  world.store.set('dismissedJobs', earlier)
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  await ui.press({ key: 'lint.sh-2.txt' })
  await ui.press({ key: 'dismiss:lint.sh-2.txt' })
  expect(world.store.get('dismissedJobs')).toEqual([
    ...earlier.slice(1),
    `lint.sh-2.txt:${STARTED_SEC}`,
  ])
  await ui.unmount()
})
