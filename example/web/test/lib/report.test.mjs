// web/test/lib/report.test.mjs — the grader's printed table.
// Run from example/: bun test web/test/lib/report.test.mjs
import { test, expect } from 'bun:test'
import { report } from './report.mjs'

function printed(fn) {
  const lines = []
  const log = console.log, error = console.error
  console.log = console.error = (...a) => lines.push(...a.join(' ').split('\n'))
  try { return { value: fn(), lines } } finally { console.log = log; console.error = error }
}

// fli prove keeps a drive's last 30 lines, and verify.mjs grades hundreds of
// rows: a FAIL printed in place scrolled out of that tail, so a flake recorded
// only "1 assertion(s) failed" and could never be chased (FJS-3167).
test('the last lines name every failed assertion, however long the table', () => {
  const expected = {}, got = {}
  for (let i = 0; i < 200; i++) { expected[`row${i}`] = i; got[`row${i}`] = i }
  got.row3 = 'wrong'
  got.unlisted = true

  const { value, lines } = printed(() => report(got, expected))
  const tail = lines.slice(-30).join('\n')

  expect(value).toBe(2)
  expect(tail).toContain('row3')
  expect(tail).toContain('unlisted')
  expect(tail).toContain('2 assertion(s) failed')
})

test('a clean run prints no failure list', () => {
  const { value, lines } = printed(() => report({ a: 1 }, { a: 1 }))
  expect(value).toBe(0)
  expect(lines.at(-1)).toBe('all 1 assertions passed')
})
