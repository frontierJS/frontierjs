import { Notification, inApp, mail } from '@frontierjs/notifications'
import type { InAppMessage, MailMessage, User } from '@frontierjs/notifications'

interface Payment {
  id:      number
  amount:  number
  orderId: number
}

/**
 * PaymentReceived notification.
 *
 * Sent when a payment is successfully processed.
 * Delivered via inApp (all users) and email (users who opted in).
 *
 * Usage — from a service hook:
 *   after: {
 *     create: [
 *       async (ctx) => {
 *         const user = await db.asSystem().users.findUnique({ where: { id: ctx.result.data.userId } })
 *         await ctx.app.notify(user, new PaymentReceived(ctx.result.data))
 *       }
 *     ]
 *   }
 */
export class PaymentReceived extends Notification {
  // Stable type identifier — survives class renames and minification
  static type = 'PaymentReceived'

  constructor(private payment: Payment) {
    super()
  }

  via(user: User): string[] {
    // notificationPreferences is a future per-user preferences column.
    // When the preferences model is added, via() reads from it here.
    // Until then, all users receive the default channel set.
    return (user.notificationPreferences as string[] | undefined) ?? ['inApp', 'email']
  }

  toInApp(user: User): InAppMessage {
    return inApp()
      .title('Payment received')
      .body(`$${this.payment.amount} has been received.`)
      .action('View order', `/orders/${this.payment.orderId}`)
      .context('Order', this.payment.orderId)
      .data({ amount: this.payment.amount, orderId: this.payment.orderId })
      .build()
  }

  toEmail(user: User): MailMessage {
    return mail()
      .subject('Payment received')
      .greeting(`Hi ${(user.firstName as string) ?? 'there'}`)
      .line(`$${this.payment.amount} has been received for order #${this.payment.orderId}.`)
      .action('View order', `https://app.example.com/orders/${this.payment.orderId}`)
      .build()
  }
}
