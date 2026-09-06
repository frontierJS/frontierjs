// doubles.ts — the Testing realm's stand-ins.
//
// ── What is here, and what deliberately is not ────────────────────────────
//
// `batteries-13` asked for doubles for mail, storage and cache. Asked of the
// code rather than of the list, only ONE of the three is missing (`FJS-908`):
//
//   · **cache** — `createMemoryCache()` from `@frontierjs/junction` is already
//     an in-memory implementation of `ICache`, held to the same contract as the
//     SQLite driver by a conformance suite that runs one body against both
//     (`FJS-898`). A second one would be a second answer to *what a cache does
//     in a test*, and the two would drift.
//
//   · **storage** — `FileStorage({ provider: 'local', localPath })` from
//     `@frontierjs/litestone` is already the local implementation, and the
//     assertion surface is the filesystem, which a test can read directly.
//
//   · **mail** — genuinely missing. Nothing implements `IMail` without a mail
//     server, and *what was sent* existed nowhere, so every suite that wanted
//     to ask **did an invitation reach this address** had to stand up an MTA or
//     mock a module.
//
// So one double is written, and the other two are named rather than shipped —
// otherwise somebody completes the set later and the drift starts.

import { assertMessageAddresses, assertHeaderValue, assertHeaderName } from '@frontierjs/junction/mail'
import type { IMail, MailMessage, SendResult } from '@frontierjs/junction/mail'

export interface TestMailer extends IMail {
  /** Every message accepted, in order. */
  readonly sent: MailMessage[]
  /** The last message accepted, or undefined. */
  readonly last: MailMessage | undefined
  /** Messages addressed to `address` — `to`, `cc` and `bcc` all count. */
  to(address: string): MailMessage[]
  /** Make the next `n` sends throw. The retry and outbox paths need failures. */
  failNext(error?: Error, n?: number): void
  /** Forget everything sent. Does not clear a pending `failNext`. */
  reset(): void
}

const recipients = (m: MailMessage): string[] =>
  [m.to, m.cc, m.bcc].flatMap(v => (v == null ? [] : Array.isArray(v) ? v : [v]))

/**
 * An `IMail` that keeps what it was given.
 *
 * It applies the SAME acceptance rule the real mailer does — the address and
 * header guards `FJS-677` put on both ends of the SMTP path — because a double
 * that accepts a message SMTP would refuse is worse than no double at all: the
 * test passes and the send fails in production. The guards are imported rather
 * than restated, so they cannot drift from the transport's.
 */
export function createTestMailer(): TestMailer {
  const sent: MailMessage[] = []
  let failures = 0
  let failWith: Error | null = null

  function accept(message: MailMessage): void {
    if (failures > 0) {
      failures--
      throw failWith ?? new Error('createTestMailer: send failed (failNext)')
    }
    assertMessageAddresses(message)
    for (const [name, value] of Object.entries(message.headers ?? {})) {
      assertHeaderName(name)
      assertHeaderValue(value, name)
    }
    sent.push(message)
  }

  return {
    get sent() { return sent },
    get last() { return sent[sent.length - 1] },

    to(address) {
      return sent.filter(m => recipients(m).includes(address))
    },

    failNext(error, n = 1) {
      failWith = error ?? null
      failures = n
    },

    reset() {
      sent.length = 0
    },

    async send(message) {
      accept(message)
      return { id: `test-${sent.length}`, message: 'accepted by createTestMailer' }
    },

    async batch(messages) {
      // Each message is accepted or refused on its own, the way a real batch
      // reports per-message results rather than failing whole.
      const out: SendResult[] = []
      for (const m of messages) {
        accept(m)
        out.push({ id: `test-${sent.length}`, message: 'accepted by createTestMailer' })
      }
      return out
    },
  }
}
