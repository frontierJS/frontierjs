// ─── A reader that quit first ────────────────────────────────────────────────
//
// Piping a listing to `head`, `grep` or `less` closes the pipe while fli is
// still writing to it. Without an `error` listener node raises EPIPE on the
// stream and the process dies printing its own stack over whatever the person
// was reading (`FJS-379`). Measured, not reasoned about: the fix is at the one
// entry point, so the test runs the entry point.
//
// The trap this test exists to survive: merging stderr into the same pipe hides
// the failure completely, because the trace goes into the pipe that just
// closed. stderr is captured to its own file here, which is how a person sees it.

import { describe, test, expect } from 'bun:test'
import { execSync } from 'child_process'
import { readFileSync, rmSync, mkdtempSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FLI  = resolve(ROOT, 'bin/fli.js')

/** Run `fli <args>` through `head -3`, answering what landed on stderr. */
function piped(args) {
  const dir = mkdtempSync(join(tmpdir(), 'fli-pipe-'))
  const err = join(dir, 'err.txt')
  try {
    execSync(`"${process.execPath}" "${FLI}" ${args} 2>"${err}" | head -3`,
      { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] })
    return readFileSync(err, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('a reader that quit first', () => {

  test('`fli list | head -3` writes nothing to stderr', () => {
    const stderr = piped('list')
    expect(stderr).not.toContain('EPIPE')
    expect(stderr).not.toContain("Unhandled 'error' event")
  })

  test('`fli help | head -3` is the same shape', () => {
    expect(piped('help')).not.toContain('EPIPE')
  })
})
