// src/blocks.ts — the four Block Kit blocks a notification needs.
//
// Slack refuses the whole message for one wrong block (`invalid_blocks`), and
// the refusal names an index, not the mistake. A header must be `plain_text`
// and no longer than 150; a context block holds ten elements; a message holds
// fifty blocks. Built here so the refusal is a sentence before the send (C9).

import type { Block, TextObject } from './types.ts'

export const MAX_BLOCKS         = 50
export const MAX_HEADER_CHARS   = 150
export const MAX_CONTEXT_ITEMS  = 10
export const MAX_SECTION_CHARS  = 3000

export const mrkdwn = (text: string): TextObject => ({ type: 'mrkdwn', text })
export const plain  = (text: string, emoji = true): TextObject => ({ type: 'plain_text', text, emoji })

export function section(text: string | TextObject): Block {
  const t = typeof text === 'string' ? mrkdwn(text) : text
  if (t.text.length > MAX_SECTION_CHARS) throw new TypeError(`slack: a section holds ${MAX_SECTION_CHARS} characters, got ${t.text.length}`)
  return { type: 'section', text: t }
}

export function header(text: string): Block {
  if (text.length > MAX_HEADER_CHARS) throw new TypeError(`slack: a header holds ${MAX_HEADER_CHARS} characters, got ${text.length}`)
  return { type: 'header', text: { type: 'plain_text', text, emoji: true } }
}

export const divider = (): Block => ({ type: 'divider' })

export function context(...items: (string | TextObject)[]): Block {
  if (!items.length || items.length > MAX_CONTEXT_ITEMS) throw new TypeError(`slack: a context block holds 1 to ${MAX_CONTEXT_ITEMS} elements, got ${items.length}`)
  return { type: 'context', elements: items.map(i => typeof i === 'string' ? mrkdwn(i) : i) }
}

export function assertBlocks(blocks: Block[] | undefined): void {
  if (blocks === undefined) return
  if (!Array.isArray(blocks)) throw new TypeError('slack: blocks must be an array')
  if (blocks.length > MAX_BLOCKS) throw new TypeError(`slack: a message holds ${MAX_BLOCKS} blocks, got ${blocks.length}`)
}
