import type { TransportError } from './types.ts'

/**
 * Thrown when via() returns a transport but the corresponding to*() method is
 * not implemented on the notification class.
 *
 * e.g. via() returns 'email' but toEmail() is missing.
 */
export class NotificationTransportNotImplementedError extends Error {
  readonly transport:        string
  readonly notificationType: string

  constructor(transport: string, notificationType: string) {
    super(
      `Notification "${notificationType}" declares transport "${transport}" in via() ` +
      `but does not implement to${capitalize(transport)}().`
    )
    this.name              = 'NotificationTransportNotImplementedError'
    this.transport         = transport
    this.notificationType  = notificationType
  }
}

/**
 * Thrown when via() returns a transport name that has no registered driver
 * and is not a built-in transport.
 *
 * Checked eagerly before any delivery — fail fast on the full notify() call
 * rather than discovering mid-allSettled.
 */
export class NotificationDriverNotFoundError extends Error {
  readonly transport:        string
  readonly notificationType: string

  constructor(transport: string, notificationType: string) {
    super(
      `Notification "${notificationType}" declared transport "${transport}" in via() ` +
      `but no driver is registered for that transport.`
    )
    this.name             = 'NotificationDriverNotFoundError'
    this.transport        = transport
    this.notificationType = notificationType
  }
}

/**
 * Thrown when the recipient cannot be addressed on a transport via() named —
 * an in-app notification with no `id` to key the row by, an email with neither
 * `recipient.email` nor a `.to()` override.
 *
 * Raised eagerly, like the two above, and for the same reason: the alternative
 * is a row written under an id nothing will ever query (FJS-096) or a partial
 * fan-out where one transport landed and another did not.
 */
export class NotificationRecipientError extends Error {
  readonly transport:        string
  readonly notificationType: string

  constructor(transport: string, notificationType: string, reason: string) {
    super(
      `Notification "${notificationType}" cannot be addressed on transport ` +
      `"${transport}": ${reason}`
    )
    this.name             = 'NotificationRecipientError'
    this.transport        = transport
    this.notificationType = notificationType
  }
}

/**
 * Thrown after Promise.allSettled when one or more transports failed to
 * deliver. Per-transport errors are preserved — a failed transport does not
 * affect the others.
 */
export class NotificationDeliveryError extends Error {
  readonly failures:         TransportError[]
  readonly notificationType: string

  constructor(notificationType: string, failures: TransportError[]) {
    const summary = failures
      .map(f => `  ${f.transport}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
      .join('\n')

    super(
      `Notification "${notificationType}" failed on ${failures.length} transport(s):\n${summary}`
    )
    this.name             = 'NotificationDeliveryError'
    this.notificationType = notificationType
    this.failures         = failures
  }
}

// ─── Internal helper ──────────────────────────────────────────────────────────

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}
