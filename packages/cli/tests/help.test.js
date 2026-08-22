// help.test.js — the help screens must be paste-safe.
//
// Every line of an Examples block is one somebody selects and pastes whole. A
// `->` used as a "produces" marker sits on a line that looks like a command, so
// the shell hands fli three junk argv entries — and the same shape in prose
// sent a reader's `npm i -g @frontierjs/cli -> fli` to the registry looking for
// a package called by the arrow. A shell comment is the marker that survives a
// paste.

import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')

const fli = (...args) =>
  spawnSync(process.execPath, [resolve(ROOT, 'bin/fli.js'), ...args], {
    encoding: 'utf8',
    cwd: ROOT,
  }).stdout

// Strip SGR so a dimmed arrow cannot hide from the assertion.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

const PASTE_UNSAFE = ['→', '⇒', '➜']

describe('help screens are paste-safe', () => {

  for (const [label, args] of [['usage', []], ['list', ['list']], ['namespace', ['git']]]) {
    test(`${label} carries no arrow a shell would read as an argument`, () => {
      const found = plain(fli(...args))
        .split('\n')
        .filter((l) => PASTE_UNSAFE.some((a) => l.includes(a)))
      expect(found).toEqual([])
    })
  }

  test('the usage examples annotate with a shell comment', () => {
    expect(plain(fli())).toContain('# shows github namespace')
  })

})
