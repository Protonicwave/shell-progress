import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, AgentStatus, ToolCallResult } from 'claude-code'

import { PANE, POLL_MS, START_MS, fakeWorld, mountPane, runningLine, startSession } from './fake-world'

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

test('a call whose end the pane cannot record runs once and answers as the tool did', async ($, on) => {
  fakeWorld(on, new Map())
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return { result: { stdout: 'ok' } }
  })
  // Lets each call's start be recorded and refuses its end, after the tool ran.
  let writes = 0
  on('state.set', { plugin: 'shell-progress', key: 'toolCalls' }, (_, e, next) => {
    writes += 1
    return writes % 2 === 0 ? { deny: 'store full' } : next(e)
  })
  await startSession($)

  for (const command of ['npm test', 'npm run lint']) {
    expect(await $.tool.call({ tool: 'Bash', command })).toMatchObject({ result: { stdout: 'ok' } })
  }
  expect(runs).toBe(2)
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

test('a pane with no jobs, agents or calls draws none of their groups', async ($, on) => {
  const { clock } = fakeWorld(on, new Map())
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  expect((await ui.find({ type: 'Text', text: 'This session' }))?.text).toBe('This session')
  expect(await ui.find({ type: 'Text', text: 'Jobs' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Agents' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Recent' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'context' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^session cost/ })).toBeUndefined()
  await ui.unmount()
})

const HIGH_USAGE = {
  startedAt: START_MS,
  context: { tokens: 170_000, window: 200_000, percent: 85 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 40 }],
  cost: { usd: 1.84 },
}

test('each usage bar shares a row with its label and figures, and the cost follows', async ($, on) => {
  const { world } = fakeWorld(on, new Map())
  world.usage = HIGH_USAGE
  await startSession($)

  const ui = await mountPane($)
  expect((await ui.find({ key: 'context' }))?.text).toMatch(/^context[█▏▎▍▌▋▊▉░]+85% · 170k of 200k$/)
  expect((await ui.find({ key: '5h limit' }))?.text).toMatch(/^5h limit[█▏▎▍▌▋▊▉░]+40%$/)
  expect((await ui.find({ type: 'Text', text: /^session cost/ }))?.text).toBe('session cost $1.84')
  // 40 columns less the label's 8, the widest figures' 18 and two gaps leave
  // 12 cells for each bar. From 80% a bar turns to the warning colour.
  const filled = await ui.findAll({ type: 'Text', text: /^[█▏▎▍▌▋▊▉]+$/ })
  expect(filled.map(bar => [bar.text.length, bar.props['color']])).toEqual([
    [11, 'warning'],
    [5, 'claude'],
  ])
  await ui.unmount()
})

test('the context figures end with what the last turn added', async ($, on) => {
  const { world } = fakeWorld(on, new Map())
  const contextAt = (tokens: number, percent: number) => ({
    startedAt: START_MS,
    context: { tokens, window: 200_000, percent },
    rateLimits: [],
  })
  world.usage = contextAt(76_000, 38)
  await startSession($)
  await startTurn($)
  world.usage = contextAt(88_000, 44)
  await completeTurn($, 1_000)

  const ui = await mountPane($)
  expect((await ui.find({ type: 'Text', text: /^44% · / }))?.text).toBe('44% · 88k of 200k · +12k')
  await ui.unmount()
})

test('the limit figures give the time it fills, as a warning, if that is before the reset', async ($, on) => {
  const { world, clock } = fakeWorld(on, new Map())
  const minuteMs = 60_000
  const resetsAt = new Date(START_MS + 300 * minuteMs).toISOString()
  const limitAt = (percentUsed: number) => ({
    startedAt: START_MS,
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed, resetsAt }],
  })
  await startSession($)
  world.usage = limitAt(50)
  await startTurn($)
  await completeTurn($, 1_000)
  await clock.advance(5 * minuteMs)
  world.usage = limitAt(60)
  await startTurn($)
  await completeTurn($, 1_000)

  // 10 points in 5 minutes: the 40 left take 20 minutes from the second turn's end.
  const fullClock = new Date(START_MS + 25 * minuteMs).toTimeString().slice(0, 5)
  const ui = await mountPane($)
  const figures = await ui.find({ type: 'Text', text: /^60% · / })
  expect(figures?.text).toBe(`60% · full by ${fullClock}`)
  expect(figures?.props['color']).toBe('warning')
  await ui.unmount()
})

test('below 40 columns each usage bar takes a row of its own under its label and figures', async ($, on) => {
  const { world } = fakeWorld(on, new Map())
  world.usage = HIGH_USAGE
  await startSession($)

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 39 }, surface: 'terminal' })
  const context = await ui.find({ key: 'context' })
  expect(context?.props['flexDirection']).toBe('column')
  expect(context?.text).toMatch(/^context85% · 170k of 200k[█▏▎▍▌▋▊▉░]+$/)
  // The full width less the two columns kept clear: 37 cells.
  const filled = await ui.findAll({ type: 'Text', text: /^[█▏▎▍▌▋▊▉]+$/ })
  expect(filled.map(bar => bar.text.length)).toEqual([32, 15])
  await ui.unmount()
})

test('a figure the session lacks leaves its bar or line out', async ($, on) => {
  const { world } = fakeWorld(on, new Map())
  world.usage = {
    startedAt: START_MS,
    context: { window: 200_000 },
    rateLimits: [],
    cost: { usd: 0 },
  }
  await startSession($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'context' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '5h limit' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^session cost/ }))?.text).toBe('session cost $0.00')
  await ui.unmount()
})

const HIGH_USAGE_STATUS = 'ctx 85% · 5h 40% · $1.84'

test('the status line carries the usage figures only while the pane is not in view', async ($, on) => {
  const { world, clock } = fakeWorld(on, new Map())
  world.usage = HIGH_USAGE
  await startSession($)
  const pane = { id: PANE.requestId, title: PANE.props.title, isFocused: false }

  await clock.advance(POLL_MS)
  world.panes = [{ ...pane, isShown: true, isPlaced: true }]
  await clock.advance(POLL_MS)
  world.panes = [{ ...pane, isShown: false, isPlaced: true }]
  await clock.advance(POLL_MS)
  world.panes = [{ ...pane, isShown: true, isPlaced: true }]
  await clock.advance(POLL_MS)
  world.panes = [{ ...pane, isShown: false, isPlaced: false }]
  await clock.advance(POLL_MS)
  expect(world.statuses).toEqual([HIGH_USAGE_STATUS, undefined, HIGH_USAGE_STATUS, undefined, HIGH_USAGE_STATUS])
})

test('the usage figures follow the running jobs on the status line', async ($, on) => {
  const files = new Map([['build.sh-10.txt', { text: runningLine(1, 2), mtimeMs: START_MS }]])
  const { world, clock } = fakeWorld(on, files)
  world.usage = HIGH_USAGE
  await startSession($)

  await clock.advance(POLL_MS)
  expect(world.statuses).toEqual([`build 50%   ${HIGH_USAGE_STATUS}`])
})

const agent = (id: string, description: string, status: AgentStatus = 'running'): AgentInfo => ({
  id,
  description,
  type: 'Explore',
  status,
})

test('Agents lists the agents newest first with their status, and drops one the engine drops', async ($, on) => {
  const { world, clock } = fakeWorld(on, new Map())
  world.agents = [agent('a1', 'review migrations', 'completed'), agent('a2', 'find callers')]
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: 'Agents' })).toBeDefined()
  const rows = await ui.findAll({ type: 'Button', text: /^(review migrations|find callers)$/ })
  expect(rows.map(row => row.text)).toEqual(['find callers', 'review migrations'])
  expect((await ui.find({ type: 'Text', text: /^completed$/ }))?.props['color']).toBe('success')
  expect((await ui.find({ type: 'Text', text: /^running$/ }))?.props['color']).toBe('claude')

  world.agents = [agent('a2', 'find callers', 'failed')]
  await clock.advance(POLL_MS)
  expect(await ui.find({ type: 'Button', text: 'review migrations' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^failed$/ }))?.props['color']).toBe('error')
  await ui.unmount()
})

test("pressing an agent's row shows its transcript", async ($, on) => {
  const { world, clock } = fakeWorld(on, new Map())
  world.agents = [agent('a1', 'review migrations')]
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  await ui.press({ key: 'agent:a1' })
  expect(world.views).toEqual(['a1'])
  expect(world.toasts).toEqual([])
  await ui.unmount()
})

test('a transcript that cannot be shown says why in a toast', async ($, on) => {
  const { world, clock } = fakeWorld(on, new Map())
  world.agents = [agent('a1', 'review migrations')]
  world.viewResult = { deny: 'the teammate runs in a pane of its own' }
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  await ui.press({ key: 'agent:a1' })
  expect(world.toasts).toEqual([
    'Cannot show review migrations: the teammate runs in a pane of its own',
  ])
  await ui.unmount()
})

test('past five agents the newest five are drawn and the rest counted', async ($, on) => {
  const { world, clock } = fakeWorld(on, new Map())
  world.agents = ['1', '2', '3', '4', '5', '6', '7'].map(id => agent(id, `task ${id}`))
  await startSession($)
  await clock.advance(POLL_MS)

  const ui = await mountPane($)
  const rows = await ui.findAll({ type: 'Button', text: /^task \d$/ })
  expect(rows.map(row => row.text)).toEqual(['task 7', 'task 6', 'task 5', 'task 4', 'task 3'])
  expect((await ui.find({ type: 'Text', text: /^2 more$/ }))?.text).toBe('2 more')
  await ui.unmount()
})

test('an agent list that does not settle is logged once and the jobs poll goes on', async ($, on) => {
  const { world, clock } = fakeWorld(on, new Map())
  await startSession($)
  await clock.advance(POLL_MS)
  world.isAgentListHung = true

  const listsBefore = world.lists
  await clock.advance(POLL_MS * 4)
  expect(world.lists).toBe(listsBefore + 4)
  await clock.advance(60_000)
  expect(world.logs).toEqual(['shell-progress: a listing of agents has not finished after 30s'])
})

test('a failing agent list is logged once and the last list stays drawn', async ($, on) => {
  const { world, clock } = fakeWorld(on, new Map())
  world.agents = [agent('a1', 'review migrations')]
  await startSession($)
  await clock.advance(POLL_MS)

  world.isAgentListFailing = true
  for (let poll = 0; poll < 3; poll += 1) await clock.advance(POLL_MS)
  expect(world.logs).toHaveLength(1)
  expect(world.logs[0]).toMatch(/^shell-progress: cannot list agents: /)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', text: 'review migrations' })).toBeDefined()
  await ui.unmount()
})
