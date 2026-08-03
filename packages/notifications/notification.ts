import type { Channel, InAppMessage, MailMessage, SmsMessage, User } from './types.ts'

/**
 * Abstract base class for all notification types.
 *
 * Subclass this and implement:
 *   - via()         — which channels to deliver on for this user
 *   - toInApp()     — if 'inApp' is returned by via()
 *   - toEmail()     — if 'email' is returned by via()
 *   - toSms()       — if 'sms' is returned by via()
 *   - toChannel()   — for any custom driver channel names
 *
 * Usage:
 *   await app.notify(user, new PaymentReceived(payment))
 *
 * @example
 * export class PaymentReceived extends Notification {
 *   static type = 'PaymentReceived'   // stable — survives class renames
 *
 *   constructor(private payment: Payment) { super() }
 *
 *   via(user: User): Channel[] {
 *     return user.notificationPreferences ?? ['inApp', 'email']
 *   }
 *
 *   toInApp(user: User): InAppMessage {
 *     return inApp()
 *       .title('Payment received')
 *       .body(`$${this.payment.amount} has been received.`)
 *       .action('View order', `/orders/${this.payment.orderId}`)
 *       .context('Order', this.payment.orderId)
 *       .data({ amount: this.payment.amount, orderId: this.payment.orderId })
 *       .build()
 *   }
 *
 *   toEmail(user: User): MailMessage {
 *     return mail()
 *       .subject('Payment received')
 *       .greeting(`Hi ${user.firstName}`)
 *       .line(`$${this.payment.amount} received for order #${this.payment.orderId}.`)
 *       .action('View order', `https://app.example.com/orders/${this.payment.orderId}`)
 *       .build()
 *   }
 * }
 */
export abstract class Notification {
  /**
   * Stable type identifier written to the `notifications.type` DB column.
   *
   * Define this as a static property on each subclass. If absent, falls back
   * to the class constructor name — but that is fragile on refactor/minification.
   *
   * @example static type = 'PaymentReceived'
   */
  static type?: string

  /**
   * Returns the channels this notification should be delivered on for the
   * given user. Called once per notify() invocation.
   *
   * Return value drives which toChannel() methods are called and which
   * drivers are invoked. All returned channel names are validated eagerly
   * before any delivery begins.
   */
  abstract via(user: User): Channel[]

  // ─── Built-in channel formatters ──────────────────────────────────────────

  /**
   * Format this notification for the 'inApp' channel.
   * Required if via() returns 'inApp'.
   */
  toInApp?(user: User): InAppMessage

  /**
   * Format this notification for the 'email' channel.
   * Required if via() returns 'email'. Requires mailerPlugin to be configured.
   */
  toEmail?(user: User): MailMessage

  /**
   * Format this notification for the 'sms' channel.
   * Required if via() returns 'sms'. Requires SMS Conduit provider.
   */
  toSms?(user: User): SmsMessage

  // ─── Custom channel formatters ────────────────────────────────────────────

  /**
   * Dynamic channel formatter lookup — used by custom drivers.
   * Falls back to `this['to' + Channel]()` by convention.
   */
  getMessageFor(channel: string, user: User): unknown {
    const method = `to${channel.charAt(0).toUpperCase()}${channel.slice(1)}`
    // One `unknown` hop to reach a dynamically-named method, then a checked
    // call. The old form asserted `this` straight to a record of functions,
    // which TypeScript rejected as insufficiently overlapping (TS2352) and
    // which also dropped `this` binding.
    const fn = (this as unknown as Record<string, unknown>)[method]
    if (typeof fn === 'function') {
      return (fn as (u: User) => unknown).call(this, user)
    }
    return undefined
  }

  /**
   * Resolve the stable type string for this notification instance.
   * Prefers the static `type` property, falls back to constructor name.
   */
  get notificationType(): string {
    return (this.constructor as typeof Notification).type ?? this.constructor.name
  }
}
