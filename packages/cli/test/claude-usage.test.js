// A streamed reply is written as several lines with one message id, so a tally
// that counts lines reads two or three times the tokens and still draws a
// plausible chart. So does one that counts a subagent as its own session.

import { test, expect } from 'bun:test'
import { tallySession, mergeSession, compact, CLAUDE_ZERO } from '../core/claude-usage.js'
import { buildSeries, renderChart } from '../core/git-history.js'

const reply = (id, timestamp, usage) => JSON.stringify({ type: 'assistant', timestamp, message: { id, usage } })
const U = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 }

const SESSION = [
  JSON.stringify({ type: 'user', cwd: '/repo/pkg', entrypoint: 'claude-vscode', timestamp: '2026-10-06T10:00:00Z' }),
  reply('msg_a', '2026-10-06T10:00:01Z', U),
  reply('msg_a', '2026-10-06T10:00:02Z', U),
  reply('msg_b', '2026-10-07T09:00:00Z', { ...U, output_tokens: 7 }),
  '{"type":"assistant","message":{"usage":',
].join('\n')

test('one message id counts once, however many lines stream it', () => {
  const s = tallySession(SESSION, { day: (iso) => iso.slice(0, 10) })
  expect(s.cwd).toBe('/repo/pkg')
  expect(s.headless).toBe(false)
  expect(s.first).toBe('2026-10-06')
  expect(s.days.get('2026-10-06')).toEqual({ ...CLAUDE_ZERO, output: 50, total: 1152 })
  expect(s.days.get('2026-10-07').output).toBe(7)
})

test('a resumed session repeating a reply does not count it again', () => {
  const seen = new Set()
  const day = (iso) => iso.slice(0, 10)
  tallySession(SESSION, { seen, day })
  expect(tallySession(SESSION, { seen, day }).days.size).toBe(0)
})

test('a subagent adds tokens and no session; a headless run is counted apart', () => {
  const day = (iso) => iso.slice(0, 10)
  const days = new Map()
  mergeSession(days, tallySession(SESSION, { day }))
  const headless = SESSION.replace('claude-vscode', 'sdk-cli').replaceAll('msg_', 'msg_h')
  mergeSession(days, tallySession(headless, { day }))
  mergeSession(days, tallySession(SESSION.replaceAll('msg_', 'msg_s'), { day }), { subagent: true })
  expect(days.get('2026-10-06')).toEqual({ sessions: 2, headless: 1, output: 150, total: 3456 })
})

test('the claude series fills the same columns the commit series does', () => {
  const days = new Map([['2026-10-06', { ...CLAUDE_ZERO, output: 4_200_000 }]])
  const { buckets } = buildSeries(days, { from: '2026-10-05', to: '2026-10-07', zero: CLAUDE_ZERO })
  expect(buckets.map(b => [b.date, b.output])).toEqual([['2026-10-05', 0], ['2026-10-06', 4_200_000], ['2026-10-07', 0]])
})

test('a compact axis keeps every row the same width when a lower tick is wider', () => {
  const days = new Map([['2026-10-06', { ...CLAUDE_ZERO, output: 6_000_000 }]])
  const series = buildSeries(days, { from: '2026-10-05', to: '2026-10-07', zero: CLAUDE_ZERO })
  const rows = renderChart(series, { height: 4, width: 40, value: (b) => b.output, label: compact })
  const axis = rows.slice(0, 4).map(r => r.search(/[│┤]/))
  expect(new Set(axis).size).toBe(1)
})

test('compact', () => {
  expect([0, 950, 1500, 4_200_000, 45_000_000, 11e9].map(compact)).toEqual(['0', '950', '1.5k', '4.2M', '45M', '11B'])
})
