// src/mime.ts — the RFC 2822 message a send carries. Pure; nothing here is
// Google's, which is why it is one file and not a line in every caller.
//
// The two rules a hand-rolled builder gets wrong, kept here by name:
//   1. Headers are ASCII by spec. A subject with an accent or a display name
//      with one is an RFC 2047 encoded word (`=?UTF-8?B?…?=`); raw UTF-8 bytes
//      in a header are a malformed message, and the sink refuses them.
//   2. Bodies go as base64 with an explicit Content-Transfer-Encoding. Without
//      it the default is 7bit, which breaks a non-ASCII body, and raw HTML
//      routinely passes the 998-character SMTP line limit.
//
// A CR or LF in a header value is header injection and is REFUSED, never
// stripped: a `to` that smuggles a `Bcc:` is a request to refuse, not to
// tidy (CONTRACT C9). A reply whose Subject is not the parent's is refused
// for the same reason: Gmail threads on `threadId` plus matching Subject, so
// a changed subject forks the conversation at Gmail with no error.
//
// Attachments are out: that is multipart/mixed on top of this.

import { randomBytes, randomUUID } from 'node:crypto'

/** Google no longer prints the limit on the send reference; this is the conservative floor. */
export const MAX_RAW_BYTES = 25 * 1024 * 1024

export interface MimeInput {
  from:           string
  fromName?:      string
  to:             string
  cc?:            string
  subject:        string
  html?:          string
  text?:          string
  /** `<uuid@domain>`, minted BEFORE the send so a lost answer can be resolved by it. */
  messageId:      string
  /** The parent's own Message-Id. Replies only. */
  inReplyTo?:     string
  /** The parent's References chain plus its Message-Id. */
  references?:    string
  /** The parent's Subject; the reply's must match it modulo `Re:` or the thread forks. */
  parentSubject?: string
  /** Extra headers — an app's tracking header. Values are sanitized like every other. */
  headers?:       Record<string, string>
  date?:          Date
}

export class MimeRefusal extends TypeError {
  constructor(message: string) { super(`gmail: ${message}`); this.name = 'MimeRefusal' }
}

// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x20-\x7e]/

/** A header value with a line break is an injection; refused by the header's name. */
export function assertHeaderValue(name: string, value: string): string {
  const v = String(value ?? '')
  if (/[\r\n]/.test(v)) throw new MimeRefusal(`header '${name}' contains a line break — refused as header injection`)
  return v.trim()
}

/**
 * RFC 2047 encoded-word. ASCII passes untouched. Non-ASCII becomes
 * `=?UTF-8?B?…?=` words of at most 75 characters, chunked by code point so a
 * surrogate pair is never split, folded with CRLF + space.
 */
export function encodeHeaderValue(value: string): string {
  if (!NON_ASCII.test(value)) return value
  // 75 − "=?UTF-8?B?" (10) − "?=" (2) = 63 base64 characters ≈ 47 bytes; 45 is a multiple of 3, so no inner padding.
  const MAX_BYTES = 45
  const words: string[] = []
  let chunk = '', bytes = 0
  for (const cp of value) {
    const n = Buffer.byteLength(cp)
    if (bytes + n > MAX_BYTES) { words.push(chunk); chunk = ''; bytes = 0 }
    chunk += cp; bytes += n
  }
  if (chunk) words.push(chunk)
  return words.map(w => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ')
}

/** `"Name" <a@b>`; the display name is encoded when it needs it, the address never is. */
export function formatAddress(name: string | undefined, address: string): string {
  const addr = assertHeaderValue('From', address)
  if (!name) return addr
  const clean = assertHeaderValue('From', name)
  const display = NON_ASCII.test(clean) ? encodeHeaderValue(clean) : `"${clean.replace(/"/g, '\\"')}"`
  return `${display} <${addr}>`
}

/** base64 wrapped at 76 columns (RFC 2045). */
export function encodeBody(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
}

const stripRe = (s: string) => s.replace(/^(\s*(re|aw|sv|antw)\s*:\s*)+/i, '').trim().toLowerCase()

/** Gmail's threading rule: `Re:` is ignored, anything else is a new thread. */
export function subjectsThread(parent: string, reply: string): boolean {
  return stripRe(parent) === stripRe(reply)
}

export function mintMessageId(domain: string): string {
  if (!domain || /[\s<>@]/.test(domain)) throw new MimeRefusal(`'${domain}' is not a domain for a Message-ID`)
  return `<${randomUUID()}@${domain}>`
}

/** Case-insensitive lookup over a case-preserved header map. */
export function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase()
  for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return headers[k]
  return undefined
}

/**
 * The threading contract, from the parent's headers as ingestion stored them:
 * In-Reply-To is the parent's OWN Message-Id (not its In-Reply-To, which is
 * the grandparent) and References is the parent's chain plus its Message-Id.
 * `parentSubject` rides along so `buildMime` can refuse a fork.
 */
export function replyHeaders(parent: { headers: Record<string, string> }): { inReplyTo: string; references: string; parentSubject?: string } {
  const messageId = headerOf(parent.headers, 'message-id')
  if (!messageId) throw new MimeRefusal('the parent has no Message-Id; a reply cannot thread to it')
  const chain   = headerOf(parent.headers, 'references')
  const subject = headerOf(parent.headers, 'subject')
  return {
    inReplyTo:  messageId,
    references: [chain, messageId].filter(Boolean).join(' '),
    ...(subject !== undefined ? { parentSubject: subject } : {}),
  }
}

export function buildMime(input: MimeInput): string {
  const to = assertHeaderValue('To', input.to)
  if (!to.includes('@')) throw new MimeRefusal(`'${to}' is not an address`)
  const subject   = assertHeaderValue('Subject', input.subject ?? '')
  const messageId = assertHeaderValue('Message-ID', input.messageId)
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId)) throw new MimeRefusal(`'${messageId}' is not a Message-ID; mintMessageId() makes one`)
  if (input.inReplyTo && input.parentSubject !== undefined && !subjectsThread(input.parentSubject, subject))
    throw new MimeRefusal(`a reply's Subject must match the parent's ('${input.parentSubject}'); '${subject}' forks the thread at Gmail`)

  const headers: string[] = []
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (/[^\x21-\x39\x3b-\x7e]/.test(name)) throw new MimeRefusal(`'${name}' is not a header name`)
    headers.push(`${name}: ${encodeHeaderValue(assertHeaderValue(name, value))}`)
  }
  headers.push(`From: ${formatAddress(input.fromName, input.from)}`)
  headers.push(`To: ${to}`)
  if (input.cc) headers.push(`Cc: ${assertHeaderValue('Cc', input.cc)}`)
  headers.push(`Subject: ${encodeHeaderValue(subject)}`)
  headers.push(`Message-ID: ${messageId}`)
  headers.push(`Date: ${(input.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`)
  if (input.inReplyTo) {
    const inReplyTo = assertHeaderValue('In-Reply-To', input.inReplyTo)
    headers.push(`In-Reply-To: ${inReplyTo}`)
    headers.push(`References: ${assertHeaderValue('References', input.references || inReplyTo)}`)
  }
  headers.push('MIME-Version: 1.0')

  let body: string
  if (input.html && input.text) {
    const boundary = `b_${randomBytes(12).toString('hex')}`
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    body = [
      `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodeBody(input.text),
      `--${boundary}`, 'Content-Type: text/html; charset=UTF-8',  'Content-Transfer-Encoding: base64', '', encodeBody(input.html),
      `--${boundary}--`,
    ].join('\r\n')
  } else if (input.html) {
    headers.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64')
    body = encodeBody(input.html)
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64')
    body = encodeBody(input.text ?? '')
  }
  return [...headers, '', body].join('\r\n')
}

/** Gmail's `raw` is base64url of the message. */
export function toRaw(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url')
}

/** The Message-ID a built message carries, read back off its headers. */
export function messageIdOf(mime: string): string | undefined {
  const head = mime.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ')
  const m = /^Message-ID:\s*(<[^>]+>)/im.exec(head)
  return m?.[1]
}
