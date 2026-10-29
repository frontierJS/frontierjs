import type { MailAttachment } from '@frontierjs/junction/mail'
import type { InAppAction, InAppMessage, MailLine, MailMessage, PushAction, PushMessage } from './types.ts'

// ─── InApp builder ────────────────────────────────────────────────────────────

class InAppBuilder {
  private _title?:       string
  private _body?:        string
  private _action?:      InAppAction
  private _subjectType?: string
  private _subjectId?:   number | string | null
  private _data:         Record<string, unknown> = {}

  /**
   * Short display title shown in the notification list.
   */
  title(text: string): this {
    this._title = text
    return this
  }

  /**
   * Longer description shown below the title.
   */
  body(text: string): this {
    this._body = text
    return this
  }

  /**
   * Optional call-to-action button — label and destination URL.
   */
  action(label: string, url: string): this {
    this._action = { label, url }
    return this
  }

  /**
   * Optional polymorphic context reference.
   * Sets subjectType + subjectId on the DB record.
   * Lets the UI group notifications: "3 unread in Order #1042".
   *
   * Loose reference by design — survives record deletion without cascades.
   */
  context(type: string, id: number | string | null): this {
    this._subjectType = type
    this._subjectId   = id
    return this
  }

  /**
   * Arbitrary payload merged into the `data` JSON column alongside
   * title/body/action. UI uses these fields for type-specific rendering.
   */
  data(payload: Record<string, unknown>): this {
    this._data = { ...this._data, ...payload }
    return this
  }

  /**
   * Build the final InAppMessage. Call this at the end of the chain.
   *
   * notify() also calls it for you if a builder reaches it un-built, so an
   * omitted build() degrades to working rather than to an empty payload — but
   * the declared return type of toInApp() is InAppMessage, so TypeScript will
   * (correctly) ask you for it.
   */
  build(): InAppMessage {
    return {
      title:       this._title,
      body:        this._body,
      action:      this._action,
      subjectType: this._subjectType,
      subjectId:   this._subjectId ?? null,
      data:        this._data,
    }
  }
}

/**
 * Builder entry point for in-app notifications.
 *
 * @example
 * return inApp()
 *   .title('Payment received')
 *   .body(`$${payment.amount} has been received.`)
 *   .action('View order', `/orders/${payment.orderId}`)
 *   .context('Order', payment.orderId)
 *   .data({ amount: payment.amount, orderId: payment.orderId })
 *   .build()          // ← required: build() produces the plain message
 */
export function inApp(): InAppBuilder {
  return new InAppBuilder()
}

// ─── Mail builder ─────────────────────────────────────────────────────────────

class MailBuilder {
  private _subject: string = ''
  private _lines:   MailLine[] = []
  private _to?:     string | string[]
  private _html?:   string
  private _text?:   string
  private _attachments: MailAttachment[] = []

  /**
   * Email subject line.
   */
  subject(text: string): this {
    this._subject = text
    return this
  }

  /**
   * Greeting line, e.g. "Hi Sarah".
   */
  greeting(text: string): this {
    this._lines.push({ type: 'greeting', text })
    return this
  }

  /**
   * Body paragraph line.
   */
  line(text: string): this {
    this._lines.push({ type: 'line', text })
    return this
  }

  /**
   * Call-to-action button — label and full URL.
   */
  action(label: string, url: string): this {
    this._lines.push({ type: 'action', label, url })
    return this
  }

  /**
   * Override recipient address. Defaults to user.email when omitted.
   * A list is one mail to all of them.
   */
  to(address: string | string[]): this {
    this._to = address
    return this
  }

  /**
   * A rendered HTML body — from `@frontierjs/email-kit`, or from anywhere.
   *
   * Replaces what `lines` would have produced for the HTML part only. Pair it
   * with `.text()`, or leave the text alone and the builder's lines still write
   * the plain-text alternative — which is a real use, since a table-based
   * receipt has an obvious three-line text form and no obvious HTML one.
   */
  html(markup: string): this {
    this._html = markup
    return this
  }

  /** A rendered plain-text body. Same rule as `.html()`. */
  text(body: string): this {
    this._text = body
    return this
  }

  /** Attach a file — call again for each one. Handed to the mailer as given. */
  attach(file: MailAttachment): this {
    this._attachments.push(file)
    return this
  }

  /**
   * Build the final MailMessage. Call this at the end of the chain.
   *
   * notify() also calls it for you if a builder reaches it un-built — without
   * that, an omitted build() produced an email with no subject and no body.
   */
  build(): MailMessage {
    return {
      subject: this._subject,
      lines:   this._lines,
      to:      this._to,
      ...(this._html !== undefined ? { html: this._html } : {}),
      ...(this._text !== undefined ? { text: this._text } : {}),
      ...(this._attachments.length ? { attachments: this._attachments } : {}),
    }
  }
}

/**
 * Builder entry point for email notifications.
 *
 * @example
 * return mail()
 *   .subject('Payment received')
 *   .greeting(`Hi ${user.firstName}`)
 *   .line(`$${payment.amount} received for order #${payment.orderId}.`)
 *   .action('View order', `https://app.example.com/orders/${payment.orderId}`)
 *   .build()          // ← required: build() produces the plain message
 */
export function mail(): MailBuilder {
  return new MailBuilder()
}

// ─── Push builder ─────────────────────────────────────────────────────────────

class PushBuilder {
  private _title?:    string
  private _body?:     string
  private _url?:      string
  private _data?:     Record<string, unknown>
  private _ttl?:      number
  private _urgency?:  PushMessage['urgency']
  private _topic?:    string
  private _priority?: PushMessage['priority']
  private _tags:      string[] = []
  private _actions:   PushAction[] = []

  title(text: string): this {
    this._title = text
    return this
  }

  body(text: string): this {
    this._body = text
    return this
  }

  /** Where a tap goes -- a full URL for ntfy, a path is enough for the service worker. */
  url(destination: string): this {
    this._url = destination
    return this
  }

  /** Payload the service worker reads. webPush only. */
  data(payload: Record<string, unknown>): this {
    this._data = { ...this._data, ...payload }
    return this
  }

  /** Seconds the push service holds it for an offline device. webPush only. */
  ttl(seconds: number): this {
    this._ttl = seconds
    return this
  }

  /** The push service's queueing hint. webPush only -- the phone's loudness is `priority()`. */
  urgency(level: NonNullable<PushMessage['urgency']>): this {
    this._urgency = level
    return this
  }

  /** A later message with the same topic replaces the one before it. webPush only. */
  topic(name: string): this {
    this._topic = name
    return this
  }

  /** 5 rings through do-not-disturb, 4 is a resend, 3 the default. ntfy only. */
  priority(level: NonNullable<PushMessage['priority']>): this {
    this._priority = level
    return this
  }

  /** Emoji shortcodes shown before the title -- `rotating_light`, `warning`. ntfy only. */
  tags(...names: string[]): this {
    this._tags.push(...names)
    return this
  }

  /** One `view` button -- call again for each. ntfy only. */
  action(label: string, url: string): this {
    this._actions.push({ label, url })
    return this
  }

  build(): PushMessage {
    return {
      title: this._title,
      body:  this._body,
      ...(this._url      !== undefined ? { url: this._url }           : {}),
      ...(this._data     !== undefined ? { data: this._data }         : {}),
      ...(this._ttl      !== undefined ? { ttl: this._ttl }           : {}),
      ...(this._urgency  !== undefined ? { urgency: this._urgency }   : {}),
      ...(this._topic    !== undefined ? { topic: this._topic }       : {}),
      ...(this._priority !== undefined ? { priority: this._priority } : {}),
      ...(this._tags.length            ? { tags: this._tags }         : {}),
      ...(this._actions.length         ? { actions: this._actions }   : {}),
    }
  }
}

/**
 * Builder entry point for push notifications -- one message, read by whichever
 * `push` driver the app registered.
 *
 * @example
 * return push()
 *   .title('Monitor down')
 *   .body('api.acme.test stopped answering')
 *   .priority(5)
 *   .tags('rotating_light')
 *   .url('https://hub.acme.test/monitors/7')
 *   .build()
 */
export function push(): PushBuilder {
  return new PushBuilder()
}

// ─── Re-export build types alongside builders ─────────────────────────────────

export type { InAppMessage, MailMessage, PushMessage } from './types.ts'
