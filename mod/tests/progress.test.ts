import { describe, expect, test } from 'claude-code/testing'

import type { Job, ProgressLine } from '../types'
import {
  barText,
  dismissalKey,
  durationText,
  finishedText,
  isStalled,
  parseProgressLine,
  remainingSeconds,
  remainingText,
  shownJobs,
  statusSummary,
} from '../hooks/progress'
import type { RunningLine } from '../hooks/progress'

const STALL_MS = 10 * 60_000
const NOW_MS = 1_700_000_100_000

const running = (
  step: number,
  total: number,
  label = '',
): RunningLine => ({ kind: 'running', startedSec: 1_700_000_000, step, total, label })

const job = (script: string, line: ProgressLine | null, mtimeMs = NOW_MS): Job => ({
  file: `${script}-1.txt`,
  script,
  pid: '1',
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

describe('isStalled', () => {
  test('a running job is not stalled just before the threshold', () => {
    const quiet = job('build.sh', running(1, 3), NOW_MS - STALL_MS + 1)
    expect(isStalled(quiet, NOW_MS, STALL_MS)).toBe(false)
  })

  test('a running job is stalled once its file is unchanged for the threshold', () => {
    const quiet = job('build.sh', running(1, 3), NOW_MS - STALL_MS)
    expect(isStalled(quiet, NOW_MS, STALL_MS)).toBe(true)
  })

  test('a job with no step count stalls too', () => {
    const quiet = job('sync.sh', running(0, 0), NOW_MS - STALL_MS)
    expect(isStalled(quiet, NOW_MS, STALL_MS)).toBe(true)
  })

  test('a finished job never stalls, however old', () => {
    const line = parseProgressLine('1700000000 done -1 1700000060')
    expect(isStalled(job('migrate.sh', line, 0), NOW_MS, STALL_MS)).toBe(false)
  })

  test('an unreadable job never stalls', () => {
    expect(isStalled(job('odd.sh', null, 0), NOW_MS, STALL_MS)).toBe(false)
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

describe('barText', () => {
  const EIGHTHS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉']

  test('is all empty at 0', () => {
    expect(barText(0, 10)).toEqual({ filled: '', empty: '░'.repeat(10) })
  })

  test('is all filled at 1', () => {
    expect(barText(1, 10)).toEqual({ filled: '█'.repeat(10), empty: '' })
  })

  test('draws a partial cell after the full ones', () => {
    expect(barText(0.55, 10)).toEqual({ filled: '█████▌', empty: '░'.repeat(4) })
  })

  test('draws every eighth of a cell', () => {
    EIGHTHS.forEach((glyph, index) => {
      const eighths = 3 * 8 + index + 1
      expect(barText(eighths / 80, 10)).toEqual({ filled: `███${glyph}`, empty: '░'.repeat(6) })
    })
  })

  test('rounds to the nearest eighth', () => {
    expect(barText(0.999, 10)).toEqual({ filled: '█'.repeat(10), empty: '' })
    expect(barText(0.001, 10)).toEqual({ filled: '', empty: '░'.repeat(10) })
  })

  test('refuses a fraction outside 0 to 1 or a width below one cell', () => {
    expect(() => barText(1.5, 10)).toThrow('expected a fraction from 0 to 1, got 1.5')
    expect(() => barText(0.5, 0)).toThrow('expected at least one cell, got 0')
  })
})

describe('durationText', () => {
  test('gives minutes and padded seconds below an hour', () => {
    expect(durationText(0)).toBe('0m 00s')
    expect(durationText(72)).toBe('1m 12s')
    expect(durationText(3599)).toBe('59m 59s')
  })

  test('gives hours and padded minutes from an hour', () => {
    expect(durationText(3600)).toBe('1h 00m')
    expect(durationText(7_505)).toBe('2h 05m')
  })

  test('shows a start in the future as no time at all', () => {
    expect(durationText(-30)).toBe('0m 00s')
  })
})

describe('finishedText', () => {
  test('gives the duration of a job that exited 0', () => {
    expect(finishedText({ kind: 'finished', startedSec: 100, exitCode: 0, endedSec: 122 })).toBe(
      'done in 0m 22s',
    )
  })

  test('gives the duration and exit code of a job that failed', () => {
    expect(finishedText({ kind: 'finished', startedSec: 100, exitCode: -1, endedSec: 164 })).toBe(
      'failed after 1m 04s, exit -1',
    )
  })
})

describe('remainingSeconds', () => {
  // NOW_MS is 100 s after `running`'s start.
  test('gives none before the third step', () => {
    expect(remainingSeconds(running(2, 10), NOW_MS)).toBeUndefined()
  })

  test('gives none for a job with no step count', () => {
    expect(remainingSeconds(running(5, 0), NOW_MS)).toBeUndefined()
  })

  test('takes the average time per step so far over the steps left', () => {
    expect(remainingSeconds(running(4, 10), NOW_MS)).toBe(150)
  })

  test('gives none left at the last step', () => {
    expect(remainingSeconds(running(10, 10), NOW_MS)).toBe(0)
  })

  test('counts a start in the future as no time spent', () => {
    expect(remainingSeconds(running(4, 10), 1_699_999_990_000)).toBe(0)
  })
})

describe('remainingText', () => {
  test('rounds to the nearest 5 seconds', () => {
    expect(remainingText(23)).toBe('about 25s left')
    expect(remainingText(150)).toBe('about 2m 30s left')
  })

  test('never says less than 5 seconds', () => {
    expect(remainingText(0)).toBe('about 5s left')
  })

  test('gives minutes from 60 seconds and hours from an hour', () => {
    expect(remainingText(58)).toBe('about 1m 00s left')
    expect(remainingText(7_505)).toBe('about 2h 05m left')
  })
})

describe('dismissalKey', () => {
  test('names the file and the run, so a later run in the same file is a new job', () => {
    expect(dismissalKey(job('build.sh', running(1, 2)))).toBe('build.sh-1.txt:1700000000')
  })

  test('gives none for an unreadable job', () => {
    expect(dismissalKey(job('odd.sh', null))).toBeUndefined()
  })
})

describe('shownJobs', () => {
  const SESSION_STARTED_MS = 1_700_000_000_500
  const NONE_DISMISSED = new Set<string>()
  const finished = (script: string, endedSec: number, exitCode = 0): Job =>
    job(script, { kind: 'finished', startedSec: 1_699_999_000, exitCode, endedSec })
  const keysOf = (...jobs: Job[]) => new Set(jobs.map(one => dismissalKey(one) ?? ''))

  test('keeps running and unreadable jobs unfinished, in the order given', () => {
    const jobs = [job('build.sh', running(1, 2)), job('odd.sh', null), job('sync.sh', running(0, 0))]
    expect(shownJobs(jobs, SESSION_STARTED_MS, NONE_DISMISSED)).toEqual({
      unfinished: jobs,
      finished: [],
      hiddenCount: 0,
    })
  })

  test('hides jobs that finished before the session started', () => {
    const before = finished('old.sh', 1_699_999_999)
    const sameSecond = finished('edge.sh', 1_700_000_000)
    expect(shownJobs([before, sameSecond], SESSION_STARTED_MS, NONE_DISMISSED).finished).toEqual([
      sameSecond,
    ])
  })

  test('shows the five newest finished jobs, newest first', () => {
    const jobs = [1, 2, 3, 4, 5, 6, 7].map(n => finished(`job${n}.sh`, 1_700_000_000 + n, n % 2))
    expect(
      shownJobs(jobs, SESSION_STARTED_MS, NONE_DISMISSED).finished.map(one => one.script),
    ).toEqual(['job7.sh', 'job6.sh', 'job5.sh', 'job4.sh', 'job3.sh'])
  })

  test('leaves out dismissed jobs and counts them as hidden', () => {
    const stalled = job('build.sh', running(1, 2), NOW_MS - STALL_MS)
    const done = finished('lint.sh', 1_700_000_005)
    const kept = finished('test.sh', 1_700_000_006)
    expect(shownJobs([stalled, done, kept], SESSION_STARTED_MS, keysOf(stalled, done))).toEqual({
      unfinished: [],
      finished: [kept],
      hiddenCount: 2,
    })
  })

  test('shows a later run in the same file as a dismissed one', () => {
    const earlier = job('build.sh', { ...running(1, 2), startedSec: 1_699_999_000 })
    const later = job('build.sh', running(1, 2))
    expect(shownJobs([later], SESSION_STARTED_MS, keysOf(earlier))).toEqual({
      unfinished: [later],
      finished: [],
      hiddenCount: 0,
    })
  })

  test('does not count a dismissed job that would not show anyway', () => {
    const old = finished('old.sh', 1_699_999_999)
    expect(shownJobs([old], SESSION_STARTED_MS, keysOf(old)).hiddenCount).toBe(0)
  })

  test('fills the place of a dismissed finished job with the next newest', () => {
    const jobs = [1, 2, 3, 4, 5, 6].map(n => finished(`job${n}.sh`, 1_700_000_000 + n))
    const dismissed = keysOf(...jobs.filter(one => one.script === 'job6.sh'))
    expect(
      shownJobs(jobs, SESSION_STARTED_MS, dismissed).finished.map(one => one.script),
    ).toEqual(['job5.sh', 'job4.sh', 'job3.sh', 'job2.sh', 'job1.sh'])
  })
})
