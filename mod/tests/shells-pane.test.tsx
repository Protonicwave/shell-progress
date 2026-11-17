import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { POLL_MS, fakeWorld, mountPane, startSession } from './fake-world'

const NO_OUTPUT = { stdout: '', stderr: '', interrupted: false }
const SHELL_ROW_TEXT = /# |^(running|completed|failed|stopped|ended) \d|more running$|^Bash$/

/**
 * Answers each shell call in the background, under the id the test names in
 * its command's `# id`, and lets prompts and turn ends through.
 */
function backgroundShells(on: On): void {
  on('tool.call', (_, e) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : ''
    const id = /# (\S+)$/m.exec(command)?.[1]
    return { result: id === undefined ? NO_OUTPUT : { ...NO_OUTPUT, backgroundTaskId: id } }
  })
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.Stop', () => ({}))
}

async function runInBackground($: Engine, id: string, command = `sleep 100 # ${id}`, tool: 'Bash' | 'PowerShell' = 'Bash') {
  await $.tool.call({ tool, command, run_in_background: true })
}

function notification(id: string, status: string): string {
  return [
    '<task-notification>',
    `<task-id>${id}</task-id>`,
    '<tool-use-id>toolu_1</tool-use-id>',
    `<status>${status}</status>`,
    `<summary>Background command completed</summary>`,
    '</task-notification>',
  ].join('\n')
}

async function deliver($: Engine, prompt: string, source: 'system' | 'user' | undefined = 'system') {
  await $.classic.UserPromptSubmit({ prompt, ...(source === undefined ? {} : { source }) })
}

async function endTurn($: Engine, inFlightIds: readonly string[] | undefined) {
  const background = inFlightIds?.map(id => ({ id, type: 'shell', status: 'running', description: id }))
  await $.classic.Stop({ stop_hook_active: false, ...(background === undefined ? {} : { background_tasks: background }) })
}

/** The rows of the Shells group as the pane draws them, top to bottom; empty when it draws none. */
async function shellTexts($: Engine): Promise<readonly string[]> {
  const ui = await mountPane($)
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  await ui.unmount()
  const start = texts.indexOf('Shells')
  if (start === -1) return []
  const fromHeading = texts.slice(start)
  const end = fromHeading.findIndex(text => text === 'Agents' || text === 'Recent')
  const group = end === -1 ? fromHeading : fromHeading.slice(0, end)
  return group.filter(text => SHELL_ROW_TEXT.test(text))
}

test('a command run in the background is listed under Shells with its first line and running time', async ($, on) => {
  const { clock } = fakeWorld(on, new Map())
  backgroundShells(on)
  await startSession($)

  await runInBackground($, 'b1', 'npm run build # b1\nnpm test')
  await clock.advance(5_000)

  expect(await shellTexts($)).toEqual(['npm run build # b1', 'running 5s'])
})

test('a PowerShell command run in the background is listed too', async ($, on) => {
  const { clock } = fakeWorld(on, new Map())
  backgroundShells(on)
  await startSession($)

  await runInBackground($, 'p1', 'Start-Sleep 100 # p1', 'PowerShell')
  await clock.advance(2_000)

  expect(await shellTexts($)).toEqual(['Start-Sleep 100 # p1', 'running 2s'])
})

test('a command with no text is listed by its tool', async ($, on) => {
  fakeWorld(on, new Map())
  on('tool.call', () => ({ result: { ...NO_OUTPUT, backgroundTaskId: 'b1' } }))
  await startSession($)

  await $.tool.call({ tool: 'Bash', command: '', run_in_background: true })

  expect(await shellTexts($)).toEqual(['Bash', 'running 0s'])
})

test("a foreground call, a denied call, a result without a task id and a subagent's background call list no shell", async ($, on) => {
  fakeWorld(on, new Map())
  on('tool.call', (_, e) => {
    if ('command' in e && e.command === 'denied # d1') return { deny: 'not allowed' }
    if ('command' in e && e.command === 'empty id') return { result: { ...NO_OUTPUT, backgroundTaskId: '' } }
    if ('command' in e && e.command === 'plain text') return { result: 'started' }
    return { result: 'agentId' in e && e.agentId !== undefined ? { ...NO_OUTPUT, backgroundTaskId: 's1' } : NO_OUTPUT }
  })
  await startSession($)

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'denied # d1', run_in_background: true }).catch(() => undefined)
  await $.tool.call({ tool: 'Bash', command: 'empty id', run_in_background: true })
  await $.tool.call({ tool: 'PowerShell', command: 'plain text', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 1', run_in_background: true, agentId: 'agent-1' })

  expect(await shellTexts($)).toEqual([])
})

test('a notification ends its shell with its status and the time until it came', async ($, on) => {
  const { clock } = fakeWorld(on, new Map())
  backgroundShells(on)
  await startSession($)
  await runInBackground($, 'b1')
  await runInBackground($, 'b2')
  await runInBackground($, 'b3')
  await runInBackground($, 'b4')

  await clock.advance(7_000)
  await deliver($, [notification('b1', 'completed'), notification('b2', 'failed')].join('\n'))
  await deliver($, notification('b3', 'killed'))
  await deliver($, notification('b4', 'paused'), undefined)
  await clock.advance(60_000)

  expect(await shellTexts($)).toEqual([
    'sleep 100 # b4', 'ended 7s',
    'sleep 100 # b3', 'stopped 7s',
    'sleep 100 # b2', 'failed 7s',
  ])
})

test('a notification for another task, a repeated one and a typed one change nothing', async ($, on) => {
  const { clock } = fakeWorld(on, new Map())
  backgroundShells(on)
  await startSession($)
  await runInBackground($, 'b1')
  await runInBackground($, 'b2')

  await clock.advance(3_000)
  await deliver($, notification('b1', 'completed'))
  await clock.advance(3_000)
  await deliver($, notification('b1', 'failed'))
  await deliver($, notification('elsewhere', 'completed'))
  await deliver($, '<task-notification><status>completed</status></task-notification>')
  await deliver($, notification('b2', 'completed'), 'user')

  expect(await shellTexts($)).toEqual(['sleep 100 # b2', 'running 6s', 'sleep 100 # b1', 'completed 3s'])
})

test("a turn's end marks ended a shell no longer in flight, and its notification then gives the status", async ($, on) => {
  const { clock } = fakeWorld(on, new Map())
  backgroundShells(on)
  await startSession($)
  await runInBackground($, 'b1')
  await runInBackground($, 'b2')

  await clock.advance(4_000)
  await endTurn($, ['b2'])
  expect(await shellTexts($)).toEqual(['sleep 100 # b2', 'running 4s', 'sleep 100 # b1', 'ended 4s'])

  await clock.advance(1_000)
  await deliver($, notification('b1', 'completed'))
  expect(await shellTexts($)).toEqual(['sleep 100 # b2', 'running 5s', 'sleep 100 # b1', 'completed 5s'])
})

test("a turn's end without a list of work in flight ends nothing", async ($, on) => {
  fakeWorld(on, new Map())
  backgroundShells(on)
  await startSession($)
  await runInBackground($, 'b1')

  await endTurn($, undefined)

  expect(await shellTexts($)).toEqual(['sleep 100 # b1', 'running 0s'])
})

test('Shells lists five running shells newest first, counts the rest, then the three newest ended', async ($, on) => {
  fakeWorld(on, new Map())
  backgroundShells(on)
  await startSession($)
  for (const id of ['e1', 'e2', 'e3', 'e4']) await runInBackground($, id)
  for (const id of ['e1', 'e2', 'e3', 'e4']) await deliver($, notification(id, 'completed'))
  for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']) await runInBackground($, id)

  expect(await shellTexts($)).toEqual([
    '2 more running',
    'sleep 100 # r7', 'running 0s',
    'sleep 100 # r6', 'running 0s',
    'sleep 100 # r5', 'running 0s',
    'sleep 100 # r4', 'running 0s',
    'sleep 100 # r3', 'running 0s',
    'sleep 100 # e4', 'completed 0s',
    'sleep 100 # e3', 'completed 0s',
    'sleep 100 # e2', 'completed 0s',
  ])
})

test('past 20 shells the oldest ended go first, then the oldest running', async ($, on) => {
  fakeWorld(on, new Map())
  backgroundShells(on)
  await startSession($)
  for (const id of ['e1', 'e2', 'e3', 'e4']) await runInBackground($, id)
  for (const id of ['e1', 'e2', 'e3', 'e4']) await deliver($, notification(id, 'completed'))
  for (let index = 1; index <= 18; index += 1) await runInBackground($, `r${index}`)

  const twoEndedKept = await shellTexts($)
  expect(twoEndedKept[0]).toBe('13 more running')
  expect(twoEndedKept.slice(-4)).toEqual(['sleep 100 # e4', 'completed 0s', 'sleep 100 # e3', 'completed 0s'])

  for (let index = 19; index <= 22; index += 1) await runInBackground($, `r${index}`)
  expect((await shellTexts($))[0]).toBe('15 more running')
})

test('a shell started again under its id keeps one row', async ($, on) => {
  fakeWorld(on, new Map())
  backgroundShells(on)
  await startSession($)

  await runInBackground($, 'b1', 'first # b1')
  await runInBackground($, 'b1', 'second # b1')

  expect(await shellTexts($)).toEqual(['second # b1', 'running 0s'])
})

test('a running shell keeps the pane moving between turns', async ($, on) => {
  const { clock } = fakeWorld(on, new Map())
  backgroundShells(on)
  await startSession($)
  await runInBackground($, 'b1')

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'running 0s' })).toBeDefined()
  for (let poll = 0; poll < 4; poll += 1) await clock.advance(POLL_MS)
  expect(await ui.find({ type: 'Text', text: 'running 2s' })).toBeDefined()
  await ui.unmount()
})

test('a shell that cannot be stored is logged and its call, prompt and turn go on', async ($, on) => {
  const { world } = fakeWorld(on, new Map())
  backgroundShells(on)
  on('state.set', (_, e, next) => {
    if (e.key === 'backgroundShells') return { deny: 'the state is read-only' }
    return next(e)
  })
  await startSession($)

  expect(await $.tool.call({ tool: 'Bash', command: 'sleep 1 # b1', run_in_background: true })).toMatchObject({
    result: { backgroundTaskId: 'b1' },
  })
  await deliver($, notification('b1', 'completed'))
  await endTurn($, [])

  expect(world.logs).toContain(
    'shell-progress: cannot record a background shell: shell-progress: $.state.set: the state is read-only',
  )
})

test('a list of shells that cannot be read is logged once and the polls go on', async ($, on) => {
  const { clock, world } = fakeWorld(on, new Map())
  backgroundShells(on)
  on('state.get', (_, e, next) => {
    if (e.key === 'backgroundShells') return { deny: 'the state is unreadable' }
    return next(e)
  })
  await startSession($)

  for (let poll = 0; poll < 3; poll += 1) await clock.advance(POLL_MS)

  const failures = world.logs.filter(line => line.startsWith('shell-progress: cannot read the background shells: '))
  expect(failures).toHaveLength(1)
})
