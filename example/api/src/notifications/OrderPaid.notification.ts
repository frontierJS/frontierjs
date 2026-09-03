// api/src/notifications/OrderPaid.notification.ts — the shop telling its staff.
//
// One notification, one audience. The staff want this in the app, where they
// are already working; they do not want an email per order. So `via` returns
// `inApp` and there is no `email` formatter — and if somebody adds 'email' to
// that list without writing one, `notify()` throws
// NotificationTransportNotImplementedError before anything is sent, rather
// than dropping it.
//
// The customer's copy is a different notification (OrderConfirmation), not a
// branch in this one. They are told different things, on a different transport,
// and one of them is not a User at all — which is why OrderConfirmation's
// recipient has no id and this one's does.
//
// The type written to `notifications.type` is this FILE's name, stamped by the
// loader — so it cannot drift from what the browser reads, and there is no
// `static type` restating it. Renaming this file renames the type, which for a
// persisted value means the rows already written keep the old one: state
// `type:` on the definition if that ever has to happen.

import { defineNotification, inApp } from '@frontierjs/notifications'
import { money }                     from '../domain/shop'

interface Order {
  id:        number
  reference: string
  total:     number
}

export default defineNotification<Order>({
  via: () => ['inApp'],

  inApp: (order) => inApp()
    .title('Order paid')
    .body(`${order.reference} — ${money(order.total)}`)
    .action('View order', `/orders/${order.id}/`)
    // contextType/contextId are a loose reference with no foreign key, so a
    // deleted order leaves its notifications intact rather than cascading them
    // away. The UI treats a missing target as a dead link, not an error.
    .context('Order', order.id)
    .data({ reference: order.reference, total: order.total }),
})
