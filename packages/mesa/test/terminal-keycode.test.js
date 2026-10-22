// FJS-3407: a keydown's `code` is a browser's, so one handler reads both targets.
import { describe, it, expect } from 'vitest'
import { keyFields } from '../src/runtime-terminal.js'

describe('keyFields code', () => {
  it('names a letter KeyJ, as a browser does', () => {
    expect(keyFields({ name: 'j', sequence: 'j' }).code).toBe('KeyJ')
    expect(keyFields({ name: 'j', sequence: 'J', shift: true }).code).toBe('KeyJ')
    expect(keyFields({ name: 'n', ctrl: true }).code).toBe('KeyN')
    expect(keyFields({ name: 'linefeed' }).code).toBe('KeyJ')
  })
  it('names a digit and a named key as a browser does', () => {
    expect(keyFields({ name: '1', sequence: '1' }).code).toBe('Digit1')
    expect(keyFields({ name: 'return' }).code).toBe('Enter')
    expect(keyFields({ name: 'space', sequence: ' ' }).code).toBe('Space')
    expect(keyFields({ name: 'up' }).code).toBe('ArrowUp')
    expect(keyFields({ name: 'escape' }).code).toBe('Escape')
    expect(keyFields({ name: 'pagedown' }).code).toBe('PageDown')
  })
})
