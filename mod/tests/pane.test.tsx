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
  // Each name is a dim Text inside the row's cutting Text; the outer ones give the order.
  const names = (await ui.findAll({ type: 'Text', text: /^(first|second)\.sh$/ }))
    .filter(found => found.props['wrap'] === 'truncate-end')
    .map(found => found.text)
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

test('a stalled job says so beside its elapsed time', { options: { stallMinutes: 1 } }, async ($, on) => {
  const files = new Map<string, FakeFile>([
    ['build.sh-1.txt', { text: runningLine(1, 2), mtimeMs: START_MS }],
  ])
  const { clock } = fakeWorld(on, files)
  await startSession($)
  await clock.advance(60_000)

  const ui = await mountPane($)
  const stalled = await ui.find({ type: 'Text', text: /^stalled/ })
  expect(stalled?.text).toBe('stalled 1m 00s')
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
