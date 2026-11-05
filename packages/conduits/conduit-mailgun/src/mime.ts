// src/mime.ts — raw RFC 5322 bytes to one `ReceivedMail`.
//
// The parser `FJS-D784` said the first raw-MIME vendor would bring. Mailgun's
// `mime` route hands over the whole message and nothing parsed; SES does the
// same, and a second raw-MIME connector imports `fromMime` from this package
// rather than writing one (until two askers move it). Nothing of Mailgun's is
// in here: the envelope is an argument, because it is the one fact the bytes
// do not carry.
//
// postal-mime does the decoding — encoded words, quoted-printable, base64,
// charsets, nested multiparts — and this file decides what of it is a
// `ReceivedMail`:
//   - `from` is one mailbox string as a header writes it, by
//     `@frontierjs/toolbelt/mailbox`, so junction's `assertMailbox` splits it.
//   - headers keep the sender's own spelling, EXCEPT the three an app reads
//     to thread a reply, pinned to the spelling Postmark's dialect already
//     produces (`Message-ID`, `In-Reply-To`, `References`): an app reading
//     `headers['Message-ID']` straight must get the same answer from every
//     dialect. A header that repeats (`Received`) is joined with `, `.
//   - every part that is not the body is an attachment, inline images
//     included, with `cid` for one the HTML draws — junction's
//     `MailAttachment` read back.

import PostalMime, { decodeWords } from 'postal-mime'
import { formatMailbox } from '@frontierjs/toolbelt/mailbox'
import type { MailAttachment, ReceivedMail } from './types.ts'

/** The two facts the bytes do not carry: who this delivery is for, and the MAIL FROM for a message whose headers have no From. */
export interface Envelope { recipient: string; sender?: string | null }

type Parsed  = Awaited<ReturnType<typeof PostalMime.parse>>
type Address = NonNullable<Parsed['to']>[number]

const PINNED: Record<string, string> = { 'message-id': 'Message-ID', 'in-reply-to': 'In-Reply-To', references: 'References' }

function mailboxes(list: Address[] | undefined): string[] {
  return (list ?? []).flatMap(a => a.group ? a.group.map(m => formatMailbox(m.address, m.name)) : a.address ? [formatMailbox(a.address, a.name)] : [])
}

const bytes = (c: ArrayBuffer | Uint8Array | string): Uint8Array =>
  typeof c === 'string' ? new TextEncoder().encode(c) : c instanceof Uint8Array ? c : new Uint8Array(c)

/** The message as a `ReceivedMail`, or null for bytes that are not one — no recipient, nothing to parse, no sender anywhere. */
export async function fromMime(raw: string | Uint8Array | ArrayBuffer, envelope: Envelope): Promise<ReceivedMail | null> {
  const recipient = String(envelope?.recipient ?? '').trim()
  if (!recipient || raw === null || raw === undefined) return null
  if (typeof raw === 'string' ? !raw.trim() : raw.byteLength === 0) return null
  const mail = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' })
  const fromAddress = (mail.from?.address ?? envelope.sender ?? '').trim()
  if (!fromAddress) return null

  const headers: Record<string, string> = {}
  for (const h of mail.headers) {
    const name  = PINNED[h.key] ?? h.originalKey ?? h.key
    const value = decodeWords(h.value).replace(/\s*\r?\n\s*/g, ' ').trim()
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value
  }
  const attachments: MailAttachment[] = mail.attachments.map(a => ({
    filename: a.filename || 'attachment',
    content:  bytes(a.content),
    type:     a.mimeType || 'application/octet-stream',
    ...(a.contentId ? { cid: a.contentId.replace(/^<|>$/g, '') } : {}),
  }))
  const to = mailboxes(mail.to)
  const cc = mailboxes(mail.cc)
  return {
    recipient,
    to:      to.length ? to : recipient,
    from:    formatMailbox(fromAddress, mail.from?.name),
    subject: mail.subject ?? '',
    ...(cc.length ? { cc } : {}),
    ...(mail.text !== undefined ? { text: mail.text } : {}),
    ...(mail.html !== undefined ? { html: mail.html } : {}),
    headers,
    attachments,
  }
}
