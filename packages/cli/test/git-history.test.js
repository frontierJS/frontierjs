// The x axis is time, so a quiet day must be a column and a commit must land in
// the bucket for its own day. A chart that drops either still draws, and reads
// as a plausible history that is not this one.

import { test, expect } from 'bun:test'
import { parseLog, buildSeries, renderChart, summarize } from '../core/git-history.js'

// The plotted cells of one bar row — after the axis, which is a tick on some rows.
const plot = (row) => row.slice(row.search(/[│┤]/) + 1)

const LOG = [
  '@2026-10-06',
  '',
  ' 3 files changed, 10 insertions(+), 2 deletions(-)',
  '@2026-10-06',
  '',
  ' 1 file changed, 1 insertion(+)',
  '@2026-10-08',
  '',
  ' 2 files changed, 4 deletions(-)',
  '@2026-10-08',
  '',
].join('\n')

test('parseLog counts commits and both stat halves per day', () => {
  const days = parseLog(LOG)
  expect(days.get('2026-10-06')).toMatchObject({ commits: 2, added: 11, deleted: 2 })
  // A commit with no shortstat (an empty or merge commit) still counts.
  expect(days.get('2026-10-08')).toMatchObject({ commits: 2, added: 0, deleted: 4 })
})

test('a day with no commits is a zero bucket, never a missing one', () => {
  const { buckets } = buildSeries(parseLog(LOG), { from: '2026-10-05', to: '2026-10-09' })
  expect(buckets.map(b => [b.date, b.commits])).toEqual([
    ['2026-10-05', 0], ['2026-10-06', 2], ['2026-10-07', 0], ['2026-10-08', 2], ['2026-10-09', 0],
  ])
})

test('a commit outside the range is not counted', () => {
  const { buckets } = buildSeries(parseLog(LOG), { from: '2026-10-07', to: '2026-10-07' })
  expect(buckets).toEqual([{ date: '2026-10-07', commits: 0, added: 0, deleted: 0, created: 0, edited: 0, removed: 0 }])
})

test('weekly buckets start on Monday and hold every day of their week', () => {
  // 2026-10-05 is a Monday; the 11th the Sunday closing it.
  const days = parseLog('@2026-10-05\n@2026-10-11\n@2026-10-12\n')
  const { buckets } = buildSeries(days, { from: '2026-10-07', to: '2026-10-13', by: 'week' })
  expect(buckets.map(b => [b.date, b.commits])).toEqual([['2026-10-05', 2], ['2026-10-12', 1]])
})

test('the range crosses a DST change without losing or doubling a day', () => {
  const { buckets } = buildSeries(new Map(), { from: '2026-03-07', to: '2026-03-10' })
  expect(buckets.map(b => b.date)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'])
})

test('renderChart: one column per bucket, tallest bar reaches the top row', () => {
  const series = buildSeries(parseLog(LOG), { from: '2026-10-05', to: '2026-10-09' })
  const rows = renderChart(series, { height: 4, width: 40 })
  // 4 bar rows, the axis, two label rows.
  expect(rows).toHaveLength(7)
  expect(rows[0]).toContain('█')
  const cells = plot(rows[3])
  // Column 1 and 3 hold commits, 0 2 4 are empty: positions at col width 3.
  expect(cells[3]).toBe('█')
  expect(cells[0]).toBe(' ')
  expect(cells[6]).toBe(' ')
})

test('renderChart: a single commit is visible beside a tall day', () => {
  const days = parseLog(['@2026-10-05', ...Array(100).fill('@2026-10-06')].join('\n'))
  const series = buildSeries(days, { from: '2026-10-05', to: '2026-10-06' })
  const rows = renderChart(series, { height: 4, width: 40 })
  expect(plot(rows[3])[0]).toBe('▁')
})

test('renderChart: Monday and month labels sit under their own column', () => {
  const series = buildSeries(new Map(), { from: '2026-09-28', to: '2026-10-06' })
  const rows = renderChart(series, { height: 3, width: 60 })
  const axis = rows.at(-3)
  const days = rows.at(-2)
  const months = rows.at(-1)
  const origin = axis.indexOf('└') + 1
  // Col width 3: 2026-09-28 (Mon) at column 0, 2026-10-05 (Mon) at column 7.
  expect(days.slice(origin, origin + 2)).toBe('28')
  expect(days.slice(origin + 21, origin + 22)).toBe('5')
  expect(months.slice(origin, origin + 8)).toBe('Sep 2026')
  expect(months.slice(origin + 9, origin + 12)).toBe('Oct')
})

test('summarize: busiest follows the value being charted', () => {
  const series = buildSeries(parseLog(LOG), { from: '2026-10-06', to: '2026-10-08' })
  expect(summarize(series).busiest.date).toBe('2026-10-06')
  const s = summarize(series, (b) => b.deleted)
  expect(s.busiest.date).toBe('2026-10-08')
  expect(s).toMatchObject({ commits: 4, added: 11, deleted: 6, active: 2, buckets: 3 })
})

const NAMES = [
  '@2026-10-06',
  '',
  'A\tsrc/new.js',
  'M\tsrc/old.js',
  'M\tdocs/changed.md',
  'R087\tsrc/a.js\tsrc/b.js',
  'D\tsrc/gone.js',
  '@2026-10-06',
  '',
  'A\tsrc/other.js',
].join('\n')

test('parseLog counts name-status lines as created, edited and removed', () => {
  // A rename is an edit; a path holding the word "changed" is not a shortstat.
  expect(parseLog(NAMES).get('2026-10-06')).toEqual({ commits: 2, added: 0, deleted: 0, created: 2, edited: 3, removed: 1 })
})

test('summarize totals the file fields', () => {
  const s = summarize(buildSeries(parseLog(NAMES), { from: '2026-10-06', to: '2026-10-06' }))
  expect(s).toMatchObject({ created: 2, edited: 3, removed: 1 })
})
