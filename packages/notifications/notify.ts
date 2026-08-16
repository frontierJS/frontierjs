import type { App, InAppMessage, MailMessage, Recipient, TransportError } from './types.ts'
import type { Notification } from './notification.ts'
import { stateOf, type NotificationsState } from './state.ts'
import {
  NotificationDeliveryError,
  NotificationDriverNotFoundError,
  NotificationRecipientError,
  NotificationTransportNotImplementedError,
} from './errors.ts'
import { sendInApp }  from './drivers/inapp.ts'
import { sendEmail }  from './drivers/email.ts'

// ─── Built-in transports ─────────────────────────────────────────────────────
//
// Transports this package implements natively. 'sms' is deliberately NOT here:
// there is no built-in SMS implementation, so declaring it built-in let
// validation pass and then failed at delivery with a bare Error. Treating it
// as a normal transport means it needs a registered driver, and a missing one
// is caught eagerly as NotificationDriverNotFoundError like any other.
const BUILT_IN_TRANSPORTS = new Set(['inApp', 'email'])

// ─── Message materialisation ─────────────────────────────────────────────────
//
// inApp() and mail() return chainable BUILDERS whose values live in private
// fields; build() turns one into the plain message the drivers read. The
// drivers never called it, so they read the chainable METHODS instead:
//
//   spread of `message.data`  (a function) → {}          → empty payload
//   `message.title`           (a function) → truthy      → a function in the JSON
//   `message.lines`           (no such method) → undefined → `?? []` → EMPTY EMAIL
//   `message.to`              (a function) → truthy      → the "no recipient"
//                                                          guard never fired
//
// so such a notification delivered an in-app row with an empty payload and an
// email with no subject and no body — and reported success.
//
// Scope, precisely: README.md and examples/ DO call .build(), and that path
// always worked. The JSDoc @example blocks in this package omitted it (now
// fixed), and TypeScript rejects the omission — InAppBuilder is not an
// InAppMessage. So the silent-empty case reached JavaScript consumers and
// anyone following editor hover text, not typed code that compiles.
//
// builders.ts already documented build() as "called internally by the driver".
// It wasn't. This is that call, in one place, so the failure mode is a working
// delivery rather than a silent empty one. Already-built messages have no
// build() method and pass through untouched.
function materialise(message: unknown): unknown {
  if (message && typeof (message as { build?: unknown }).build === 'function') {
    return (message as { build(): unknown }).build()
  }
  return message
}

// ─── notify() — package-internal, not exported ───────────────────────────────

/**
 * Core delivery function. Called by app.notify() which closes over `app`
 * so the public signature stays clean: app.notify(recipient, notification).
 *
 * Execution:
 *   1. Call notification.via(recipient) to get the transport list
 *   2. Format each transport's message ONCE, and validate eagerly — throw
 *      before any delivery if:
 *      - a transport has no to*() method (NotificationTransportNotImplementedError)
 *      - a transport has no registered driver (NotificationDriverNotFoundError)
 *      - the recipient cannot be addressed on it (NotificationRecipientError)
 *   3. Execute all transports in parallel via Promise.allSettled
 *      — transport isolation: a failed email does not block inApp delivery
 *   4. Collect failures, throw NotificationDeliveryError if any failed
 *
 * The formatted message is carried from step 2 into step 3. It used to be
 * built twice — once to check the method existed, once to deliver — so a
 * formatter that rendered a template or counted anything did it twice per
 * send, and the message that was validated was never the one delivered.
 */
export async function notify(
  recipient:    Recipient,
  notification: Notification,
  app:          App
): Promise<void> {
  const state            = stateOf(app)
  const transports       = notification.via(recipient)
  const notificationType = notification.notificationType

  // ── Step 1: format once, validate eagerly — fail before any delivery ─────
  const messages = new Map<string, unknown>()
  for (const transport of transports) {
    const message = materialise(notification.getMessageFor(transport, recipient))
    if (message === undefined) {
      throw new NotificationTransportNotImplementedError(transport, notificationType)
    }

    if (!BUILT_IN_TRANSPORTS.has(transport) && !state.drivers.has(transport)) {
      throw new NotificationDriverNotFoundError(transport, notificationType)
    }

    assertAddressable(transport, recipient, message, notificationType, state)
    messages.set(transport, message)
  }

  // ── Step 2: parallel delivery ─────────────────────────────────────────────
  const results = await Promise.allSettled(
    transports.map(transport =>
      deliverTransport(transport, recipient, notification, messages.get(transport), app, state)
    )
  )

  // ── Step 3: collect failures ──────────────────────────────────────────────
  const failures: TransportError[] = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.status === 'rejected') {
      failures.push({ transport: transports[i], error: result.reason })
    }
  }

  if (failures.length > 0) {
    // Log each failed transport with full detail before throwing
    for (const failure of failures) {
      console.error(
        `[notifications] transport "${failure.transport}" failed for ` +
        `${notificationType} → recipient ${recipient.id ?? recipient.email ?? '(unaddressed)'}:`,
        failure.error
      )
    }
    throw new NotificationDeliveryError(notificationType, failures)
  }
}

// ─── Addressability ──────────────────────────────────────────────────────────
//
// FJS-096: a Recipient is not a User, and the two built-in transports need
// different things from one. `inApp` writes a row keyed by `userId` — with no
// id there is no row anybody can read, and inventing one (`customer:42`) makes
// a row that is silently invisible forever. `email` needs an address, from the
// message or from the recipient.
//
// A registered driver owns its own answer: only it knows what it addresses by.
function assertAddressable(
  transport:        string,
  recipient:        Recipient,
  message:          unknown,
  notificationType: string,
  state:            NotificationsState,
): void {
  if (state.drivers.has(transport)) return

  if (transport === 'inApp' && recipient.id == null) {
    // A SessionContext is the near-miss: `ctx.user` carries `userId`, so
    // handing it straight to notify() reads as an id-less recipient. Naming the
    // shape is the difference between a one-line fix and a hunt.
    const hint = recipient.userId != null
      ? ' It carries `userId`, so this looks like a SessionContext — pass ' +
        '`{ id: session.userId, email: session.email }`.'
      : ''

    throw new NotificationRecipientError(
      transport, notificationType,
      'the recipient has no id, so the notification row would be keyed by nothing ' +
      'and no signed-in caller could ever read it. An in-app notification is ' +
      'addressed to an account; a bare email address is an email transport only.' + hint
    )
  }

  if (transport === 'email') {
    const to = (message as MailMessage | undefined)?.to ?? recipient.email
    if (!to) {
      throw new NotificationRecipientError(
        transport, notificationType,
        'recipient.email is missing and no .to() override was set on the mail() builder.'
      )
    }
  }
}

// ─── Per-transport delivery dispatch ─────────────────────────────────────────

async function deliverTransport(
  transport:    string,
  recipient:    Recipient,
  notification: Notification,
  message:      unknown,
  app:          App,
  state:        NotificationsState,
): Promise<void> {
  // A registered driver always wins, including for a built-in transport name.
  // Previously the switch ran first, so a custom `inApp` driver was accepted by
  // the plugin, stored in the registry, and then never consulted — the built-in
  // wrote its row and the override was silently ignored. Explicit configuration
  // should not lose to a default.
  const driver = state.drivers.get(transport)
  if (driver) {
    await driver.send(recipient, message, app)
    return
  }

  switch (transport) {
    case 'inApp':
      await sendInApp(recipient, notification, message as InAppMessage, app, state.db)
      break

    case 'email':
      await sendEmail(recipient, message as MailMessage, app)
      break

    default:
      // Unreachable: notify() validates that every non-built-in transport has a
      // registered driver before any delivery starts.
      throw new NotificationDriverNotFoundError(transport, notification.notificationType)
  }
}
