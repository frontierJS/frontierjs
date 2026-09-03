// define.ts — a notification without a class.
//
// `notify()` never asks what a notification IS. It reads three members and
// nothing else (`notify.ts`): `notificationType`, `via(recipient)` and
// `getMessageFor(transport, recipient)`. So the base class was never the
// boundary — it was one implementation of it, and this is a second.
//
// ─── What the class made you write that this does not ─────────────────────
//
// `extends Notification`, `super()`, a `static type` restating the file's own
// name, and — where a body has to be rendered — a `private constructor` behind
// a `static async build()`, because `toEmail()` was synchronous and compiling
// a template is not. A formatter here may be async, so that whole shape goes:
// the render happens in `email:` where it is read.
//
// ─── The type is the FILE NAME, and that is not a style choice ────────────
//
// `notificationType` is written into `notifications.type` and read by the
// browser to pick a renderer, so it is persisted data — the class derived it
// from `this.constructor.name` when `static type` was absent, which makes
// renaming a class orphan every row already written under the old name.
//
// Here it is stamped by the loader from `<Type>.notification.ts`, the same
// rule caravan applies to `<name>.job.ts`: the basename before the suffix IS
// the name, verbatim, with no case conversion to get wrong. A definition that
// is never loaded and states no `type:` throws on first send rather than
// writing rows under `undefined`.
//
// `type:` remains for the one case derivation cannot serve: a file that has to
// be renamed while the rows keep the old string.

import type {
  InAppMessage, MailMessage, Recipient, SmsMessage, Transport,
} from './types.ts'

/** Set by the loader. Not exported from the package — an app has no reason to
 *  stamp a type, and a settable `type` is one more thing that can disagree. */
export const STAMP = Symbol.for('frontierjs.notifications.stamp')

/** Anything the builders return, or the built message itself. `notify()`
 *  already unwraps a `.build()`, so both spellings work. */
type Built<M> = M | { build(): M }

/** One transport's formatter. Async is allowed and is the point: rendering a
 *  template is asynchronous and used to need a factory to hide it. */
export type Formatter<P, M> =
  (payload: P, recipient: Recipient) => Built<M> | Promise<Built<M>>

export interface NotificationDefinition<P> {
  /** Overrides the type the loader derives from the file name. State it only
   *  to keep a type stable across a rename — otherwise the file is the name. */
  type?:   string

  /** Which transports to deliver on, for THIS payload and THIS recipient.
   *  Every name returned must have a formatter below, or a registered driver;
   *  `notify()` checks that before it delivers anything. */
  via:     (payload: P, recipient: Recipient) => Transport[]

  inApp?:  Formatter<P, InAppMessage>
  email?:  Formatter<P, MailMessage>
  sms?:    Formatter<P, SmsMessage>

  /** A custom transport, named for the driver registered under it. */
  [transport: string]: unknown
}

/** What `app.notify()` takes: the three members it reads, and no more. */
export interface SendableNotification {
  readonly notificationType: string
  via(recipient: Recipient): Transport[]
  getMessageFor(transport: string, recipient: Recipient): unknown
}

export interface NotificationFactory<P> {
  (payload: P): SendableNotification

  /** The stable type string — from the file name, or from `type:`. Reading it
   *  before the loader has run, on a definition that states none, throws. */
  readonly type: string

  /** Transport names this definition can format, in declaration order. Asked
   *  with no payload, which is what a preferences screen and a devtools panel
   *  need — and the reason `via` takes the payload rather than closing over it. */
  readonly transports: Transport[]
}

// `type` and `via` are the definition's own keys; everything else that is a
// function is a transport formatter. A key that is neither is ignored rather
// than refused — a driver may want a plain config value beside its formatter.
const RESERVED = new Set(['type', 'via'])

export function defineNotification<P = void>(
  def: NotificationDefinition<P>,
): NotificationFactory<P> {

  if (typeof def.via !== 'function') {
    throw new Error(
      '[notifications] defineNotification needs a `via` — which transports to ' +
      'deliver on. It takes (payload, recipient) and returns an array: ' +
      "`via: () => ['inApp']`."
    )
  }

  const transports = Object.keys(def)
    .filter(k => !RESERVED.has(k) && typeof (def as Record<string, unknown>)[k] === 'function')

  if (transports.length === 0) {
    throw new Error(
      '[notifications] defineNotification has no transport formatter. Add one ' +
      'named for the transport it formats — `inApp`, `email`, `sms`, or the name ' +
      'a custom driver is registered under.'
    )
  }

  let derived: string | undefined

  const typeOf = (): string => {
    const t = def.type ?? derived
    if (!t) {
      throw new Error(
        '[notifications] this notification has no type, so a row written for it ' +
        'could never be read back. Put the definition in the app\'s notifications ' +
        'directory as `<Type>.notification.ts` — the file names it — or state ' +
        '`type:` on the definition.'
      )
    }
    return t
  }

  const factory = ((payload: P): SendableNotification => ({
    get notificationType() { return typeOf() },

    via: (recipient: Recipient) => def.via(payload, recipient),

    // `undefined` for a transport with no formatter is the contract `notify()`
    // is written against — it turns that into
    // NotificationTransportNotImplementedError naming the transport and the
    // type, before anything is delivered.
    getMessageFor: (transport: string, recipient: Recipient) => {
      const fn = (def as Record<string, unknown>)[transport]
      return typeof fn === 'function'
        ? (fn as Formatter<P, unknown>)(payload, recipient)
        : undefined
    },
  })) as NotificationFactory<P>

  Object.defineProperty(factory, 'type',       { get: typeOf, enumerable: true })
  Object.defineProperty(factory, 'transports', { value: Object.freeze(transports), enumerable: true })
  Object.defineProperty(factory, STAMP,        { value: (t: string) => { derived ??= t } })

  return factory
}

/** Is this a `defineNotification` factory? Asked by the loader, which must not
 *  register whatever else a module happens to export. */
export function isNotificationFactory(v: unknown): v is NotificationFactory<unknown> {
  return typeof v === 'function' && STAMP in (v as object)
}

/** The loader's half of the file-name rule. Separate so it can be tested
 *  without a directory, and so nothing else invents a second answer. */
export function stampType(factory: NotificationFactory<unknown>, type: string): void {
  ;(factory as unknown as Record<symbol, (t: string) => void>)[STAMP](type)
}
