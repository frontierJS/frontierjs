// examples/PaymentReceived.notification.ts
//
// Two transports, chosen per recipient. `via` is handed the payload AND the
// recipient, so routing can read either — and because it takes the payload
// rather than closing over one, the definition can be asked what it supports
// before anything is sent (`paymentReceived.transports`), which is what a
// preferences screen needs.
//
// Usage — from a service hook:
//
//   import paymentReceived from '../notifications/PaymentReceived.notification.ts'
//
//   after: {
//     create: [
//       async (ctx) => {
//         const user = await db.asSystem().user.findUnique({
//           where: { id: ctx.result.data.userId },
//         })
//         await ctx.app.notify(user, paymentReceived(ctx.result.data))
//       }
//     ]
//   }

import { defineNotification, inApp, mail } from '@frontierjs/notifications'

interface Payment {
  id:      number
  amount:  number
  orderId: number
}

export default defineNotification<Payment>({
  // An app that stores preferences on the user row reads them here. Absent,
  // both transports — a notification nobody has expressed a view about is
  // still worth delivering.
  via: (_payment, recipient) =>
    (recipient.notificationPreferences as string[]) ?? ['inApp', 'email'],

  inApp: (payment) => inApp()
    .title('Payment received')
    .body(`$${payment.amount} has been received.`)
    .action('View order', `/orders/${payment.orderId}`)
    .context('Order', payment.orderId)
    .data({ amount: payment.amount, orderId: payment.orderId }),

  email: (payment, user) => mail()
    .subject('Payment received')
    .greeting(`Hi ${(user.firstName as string) ?? 'there'}`)
    .line(`$${payment.amount} received for order #${payment.orderId}.`)
    .action('View order', `https://app.example.com/orders/${payment.orderId}`),
})
