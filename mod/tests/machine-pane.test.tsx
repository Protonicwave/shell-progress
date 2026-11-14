import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { FakeFile } from './fake-world'
import { PANE, POLL_MS, STARTED_SEC, START_MS, fakeWorld, mountPane, runningLine, startSession } from './fake-world'

const GB = 1024 ** 3
const RESTART_MS = 60_000
const JOB = 'build.sh-1.txt'

const sampleLine = (changes: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    cpuPercent: 34.2,
    cpuSpeedPercent: 160,
    gpuPercent: 5.3,
    freeMemoryBytes: 11.2 * GB,
    power: 'mains',
    batteryPercent: null,
    ...changes,
  })}\r\n`

function withRunningJob(on: On) {
  const files = new Map<string, FakeFile>([[JOB, { text: runningLine(1, 4, 'compiling'), mtimeMs: START_MS }]])
  const { world, clock } = fakeWorld(on, files)
  return { files, world, clock, sampler: world.sampler }
}

function finishJob(files: Map<string, FakeFile>) {
  files.set(JOB, { text: `${STARTED_SEC} done 0 ${STARTED_SEC + 9}\n`, mtimeMs: START_MS + POLL_MS })
}

async function machineTexts($: Engine) {
  const ui = await mountPane($)
  const readings = (await ui.find({ type: 'Text', text: /^cpu / }))?.text
  const warning = await ui.find({ type: 'Text', text: /held at|on battery/ })
  await ui.unmount()
  return { readings, warning: warning?.text, warningColour: warning?.props['color'] }
}

async function poll(clock: MockClock) {
  await clock.advance(POLL_MS)
}

test('the sampler starts with the first unfinished job and stops after the last', async ($, on) => {
  const { files, clock, sampler } = withRunningJob(on)
  await startSession($)
  await poll(clock)

  expect(sampler.runningCount).toBe(1)
  expect(sampler.argvs[0]?.slice(0, 2)).toEqual(['powershell.exe', '-NoProfile'])
  expect(sampler.argvs[0]?.at(-1)).toMatch(/[\\/]hooks\/sampler\.ps1$/)

  await poll(clock)
  expect(sampler.argvs).toHaveLength(1)

  finishJob(files)
  await poll(clock)
  expect(sampler.runningCount).toBe(0)
})

test('a job that starts after the sampler stopped starts it again at once', async ($, on) => {
  const { files, clock, sampler } = withRunningJob(on)
  await startSession($)
  await poll(clock)
  finishJob(files)
  await poll(clock)

  files.set('test.sh-2.txt', { text: runningLine(1, 3), mtimeMs: START_MS + 2 * POLL_MS })
  await poll(clock)
  expect(sampler.argvs).toHaveLength(2)
  expect(sampler.runningCount).toBe(1)
})

test('the machine row shows the readings while a job runs', async ($, on) => {
  const { clock, sampler } = withRunningJob(on)
  await startSession($)
  await poll(clock)
  sampler.write(sampleLine())
  await clock.settle()

  expect(await machineTexts($)).toEqual({
    readings: 'cpu 34% · gpu 5% · 11.2 GB free',
    warning: undefined,
    warningColour: undefined,
  })
  const ui = await mountPane($)
  expect((await ui.find({ type: 'Text', text: 'machine' }))?.text).toBe('machine')
  await ui.unmount()
})

test('the machine row warns of a held-back CPU only while it is busy', async ($, on) => {
  const { clock, sampler } = withRunningJob(on)
  await startSession($)
  await poll(clock)

  sampler.write(sampleLine({ cpuPercent: 20, cpuSpeedPercent: 60 }))
  await clock.settle()
  expect((await machineTexts($)).warning).toBeUndefined()

  sampler.write(sampleLine({ cpuPercent: 85, cpuSpeedPercent: 78 }))
  await clock.settle()
  expect(await machineTexts($)).toMatchObject({ warning: 'held at 78% speed', warningColour: 'warning' })
})

test('the machine row warns when the machine is on battery', async ($, on) => {
  const { clock, sampler } = withRunningJob(on)
  await startSession($)
  await poll(clock)
  sampler.write(sampleLine({ power: 'battery', batteryPercent: 41 }))
  await clock.settle()

  expect(await machineTexts($)).toMatchObject({ warning: 'on battery, 41%', warningColour: 'warning' })
})

test('a narrow pane draws the machine label and readings', async ($, on) => {
  const { clock, sampler } = withRunningJob(on)
  await startSession($)
  await poll(clock)
  sampler.write(sampleLine())
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 }, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^cpu / }))?.text).toBe('cpu 34% · gpu 5% · 11.2 GB free')
  expect((await ui.find({ type: 'Text', text: 'machine' }))?.text).toBe('machine')
  await ui.unmount()
})

test('the machine row goes once a reading is 15 s old', async ($, on) => {
  const { clock, sampler } = withRunningJob(on)
  await startSession($)
  await poll(clock)
  sampler.write(sampleLine())
  await clock.settle()

  await clock.advance(15_000 + POLL_MS)
  expect((await machineTexts($)).readings).toBeUndefined()
})

test('the machine row goes when the last job finishes', async ($, on) => {
  const { files, clock, sampler } = withRunningJob(on)
  await startSession($)
  await poll(clock)
  sampler.write(sampleLine())
  await clock.settle()

  finishJob(files)
  await poll(clock)
  expect((await machineTexts($)).readings).toBeUndefined()
})

test('a sampler that cannot start is logged once and tried again after a minute', async ($, on) => {
  const { world, clock, sampler } = withRunningJob(on)
  sampler.isMissing = true
  await startSession($)
  await poll(clock)

  await clock.advance(RESTART_MS - 2 * POLL_MS)
  expect(sampler.argvs).toHaveLength(1)
  await clock.advance(2 * POLL_MS)
  expect(sampler.argvs).toHaveLength(2)

  const logged = world.logs.filter(line => line.includes('cannot sample the machine'))
  expect(logged).toEqual(['shell-progress: cannot sample the machine: shell-progress: $.process.spawn: powershell.exe: not found'])
  expect((await machineTexts($)).readings).toBeUndefined()
})

test('a sampler that writes a bad line is logged, stopped and started again after a minute', async ($, on) => {
  const { world, clock, sampler } = withRunningJob(on)
  await startSession($)
  await poll(clock)
  sampler.write('not json\n')
  await clock.settle()

  expect(sampler.runningCount).toBe(0)
  expect(world.logs).toContain('shell-progress: cannot sample the machine: expected a JSON sampler line, got not json')
  await clock.advance(RESTART_MS)
  expect(sampler.runningCount).toBe(1)
})

test('a sampler that exits is logged with what it wrote to stderr', async ($, on) => {
  const { world, clock, sampler } = withRunningJob(on)
  await startSession($)
  await poll(clock)
  sampler.write('Exception calling "NextValue"\r\n', 'stderr')
  sampler.end(1)
  await clock.settle()

  expect(world.logs).toContain(
    'shell-progress: cannot sample the machine: the sampler exited with code 1: Exception calling "NextValue"',
  )
})
