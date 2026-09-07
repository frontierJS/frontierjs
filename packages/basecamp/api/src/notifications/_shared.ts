// src/notifications/_shared.ts — what every notification here has in common.
//
// The loader globs `*.notification.ts` and stamps each file's name as the
// persisted type, so this is skipped by its extension. The underscore is for a
// reader: it says the file is not one of the seven.
//
// ─── Why every one of them implements BOTH transports ────────────────────
//
// A person may turn email ON for a kind whose default is in-app only —
// `kinds.ts` holds defaults, not a ceiling — and `notify()` throws
// `NotificationTransportNotImplementedError` for a requested transport with no
// formatter, BEFORE delivering anything. So a missing email formatter does not
// mean *no email*, it means that person gets neither. Both, always.

import type { Recipient } from '@frontierjs/notifications'

/** Every definition's `via`. The answer was resolved per person by
 *  `core/notify.ts` against `NotificationPreference` and stamped on the
 *  recipient — a `via` cannot read a row, and a preference is per PERSON, so
 *  two recipients of one send legitimately differ. */
export const declaredTransports = (_: unknown, r: Recipient): string[] =>
  (r.transports as string[] | undefined) ?? ['inApp']

/** The console's own base URL, for a link in an email. An in-app action is a
 *  path because the reader is already in the app; an email is read somewhere
 *  else and a bare path is a dead link. */
export function appUrl(path: string): string {
  const base = process.env.APP_URL ?? 'http://localhost:8020'
  return `${base.replace(/\/+$/, '')}${path}`
}
