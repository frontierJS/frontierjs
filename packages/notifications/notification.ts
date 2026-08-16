import type { InAppMessage, MailMessage, Recipient, SmsMessage, Transport } from './types.ts'

/**
 * Abstract base class for all notification types.
 *
 * Subclass this and implement:
 *   - via()           — which transports to deliver on for this recipient
 *   - toInApp()       — if 'inApp' is returned by via()
 *   - toEmail()       — if 'email' is returned by via()
 *   - toSms()         — if 'sms' is returned by via()
 *   - to<Transport>() — for any custom driver's transport name
 *
 * Usage:
 *   await app.notify(recipient, new PaymentReceived(payment))
 *
 * @example
 * export class PaymentReceived extends Notification {
 *   static type = 'PaymentReceived'   // stable — survives class renames
 *
 *   constructor(private payment: Payment) { super() }
 *
 *   via(user: Recipient): Transport[] {
 *     return user.notificationPreferences ?? ['inApp', 'email']
 *   }
 *
 *   toInApp(user: Recipient): InAppMessage {
 *     return inApp()
 *       .title('Payment received')
 *       .body(`$${this.payment.amount} has been received.`)
 *       .action('View order', `/orders/${this.payment.orderId}`)
 *       .context('Order', this.payment.orderId)
 *       .data({ amount: this.payment.amount, orderId: this.payment.orderId })
 *       .build()
 *   }
 *
 *   toEmail(user: Recipient): MailMessage {
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
   * Returns the transports this notification should be delivered on for the
   * given recipient. Called once per notify() invocation.
   *
   * Return value drives which to*() methods are called and which drivers are
   * invoked. Every returned transport name is validated eagerly — implemented,
   * driver present, recipient addressable — before any delivery begins.
   */
  abstract via(recipient: Recipient): Transport[]

  // ─── Built-in transport formatters ────────────────────────────────────────

  /**
   * Format this notification for the 'inApp' transport.
   * Required if via() returns 'inApp'. The recipient must carry an `id` — the
   * row is keyed by it, and one keyed by nothing can never be read (FJS-096).
   */
  toInApp?(recipient: Recipient): InAppMessage

  /**
   * Format this notification for the 'email' transport.
   * Required if via() returns 'email'. Requires mailerPlugin to be configured.
   */
  toEmail?(recipient: Recipient): MailMessage

  /**
   * Format this notification for the 'sms' transport.
   * Required if via() returns 'sms'. There is no built-in SMS driver, so this
   * transport needs one registered under the name 'sms'.
   */
  toSms?(recipient: Recipient): SmsMessage

  // ─── Custom transport formatters ──────────────────────────────────────────

  /**
   * Dynamic transport formatter lookup — used by custom drivers.
   * Falls back to `this['to' + Transport]()` by convention.
   */
  getMessageFor(transport: string, recipient: Recipient): unknown {
    const method = `to${transport.charAt(0).toUpperCase()}${transport.slice(1)}`
    // One `unknown` hop to reach a dynamically-named method, then a checked
    // call. The old form asserted `this` straight to a record of functions,
    // which TypeScript rejected as insufficiently overlapping (TS2352) and
    // which also dropped `this` binding.
    const fn = (this as unknown as Record<string, unknown>)[method]
    if (typeof fn === 'function') {
      return (fn as (r: Recipient) => unknown).call(this, recipient)
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
