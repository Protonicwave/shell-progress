import { expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On, SessionUsage, UiNotifyResult, UiOpenResult, UiViewResult } from 'claude-code'

const DIR = '/work/progress'
// The engine hands paths on in the platform's form, a drive letter and
// backslashes on Windows, so the fake compares them without the root.
const segments = (path: string) =>
  path.split(/[\\/]/).filter(part => part !== '' && !/^[A-Za-z]:$/.test(part))
const fileNameOf = (path: string) => segments(path).at(-1) ?? ''
export const POLL_MS = 500
export const BODY_COLUMNS = 40

export const PANE = {
  plugin: 'shell-progress',
  component: 'Pane',
  requestId: 'shell-progress',
  props: {
    title: 'This session',
    isFocused: false,
    bodyColumns: BODY_COLUMNS,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const
export const START_MS = 1_700_000_000_000
export const STARTED_SEC = START_MS / 1000

export type FakeFile = { text: string; mtimeMs: number; isUnreadable?: boolean }

/**
 * A progress directory beneath the mod, counting what the mod asks of it,
 * a record of the status line, the panes it opens and what it announces, and
 * the mod's store.
 */
export function fakeWorld(on: On, files: Map<string, FakeFile> | undefined) {
  const world = {
    lists: 0,
    reads: [] as string[],
    statuses: [] as (string | undefined)[],
    logs: [] as string[],
    opens: [] as string[],
    /** What each `$.ui.open` answers; a test may change it. */
    openResult: { isPlaced: true } as UiOpenResult,
    /** Set to make every later listing never settle, as on a hung network share. */
    isListingHung: false,
    /** The mod's `$.store`, which a test may fill before the session starts. */
    store: new Map<string, unknown>(),
    toasts: [] as string[],
    notifications: [] as string[],
    /** What each `$.ui.notify` answers, or the hook's reason to deny it; a test may change it. */
    notifyResult: { isSent: true, channel: 'kitty' } as UiNotifyResult | { deny: string },
    /** What each `$.agent.list` answers; a test may change it. */
    agents: [] as AgentInfo[],
    /** Set to make every later `$.agent.list` reject. */
    isAgentListFailing: false,
    /** The agent ids the mod asked `$.ui.view` to show. */
    views: [] as (string | undefined)[],
    /** What each `$.ui.view` answers; a test may change it. */
    viewResult: {} as UiViewResult,
  }
  const clock = mock.clock(on, { now: START_MS })
  mock.env(on, { CLAUDE_PROGRESS_DIR: DIR })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.list', async (_, e) => {
    expect(segments(e.path)).toEqual(segments(DIR))
    world.lists += 1
    if (world.isListingHung) await new Promise<never>(() => {})
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
  on('session.usage', () => ({ value: { startedAt: START_MS } as SessionUsage }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    world.opens.push(e.id)
    return { value: world.openResult }
  })
  on('store.get', (_, e) => ({ value: world.store.get(e.key) }))
  on('store.set', (_, e) => {
    world.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    world.notifications.push(e.text)
    return 'deny' in world.notifyResult ? world.notifyResult : { value: world.notifyResult }
  })
  on('ui.log', (_, e) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
  on('agent.list', () => {
    // A hook that throws is skipped, and with none left the call rejects.
    if (world.isAgentListFailing) throw new Error('agent list unavailable')
    return { value: world.agents }
  })
  on('ui.view', (_, e) => {
    world.views.push(e.agentId)
    return { value: world.viewResult }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { world, clock }
}

export async function mountPane($: Engine) {
  return $.ui.mount({ ...PANE, surface: 'terminal' })
}

export async function startSession($: Engine): Promise<void> {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

export const runningLine = (step: number, total: number, label = '') =>
  `${STARTED_SEC} ${step} ${total}${label === '' ? '' : ` ${label}`}\n`
