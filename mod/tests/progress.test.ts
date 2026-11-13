import { describe, expect, test } from 'claude-code/testing'

import type { Job, ProgressLine } from '../types'
import { jobStatus, parseProgressLine, statusSummary } from '../hooks/progress'

const STALL_MS = 10 * 60_000
const NOW_MS = 1_700_000_100_000

const running = (
  step: number,
  total: number,
  label = '',
): ProgressLine => ({ kind: 'running', startedSec: 1_700_000_000, step, total, label })

const job = (script: string, line: ProgressLine | null, mtimeMs = NOW_MS): Job => ({
  file: `${script}-1.txt`,
  script,
  mtimeMs,
  line,
})

describe('parseProgressLine', () => {
  test('reads a running line with a label', () => {
    expect(parseProgressLine('1700000000 7 12 compiling assets\n')).toEqual(
      running(7, 12, 'compiling assets'),
    )
  })

  test('reads a running line with no step count', () => {
    expect(parseProgressLine('1700000000 0 0 downloading\n')).toEqual(
      running(0, 0, 'downloading'),
    )
  })

  test('reads an empty label', () => {
    expect(parseProgressLine('1700000000 3 3\n')).toEqual(running(3, 3))
  })

  test('keeps repeated spaces inside a label', () => {
    expect(parseProgressLine('1700000000 1 2 a  b\n')).toEqual(running(1, 2, 'a  b'))
  })

  test('reads a line with no line feed', () => {
    expect(parseProgressLine('1700000000 1 2 x')).toEqual(running(1, 2, 'x'))
  })

  test('caps a step above the total at the total', () => {
    expect(parseProgressLine('1700000000 15 12 overrun\n')).toEqual(
      running(12, 12, 'overrun'),
    )
  })

  test('reads a finished line with exit code 0', () => {
    expect(parseProgressLine('1700000000 done 0 1700000060\n')).toEqual({
      kind: 'finished',
      startedSec: 1_700_000_000,
      exitCode: 0,
      endedSec: 1_700_000_060,
    })
  })

  test('reads a negative exit code', () => {
    expect(parseProgressLine('1700000000 done -1073741819 1700000060\n')).toEqual({
      kind: 'finished',
      startedSec: 1_700_000_000,
      exitCode: -1_073_741_819,
      endedSec: 1_700_000_060,
    })
  })

  const malformed = [
    ['an empty file', ''],
    ['a lone line feed', '\n'],
    ['too few fields', '1700000000 7\n'],
    ['a non-numeric step', '1700000000 seven 12 x\n'],
    ['a negative step', '1700000000 -1 12 x\n'],
    ['a negative total', '1700000000 1 -12 x\n'],
    ['a negative start time', '-1700000000 1 12 x\n'],
    ['a fractional step', '1700000000 1.5 12 x\n'],
    ['a second line', '1700000000 1 12 x\n1700000000 2 12 y\n'],
    ['a carriage return', '1700000000 1 12 x\r\n'],
    ['a tab between fields', '1700000000\t1 12 x\n'],
    ['a step past the safe integers', '1700000000 99999999999999999999 1 x\n'],
    ['a finished line with no end time', '1700000000 done 0\n'],
    ['a finished line with a signed end time', '1700000000 done 0 -5\n'],
    ['a finished line with a word for a code', '1700000000 done ok 1700000060\n'],
  ] as const
  for (const [name, text] of malformed) {
    test(`rejects ${name}`, () => {
      expect(parseProgressLine(text)).toBeNull()
    })
  }
})

describe('jobStatus', () => {
  test('a counted line is running', () => {
    expect(jobStatus(job('build.sh', running(1, 3)), NOW_MS, STALL_MS)).toBe('running')
  })

  test('a line with total 0 has no step count', () => {
    expect(jobStatus(job('sync.sh', running(0, 0)), NOW_MS, STALL_MS)).toBe('no-step-count')
  })

  test('a running job is not stalled just before the threshold', () => {
    const quiet = job('build.sh', running(1, 3), NOW_MS - STALL_MS + 1)
    expect(jobStatus(quiet, NOW_MS, STALL_MS)).toBe('running')
  })

  test('a running job is stalled once its file is unchanged for the threshold', () => {
    const quiet = job('build.sh', running(1, 3), NOW_MS - STALL_MS)
    expect(jobStatus(quiet, NOW_MS, STALL_MS)).toBe('stalled')
  })

  test('a job with no step count stalls too', () => {
    const quiet = job('sync.sh', running(0, 0), NOW_MS - STALL_MS)
    expect(jobStatus(quiet, NOW_MS, STALL_MS)).toBe('stalled')
  })

  test('exit code 0 is done', () => {
    const line = parseProgressLine('1700000000 done 0 1700000060')
    expect(jobStatus(job('lint.sh', line, 0), NOW_MS, STALL_MS)).toBe('done')
  })

  test('a non-zero exit code is failed, however old', () => {
    const line = parseProgressLine('1700000000 done -1 1700000060')
    expect(jobStatus(job('migrate.sh', line, 0), NOW_MS, STALL_MS)).toBe('failed')
  })

  test('a line that does not parse is unreadable', () => {
    expect(jobStatus(job('odd.sh', null), NOW_MS, STALL_MS)).toBe('unreadable')
  })
})

describe('statusSummary', () => {
  test('is undefined with no jobs', () => {
    expect(statusSummary([], NOW_MS, STALL_MS)).toBeUndefined()
  })

  test('names one running job and its percentage', () => {
    expect(statusSummary([job('build.sh', running(7, 12))], NOW_MS, STALL_MS)).toBe(
      'build 58%',
    )
  })

  test('names two jobs and counts the rest', () => {
    const jobs = [
      job('build.sh', running(7, 12)),
      job('test-suite.ps1', running(12, 48)),
      job('sync-fixtures.sh', running(0, 0)),
    ]
    expect(statusSummary(jobs, NOW_MS, STALL_MS)).toBe('build 58% · test-suite 25% · 1 more')
  })

  test('says running for a job with no step count and stalled for a quiet one', () => {
    const jobs = [
      job('sync.sh', running(0, 0)),
      job('build.sh', running(1, 3), NOW_MS - STALL_MS),
    ]
    expect(statusSummary(jobs, NOW_MS, STALL_MS)).toBe('sync running · build stalled')
  })

  test('leaves out finished and unreadable jobs', () => {
    const jobs = [
      job('lint.sh', parseProgressLine('1700000000 done 0 1700000060')),
      job('migrate.sh', parseProgressLine('1700000000 done 1 1700000060')),
      job('odd.sh', null),
      job('build.sh', running(1, 4)),
    ]
    expect(statusSummary(jobs, NOW_MS, STALL_MS)).toBe('build 25%')
  })

  test('is undefined once every job has finished', () => {
    const jobs = [job('lint.sh', parseProgressLine('1700000000 done 0 1700000060'))]
    expect(statusSummary(jobs, NOW_MS, STALL_MS)).toBeUndefined()
  })
})
