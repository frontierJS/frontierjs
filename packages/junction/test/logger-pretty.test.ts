// test/logger-pretty.test.ts
//
// Eight `key=value` pairs on one line wrap back to column 0 mid-pair, so a line
// with many fields prints them one per row under the message. A line with few
// keeps them inline, because a request log split across four rows buries the
// next request.

import { describe, test, expect } from 'bun:test'
import { createLogger } from '../src/core/logger.ts'

const capture = (fn: () => void): string => {
  const out: string[] = []
  const real = process.stdout.write.bind(process.stdout)
  ;(process.stdout as any).write = (s: string) => { out.push(String(s)); return true }
  try { fn() } finally { (process.stdout as any).write = real }
  // Strip color so the assertions read the layout, whatever the host's TTY.
  return out.join('').replace(/\x1b\[[0-9;]*m/g, '')
}

const log = createLogger({ format: 'pretty', level: 'debug' })

describe('pretty layout', () => {
  test('few fields stay on the line, quoted where a space would run on', () => {
    const out = capture(() => log.info('restored', { count: 1, note: 'two words' }))
    expect(out.trimEnd().split('\n')).toHaveLength(1)
    expect(out).toContain('restored count=1 note="two words"')
  })

  test('many fields print one per row, keys aligned, values unquoted', () => {
    const out = capture(() => log.info('🚀 app v1.0.0', {
      url:      'http://0.0.0.0:8120',
      routes:   41,
      prefix:   undefined,
      autoload: 'api/src/services (declared)',
      mode:     'production',
    }))
    const rows = out.trimEnd().split('\n')
    expect(rows[0]).toEndWith('🚀 app v1.0.0')
    expect(rows.slice(1)).toEqual([
      '    url       http://0.0.0.0:8120',
      '    routes    41',
      '    autoload  api/src/services (declared)',
      '    mode      production',
    ])
  })

  test('a block still quotes a value that would break into the next row', () => {
    const out = capture(() => log.info('m', { a: 1, b: 2, c: 3, d: 'x\ny' }))
    expect(out).toContain('    d  "x\\ny"')
  })

  test('a block still redacts', () => {
    const out = capture(() => log.info('m', { a: 1, b: 2, c: 3, password: 'hunter2' }))
    expect(out).not.toContain('hunter2')
    expect(out).toContain('    password  [redacted]')
  })
})
