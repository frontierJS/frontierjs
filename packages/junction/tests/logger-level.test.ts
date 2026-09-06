// tests/logger-level.test.ts
//
// The log level can be moved in a running process, and the change reaches the
// children.
//
// `minLevel` was destructured once in `createLogger` and closed over, and
// `child()` passed a COPY of it. So there was no way to turn debug on in a
// process that was already running — the thing you want a level for — and no
// way for a change to reach a child even if there had been.
//
// The fix is a CELL shared by reference down the tree, which is litestone's
// `enc` arrangement for the reason it states: a spread copies a string by
// value, so the root moves and everything derived from it keeps the old one.

import { describe, test, expect } from 'bun:test'
import { createLogger, noopLogger } from '../src/core/logger.ts'

const capture = () => {
  const seen: string[] = []
  const log = createLogger({ level: 'info', writers: [e => seen.push(`${e.ns ?? '-'}:${e.level}`)] })
  return { seen, log }
}

describe('setLevel reaches the whole tree', () => {

  test('a child and a grandchild follow the root', () => {
    const { seen, log } = capture()
    const kid   = log.child('orders')
    const grand = kid.child('pay')

    log.debug('a'); kid.debug('b'); grand.debug('c')
    expect(seen).toEqual([])                       // the control: info hides debug

    log.setLevel('debug')
    log.debug('a'); kid.debug('b'); grand.debug('c')
    expect(seen).toEqual(['-:debug', 'orders:debug', 'orders:pay:debug'])
  })

  test('a child created AFTER the change gets it too', () => {
    const { seen, log } = capture()
    log.setLevel('debug')
    log.child('late').debug('x')
    expect(seen).toEqual(['late:debug'])
  })

  test('the level is a property of the logger, not of a namespace', () => {
    // Stated rather than discovered: the cell is shared, so setting it on a
    // child moves the root. That is what "turn debug on in a running process"
    // wants; per-namespace verbosity would need a cell per node with a fallback
    // to its parent, which is a different feature.
    const { log } = capture()
    const kid = log.child('orders')
    kid.setLevel('error')
    expect(log.level).toBe('error')
    expect(kid.level).toBe('error')
  })

  test('a level that is not one is refused by name', () => {
    const { log } = capture()
    expect(() => log.setLevel('chatty' as never)).toThrow(/is not a level/)
    expect(log.level).toBe('info')
  })

  test('the no-op logger accepts it and stays quiet', () => {
    // A no-op that THREW here would make every caller branch on which logger
    // it holds.
    expect(() => noopLogger.setLevel('debug')).not.toThrow()
    expect(noopLogger.level).toBe('silent')
  })
})
