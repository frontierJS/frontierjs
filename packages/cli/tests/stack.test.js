// tests/stack.test.js
//
// The whole path, executed: a command that throws, run through `bin/fli.js` by
// BOTH runtimes, asserting the frame names the `.md` and the line its author
// wrote.
//
// The unit tests next door grade the offset arithmetic and the string rewrite.
// Neither of them can see what this sees, and this is where the defect lived:
// the `sourceURL` pragma satisfied every unit-level expectation — a pragma was
// emitted, it named the right file — while reporting `boom.md:15` for a throw
// on line 9 of an 11-line file, and being ignored outright by Bun (`FJS-066`).
//
// Both runtimes on purpose. Bun ignores `sourceURL`, an inline source map and a
// linked `.map` alike, so a test that only ran Node would have passed
// throughout the entire life of the bug.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const FLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fli.js')

// The throw is on line 9 of an 11-line file. Both numbers matter: the line is
// what must be reported, and the length is what makes the old answer visibly
// impossible rather than merely wrong.
const COMMAND = [
  '---',                                                    // 1
  'title: probe:boom',                                      // 2
  'description: throws on purpose',                         // 3
  '---',                                                    // 4
  '',                                                       // 5
  'Prose before the block, which becomes a comment.',       // 6
  '',                                                       // 7
  '```js',                                                  // 8
  "const detonate = () => { throw new Error('kaboom') }",   // 9
  'detonate()',                                             // 10
  '```',                                                    // 11
].join('\n')

let project

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), 'fli-stack-'))
  mkdirSync(join(project, 'cli', 'src', 'routes', 'probe'), { recursive: true })
  writeFileSync(join(project, '.fli.json'), '{}')
  writeFileSync(join(project, 'cli', 'src', 'routes', 'probe', 'boom.md'), COMMAND)
})

afterAll(() => { rmSync(project, { recursive: true, force: true }) })

/** Run the failing command and return everything it printed. */
function runWith(runtime) {
  try {
    execFileSync(runtime, [FLI, 'probe:boom', '--project', project], {
      encoding: 'utf8', env: { ...process.env, FLI_DEBUG: '1' },
    })
    throw new Error('the probe command was supposed to throw')
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

describe('a stack from a command names the .md and the line', () => {
  for (const runtime of ['node', 'bun']) {
    test(`${runtime}: the frame is boom.md:9`, () => {
      const out = runWith(runtime)

      expect(out).toContain('kaboom')
      expect(out).toMatch(/boom\.md:9\b/)
    })

    test(`${runtime}: no temp shim is named`, () => {
      // The shim is deleted when the process exits, so a path pointing at one
      // is a path nobody can open.
      const out = runWith(runtime)
      expect(out).not.toMatch(/\.fli-tmp|c_[a-z0-9]+_[a-z0-9]+\.mjs/)
    })

    test(`${runtime}: and never a line the file does not have`, () => {
      // The old answer on Node. The file is 11 lines; :15 was reported.
      const out = runWith(runtime)
      const lines = [...out.matchAll(/boom\.md:(\d+)/g)].map(m => Number(m[1]))
      expect(lines.length).toBeGreaterThan(0)
      expect(Math.max(...lines)).toBeLessThanOrEqual(11)
    })
  }
})
