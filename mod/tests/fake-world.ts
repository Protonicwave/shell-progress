import { expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionUsage, UiOpenResult } from 'claude-code'

const DIR = '/work/progress'
// The engine hands paths on in the platform's form, a drive letter and
// backslashes on Windows, so the fake compares them without the root.
const segments = (path: string) =>
  path.split(/[\\/]/).filter(part => part !== '' && !/^[A-Za-z]:$/.test(part))
const fileNameOf = (path: string) => segments(path).at(-1) ?? ''
export const POLL_MS = 500
export const START_MS = 1_700_000_000_000
export const STARTED_SEC = START_MS / 1000

export type FakeFile = { text: string; mtimeMs: number; isUnreadable?: boolean }

/**
 * A progress directory beneath the mod, counting what the mod asks of it,
 * and a record of the status line and of the panes it opens.
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
  on('ui.log', (_, e) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
  return { world, clock }
}

export async function startSession($: Engine): Promise<void> {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

export const runningLine = (step: number, total: number, label = '') =>
  `${STARTED_SEC} ${step} ${total}${label === '' ? '' : ` ${label}`}\n`
