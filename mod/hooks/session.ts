import type { EndedCall, RunningCall, ToolCalls } from '../types'
import { MS_PER_SECOND, durationText } from './progress'

/** How many ended calls the pane lists, newest first. */
export const RECENT_CALL_COUNT = 3
// Parallel calls are few; past this the oldest is dropped, as the end of the
// turn would drop it, so a call whose end is never heard cannot grow the list.
const MAX_RUNNING_CALLS = 20
const SECONDS_PER_MINUTE = 60

export const NO_TOOL_CALLS: ToolCalls = { running: [], recent: [] }

/**
 * The one argument of a built-in tool's input worth showing beside its name,
 * on one line; empty for any other tool or an argument that is not text.
 */
export function toolArgumentText(tool: string, input: Readonly<Record<string, unknown>>): string {
  switch (tool) {
    case 'Bash':
      return textOf(input['command']).split('\n', 1)[0] ?? ''
    case 'Read':
    case 'Edit':
    case 'Write':
      return textOf(input['file_path'])
    case 'Grep': {
      const pattern = textOf(input['pattern'])
      const path = textOf(input['path'])
      if (pattern === '') return ''
      return path === '' ? `"${pattern}"` : `"${pattern}" in ${path}`
    }
    case 'Glob':
      return textOf(input['pattern'])
    default:
      return ''
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function recordStart(calls: ToolCalls, call: RunningCall): ToolCalls {
  return { ...calls, running: [...calls.running, call].slice(-MAX_RUNNING_CALLS) }
}

/** Moves the call from the running ones to the head of the recent ones. */
export function recordEnd(calls: ToolCalls, call: EndedCall): ToolCalls {
  return {
    running: calls.running.filter(one => one.id !== call.id),
    recent: [call, ...calls.recent].slice(0, RECENT_CALL_COUNT),
  }
}

/** Drops the calls still running, whose ends will not be heard once the turn is over. */
export function endTurnCalls(calls: ToolCalls): ToolCalls {
  return { ...calls, running: [] }
}

/** `6s` under a minute, `1m 04s` from one. */
export function shortDurationText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  return seconds < SECONDS_PER_MINUTE ? `${seconds}s` : durationText(seconds)
}
