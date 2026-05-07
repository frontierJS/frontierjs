import type { ChannelError } from './types.ts'

/**
 * Thrown when via() returns a channel but the corresponding toChannel()
 * method is not implemented on the notification class.
 *
 * e.g. via() returns 'email' but toEmail() is missing.
 */
export class NotificationChannelNotImplementedError extends Error {
  readonly channel:          string
  readonly notificationType: string

  constructor(channel: string, notificationType: string) {
    super(
      `Notification "${notificationType}" declares channel "${channel}" in via() ` +
      `but does not implement to${capitalise(channel)}().`
    )
    this.name              = 'NotificationChannelNotImplementedError'
    this.channel           = channel
    this.notificationType  = notificationType
  }
}

/**
 * Thrown when via() returns a channel name that has no registered driver
 * and is not a built-in channel.
 *
 * Checked eagerly before any channel execution — fail fast on the full
 * notify() call rather than discovering mid-allSettled.
 */
export class NotificationDriverNotFoundError extends Error {
  readonly channel:          string
  readonly notificationType: string

  constructor(channel: string, notificationType: string) {
    super(
      `Notification "${notificationType}" declared channel "${channel}" in via() ` +
      `but no driver is registered for that channel.`
    )
    this.name             = 'NotificationDriverNotFoundError'
    this.channel          = channel
    this.notificationType = notificationType
  }
}

/**
 * Thrown after Promise.allSettled when one or more channels failed to deliver.
 * Per-channel errors are preserved — a failed channel does not affect others.
 */
export class NotificationDeliveryError extends Error {
  readonly failures:         ChannelError[]
  readonly notificationType: string

  constructor(notificationType: string, failures: ChannelError[]) {
    const summary = failures
      .map(f => `  ${f.channel}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
      .join('\n')

    super(
      `Notification "${notificationType}" failed on ${failures.length} channel(s):\n${summary}`
    )
    this.name             = 'NotificationDeliveryError'
    this.notificationType = notificationType
    this.failures         = failures
  }
}

// ─── Internal helper ──────────────────────────────────────────────────────────

function capitalise(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}
