import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ToolCallResult } from 'claude-code'

import { fakeWorld, mountPane, startSession } from './fake-world'

const TURN_ID = 'turn-1'

async function startTurn($: Engine, agentId?: string) {
  await $.turn.start({ text: 'fix the tests', turnId: TURN_ID, ...(agentId === undefined ? {} : { agentId }) })
}

async function completeTurn($: Engine, durationMs: number) {
  await $.turn.complete({ answer: '', durationMs, isAborted: false, turnId: TURN_ID, reason: 'answer' })
}

/** A tool that answers only when the test says so. */
function heldTool() {
  const answers: ((result: ToolCallResult) => void)[] = []
  return {
    hook: () => new Promise<ToolCallResult>(resolve => answers.push(resolve)),
    answer: (result: ToolCallResult) => answers.shift()?.(result),
  }
}

test('the tool.call hook passes on the result the tool gave', async ($, on) => {
  fakeWorld(on, new Map())
  on('tool.call', () => ({ result: { stdout: 'ok' }, isError: true, text: 'exit 1' }))
  await startSession($)

  const result = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(result).toMatchObject({ result: { stdout: 'ok' }, isError: true, text: 'exit 1' })
})

test('a call that rejects rejects through the hook and shows as failed', async ($, on) => {
  const { clock } = fakeWorld(on, new Map())
  await startSession($)

  // No tool.call hook beneath the mod, so the call has no implementation.
  let rejection: unknown
  await $.tool.call({ tool: 'Read', file_path: 'a.txt' }).catch((error: unknown) => {
    rejection = error
  })
  expect(rejection).toBeInstanceOf(Error)

  await clock.advance(0)
  const ui = await mountPane($)
  expect((await ui.find({ type: 'Text', text: /^failed after/ }))?.text).toBe('failed after 0s')
  await ui.unmount()
})

test('Now shows the running call and its time, and Recent lists it once it ends', async ($, on) => {
  const { clock } = fakeWorld(on, new Map())
  const tool = heldTool()
  on('tool.call', tool.hook)
  await startSession($)
  await startTurn($)

  const call = $.tool.call({ tool: 'Bash', command: 'npm test -- orders' })
  await clock.advance(6_000)
  const ui = await mountPane($)
  expect((await ui.find({ type: 'Text', text: /^Bash$/ }))?.props['bold']).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^npm test -- orders$/ }))?.text).toBe('npm test -- orders')
  expect((await ui.find({ type: 'Text', text: /^6s$/ }))?.text).toBe('6s')
  expect((await ui.find({ type: 'Text', text: /^turn / }))?.text).toBe('turn 6s')

  tool.answer({ result: {} })
  await call
  expect(await ui.find({ type: 'Text', text: 'Recent' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Thinking$/ }))?.text).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking$/)
  expect((await ui.find({ type: 'Text', text: /^6s$/ }))?.props['dimColor']).toBe(true)
  await ui.unmount()
})

test('Recent keeps the three newest calls, newest first, and marks a failed one', async ($, on) => {
  fakeWorld(on, new Map())
  on('tool.call', (_, e) => (e.tool === 'Grep' ? { result: 'no match', isError: true } : { result: {} }))
  await startSession($)
  await startTurn($)

  for (const file_path of ['a.txt', 'b.txt', 'c.txt']) await $.tool.call({ tool: 'Read', file_path })
  await $.tool.call({ tool: 'Grep', pattern: 'orders', path: 'src/' })

  const ui = await mountPane($)
  const shown = await ui.findAll({ type: 'Text', text: /^(c\.txt|b\.txt|a\.txt|"orders" in src\/)$/ })
  expect(shown.map(found => found.text)).toEqual(['"orders" in src/', 'c.txt', 'b.txt'])
  expect((await ui.find({ type: 'Text', text: /^failed after/ }))?.props['color']).toBe('error')
  await ui.unmount()
})

test('a call still running when the turn ends leaves Now', async ($, on) => {
  const { clock } = fakeWorld(on, new Map())
  on('tool.call', heldTool().hook)
  await startSession($)
  await startTurn($)

  void $.tool.call({ tool: 'Bash', command: 'sleep 100' })
  await clock.advance(1_000)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'sleep 100' })).toBeDefined()

  await completeTurn($, 25_000)
  expect(await ui.find({ type: 'Text', text: 'sleep 100' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^Waiting for you/ }))?.text).toBe(
    'Waiting for you · last turn took 25s',
  )
  expect(await ui.find({ type: 'Text', text: /^turn / })).toBeUndefined()
  await ui.unmount()
})

test("a subagent's turns and calls are not shown", async ($, on) => {
  fakeWorld(on, new Map())
  on('tool.call', () => ({ result: {} }))
  await startSession($)

  await startTurn($, 'agent-1')
  await $.tool.call({ tool: 'Read', file_path: 'a.txt', agentId: 'agent-1' })

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Recent' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^Waiting for you/ }))?.text).toBe('Waiting for you')
  await ui.unmount()
})

test("the turn's time moves on while it runs", async ($, on) => {
  const { clock } = fakeWorld(on, new Map())
  await startSession($)
  await startTurn($)

  const ui = await mountPane($)
  expect((await ui.find({ type: 'Text', text: /^turn / }))?.text).toBe('turn 0s')
  await clock.advance(3_000)
  expect((await ui.find({ type: 'Text', text: /^turn / }))?.text).toBe('turn 3s')
  await ui.unmount()
})

test('a pane with no jobs and no calls draws neither group', async ($, on) => {
  fakeWorld(on, new Map())
  await startSession($)

  const ui = await mountPane($)
  expect((await ui.find({ type: 'Text', text: 'This session' }))?.text).toBe('This session')
  expect(await ui.find({ type: 'Text', text: 'Jobs' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Recent' })).toBeUndefined()
  await ui.unmount()
})
