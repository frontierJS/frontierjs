// src/domain/claude/claude-pricing.ts — what a Claude Code message would cost at API list prices.
//
// An ESTIMATE, and shown as one with the date it was read (`READ_ON`): Claude
// Code on a subscription is not billed per token, and a price moves. A model this
// table does not name is UNPRICED — `costOf` answers null and a screen says so —
// because a zero would read as free and understate the total. A synthetic model
// (`<synthetic>`) and an alias (`opus`) never appear here for that reason.
//
// Dollars per million tokens, from the pricing page below. Cache hits are not a
// fixed share of input: they are 0.025x on Fable 5.1, 0.05x on Opus 5.5 and
// Sonnet 5.5, and 0.1x elsewhere, so each row states its own. A cache write is
// priced by its TTL (`cacheWrite1h` is the part of `cacheWrite` written to the
// one-hour cache). A `[1m]` suffix (Claude Code's 1M-context selector) is the
// same model at the same price; Haiku 5.5 alone steps up for a prompt over
// 100,000 tokens, counted here as input plus both cache columns.

export const SOURCE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'
export const READ_ON = '2026-10-31'

export interface Price { input: number, write5m: number, write1h: number, read: number, output: number }

const p = (input: number, write5m: number, write1h: number, read: number, output: number): Price =>
  ({ input, write5m, write1h, read, output })

const OPUS_5     = p(5,  6.25,  10, 0.5,  25)
const SONNET_4_6 = p(3,  3.75,  6,  0.3,  15)

export const PRICES: Record<string, Price> = {
  'claude-fable-5-1':  p(10, 12.5, 20, 0.25, 50),
  'claude-fable-5':    p(10, 12.5, 20, 1,    50),
  'claude-opus-5-5':   p(4,  5,    8,  0.2,  20),
  'claude-opus-5':     OPUS_5,
  'claude-opus-4-8':   OPUS_5,
  'claude-opus-4-7':   OPUS_5,
  'claude-opus-4-6':   OPUS_5,
  'claude-sonnet-5-5': p(2,  2.5,  4,  0.1,  10),
  'claude-sonnet-5':   p(2,  2.5,  4,  0.2,  10),
  'claude-sonnet-4-6': SONNET_4_6,
  'claude-haiku-5-5':  p(0.1, 0.125, 0.2, 0.01, 0.5),
  'claude-haiku-4-5':  p(1,  1.25, 2,  0.1,  5),
}

/** Haiku 5.5 for a prompt over 100,000 tokens. */
export const PRICES_OVER_100K: Record<string, Price> = {
  'claude-haiku-5-5': p(0.5, 0.625, 1, 0.05, 2.5),
}

const OVER = 100_000

/** The price row for a model id as a transcript spells it, or null when none is published. */
export function priceOf(model: string, promptTokens = 0): Price | null {
  const id = model.replace(/\[1m\]$/, '').replace(/-20\d{6}$/, '')
  if (promptTokens > OVER && PRICES_OVER_100K[id]) return PRICES_OVER_100K[id]
  return PRICES[id] ?? null
}

export interface Priced {
  model:         string
  input:         number
  cacheWrite:    number
  cacheWrite1h?: number
  cacheRead:     number
  output:        number
}

/**
 * Dollars for one message, or null when its model is unpriced.
 *
 * `tiered: false` is for SUMS: a total over many messages is no prompt, so the
 * 100,000-token step cannot be read off it and the base row is used. That
 * understates Haiku 5.5's long prompts and nothing else.
 */
export function costOf(m: Priced, { tiered = true }: { tiered?: boolean } = {}): number | null {
  const price = priceOf(m.model, tiered ? m.input + m.cacheWrite + m.cacheRead : 0)
  if (!price) return null
  const w1h = Math.min(m.cacheWrite1h ?? 0, m.cacheWrite)
  return (
    m.input * price.input +
    (m.cacheWrite - w1h) * price.write5m +
    w1h * price.write1h +
    m.cacheRead * price.read +
    m.output * price.output
  ) / 1e6
}
