// FJS-1224 — the address rule has one owner (`smtp.ts`) and a test double
// implementing `IMail` reaches it through the package root. Re-exported from the
// mail module and absent from the root, the door was not in the wall: an app
// writing a capture double had to restate the rule by hand.

import { describe, expect, it } from 'bun:test'
import * as root from '../index.ts'

describe('the package root carries the mail asserters a test double needs', () => {
  it('exports the three that a double calls', () => {
    expect(typeof root.assertMessageAddresses).toBe('function')
    expect(typeof root.assertHeaderValue).toBe('function')
    expect(typeof root.assertHeaderName).toBe('function')
  })

  it('refuses what the real mailer refuses', () => {
    expect(() => root.assertMessageAddresses({ to: 'victim@y.test>\r\nRCPT TO:<x@y.test>' } as never)).toThrow()
    expect(() => root.assertHeaderValue('a\r\nBcc: x@y.test', 'headers.X')).toThrow()
    expect(() => root.assertHeaderName('X Bad:')).toThrow()
  })
})
