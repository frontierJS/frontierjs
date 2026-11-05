// src/parse.ts — a Gmail Message resource → what the app keeps. Pure.
//
// Headers come back as `[{ name, value }]` with whatever casing the sender
// used; the map keeps that casing because the send path reads `Message-Id`
// and `References` back off it, and `headerOf()` is the case-folded lookup.
// The body is text/html when the message has one and text/plain otherwise,
// walked through every multipart/* container; bytes behind `attachmentId`
// are never fetched here — an attachment is its name, type and size.
// `internalDate` wins over the Date header: the header is the sender's clock.

import type { GmailMessage, GmailPart, ParsedAttachment, ParsedMessage } from './types.ts'
import { headerOf } from './mime.ts'

export function flattenParts(payload: GmailPart | undefined): GmailPart[] {
  const out: GmailPart[] = []
  const walk = (p: GmailPart | undefined) => { if (!p) return; out.push(p); for (const c of p.parts ?? []) walk(c) }
  walk(payload)
  return out
}

export function decodeBody(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

export function bodyOf(payload: GmailPart | undefined): { body: string; kind: 'html' | 'text' | 'none' } {
  const parts = flattenParts(payload)
  const html  = parts.find(p => p.mimeType === 'text/html'  && p.body?.data)
  if (html) return { body: decodeBody(html.body!.data!), kind: 'html' }
  const text  = parts.find(p => p.mimeType === 'text/plain' && p.body?.data)
  if (text) return { body: decodeBody(text.body!.data!), kind: 'text' }
  return { body: '', kind: 'none' }
}

export function attachmentsOf(payload: GmailPart | undefined): ParsedAttachment[] {
  return flattenParts(payload)
    .filter(p => p.filename && p.body?.attachmentId)
    .map(p => ({
      filename:     p.filename!,
      mimeType:     p.mimeType,
      size:         p.body?.size ?? null,
      attachmentId: p.body!.attachmentId!,
      inline:       (p.headers ?? []).some(h => h.name.toLowerCase() === 'content-id'),
    }))
}

/** `'Name <a@b.com>, c@d.com'` → `['a@b.com', 'c@d.com']`, lowercased. */
export function addressesOf(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map(part => { const m = /<([^>]+)>/.exec(part); return (m ? m[1] : part).trim().toLowerCase() })
    .filter(a => a.includes('@'))
}

export function parseMessage(m: GmailMessage): ParsedMessage {
  const headers: Record<string, string> = {}
  for (const h of m.payload?.headers ?? []) headers[h.name] = h.value
  const { body, kind } = bodyOf(m.payload)
  const internal = Number(m.internalDate)
  const dateHeader = Date.parse(headerOf(headers, 'date') ?? '')
  return {
    externalId:  m.id,
    threadId:    m.threadId,
    labelIds:    m.labelIds ?? [],
    headers,
    from:        headerOf(headers, 'from'),
    to:          headerOf(headers, 'to'),
    cc:          headerOf(headers, 'cc'),
    replyTo:     headerOf(headers, 'reply-to'),
    subject:     headerOf(headers, 'subject'),
    snippet:     m.snippet ?? '',
    body,
    bodyKind:    kind,
    attachments: attachmentsOf(m.payload),
    sentAt:      Number.isFinite(internal) && internal > 0 ? internal : Number.isFinite(dateHeader) ? dateHeader : 0,
  }
}
