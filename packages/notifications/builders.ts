import type { InAppAction, InAppMessage, MailLine, MailMessage } from './types.ts'

// ─── InApp builder ────────────────────────────────────────────────────────────

class InAppBuilder {
  private _title?:       string
  private _body?:        string
  private _action?:      InAppAction
  private _contextType?: string
  private _contextId?:   number | string | null
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
   * Sets contextType + contextId on the DB record.
   * Lets the UI group notifications: "3 unread in Order #1042".
   *
   * Loose reference by design — survives record deletion without cascades.
   */
  context(type: string, id: number | string | null): this {
    this._contextType = type
    this._contextId   = id
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
      contextType: this._contextType,
      contextId:   this._contextId ?? null,
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
  private _to?:     string
  private _html?:   string
  private _text?:   string

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
   */
  to(address: string): this {
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

// ─── Re-export build types alongside builders ─────────────────────────────────

export type { InAppMessage, MailMessage } from './types.ts'
