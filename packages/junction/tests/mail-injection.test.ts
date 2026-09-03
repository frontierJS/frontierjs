// tests/mail-injection.test.ts
//
// FJS-677 — SMTP is line-oriented and every field on a message reaches a line.
// A `to` of `victim@y.test>\r\nRCPT TO:<...>\r\nDATA\r\n...` is not a bad
// address, it is a second transaction: the client sent what it was given, and a
// fake MTA queued TWO messages from one `sendMail` — the second one composed by
// whoever typed the address into a form. The subject survived only by accident,
// because `encodeMimeHeader` base64-encodes anything non-printable and a CRLF
// was hidden by a rule that exists for emoji.
//
// Driven OUT OF PROCESS against a real fake MTA on a local TCP port, and both
// halves of that are load-bearing. The MTA, because the assertion that matters
// is what reached the WIRE — a unit test over the builder alone passes with
// `sendMail` unguarded, and `sendMail` is exported and reachable directly. The
// separate process, because `tests/email.test.ts` calls `mock.module()` on the
// smtp shim that `export *`s this client: the replacement is process-wide and
// never undone, so an in-process version passed ALONE and graded a mock inside
// the suite (measured — five of these went green in isolation and failed in the
// full run). `tests/smtp-starttls.test.ts` is here for the same reason.

import { describe, it, expect } from 'bun:test'
import { join, dirname } from 'node:path'
import { fileURLToPath }  from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('an address cannot become a command (FJS-677)', () => {

  it('refuses every injection and still sends a valid message', () => {
    const proc = Bun.spawnSync({
      cmd: ['bun', join(HERE, 'fixtures', 'mail-injection-probe.ts')],
      cwd: HERE,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = proc.stdout.toString() + proc.stderr.toString()
    // The probe's own lines are the report: a failure names which assertion
    // and what it saw, which is the half an exit code cannot carry.
    if (proc.exitCode !== 0) console.log(out)
    expect(out).toContain('ok injected to is refused before any socket write')
    expect(out).toContain('ok no RCPT was sent')
    expect(out).toContain('ok a valid address still sends')
    expect(out).not.toContain('not ok')
    expect(proc.exitCode).toBe(0)
  })
})
