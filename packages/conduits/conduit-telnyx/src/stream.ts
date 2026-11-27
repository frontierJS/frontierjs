// src/stream.ts — Telnyx's media stream, as frames.
//
// `streaming_start` makes Telnyx DIAL a WebSocket at the `stream_url` the
// app names, and push the call's audio down it as JSON text frames, base64
// audio inside. With `stream_bidirectional_mode: 'rtp'` the app pushes audio
// back the same way and Telnyx plays it into the call.
//
//   Telnyx → app   connected · start · media · dtmf · mark · stop · error
//   app → Telnyx   media · mark · clear
//
// The shapes are Telnyx's documented examples (docs/voice/programmable-voice/
// media-streaming). Assumed, not proven against a carrier: that a bidirectional
// `media` payload is raw PCMU rather than whole RTP packets, that a `mark`
// cleared by `clear` is never echoed, and that `stream_auth_token` is unused
// because the stream URL is the credential.

/** 8 kHz G.711 μ-law, one byte a sample: 8 bytes a millisecond. */
export const BYTES_PER_MS = 8
/** Telnyx's frame, and the sink's. */
export const FRAME_MS = 20

export type StreamFrame =
  | { event: 'connected'; version?: string }
  | { event: 'start'; stream_id: string; start: { call_control_id: string; call_session_id?: string; from?: string; to?: string; client_state?: string; media_format?: { encoding: string; sample_rate: number; channels: number } } }
  | { event: 'media'; stream_id: string; media: { track?: 'inbound' | 'outbound'; chunk?: string; timestamp?: string; payload: string } }
  | { event: 'dtmf'; stream_id: string; dtmf: { digit: string } }
  | { event: 'mark'; stream_id: string; mark: { name: string } }
  | { event: 'stop'; stream_id: string; stop?: { call_control_id?: string } }
  | { event: 'error'; stream_id?: string; payload: { code: number; title: string; detail?: string } }

const EVENTS = new Set(['connected', 'start', 'media', 'dtmf', 'mark', 'stop', 'error'])

/** A frame from Telnyx, or null for anything that is not one. */
export function parseFrame(raw: string | Buffer | ArrayBuffer): StreamFrame | null {
  try {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')
    const f = JSON.parse(text)
    return f && typeof f.event === 'string' && EVENTS.has(f.event) ? f as StreamFrame : null
  } catch {
    return null
  }
}

// ─── What the app sends ───────────────────────────────────────────────────

export const mediaFrame = (audio: Uint8Array) =>
  JSON.stringify({ event: 'media', media: { payload: Buffer.from(audio).toString('base64') } })
export const markFrame  = (name: string) => JSON.stringify({ event: 'mark', mark: { name } })
export const clearFrame = () => JSON.stringify({ event: 'clear' })

// ─── G.711 μ-law ──────────────────────────────────────────────────────────

const BIAS = 0x84
const CLIP = 32635

export function muLawEncode(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0
  let s = Math.min(CLIP, Math.abs(sample)) + BIAS
  let exponent = 7
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--
  const mantissa = (s >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}

export function muLawDecode(byte: number): number {
  const u = ~byte & 0xff
  const t = (((u & 0x0f) << 3) + BIAS) << ((u & 0x70) >> 4)
  return u & 0x80 ? BIAS - t : t - BIAS
}

/** Mean absolute amplitude of a μ-law payload: the stand-in agent's ear. */
export function level(audio: Uint8Array): number {
  if (!audio.length) return 0
  let sum = 0
  for (const b of audio) sum += Math.abs(muLawDecode(b))
  return sum / audio.length
}

/** `ms` of a sine at `hz`: the stand-in's voice, and the sink's caller. */
export function toneAudio(ms: number, hz: number, amplitude = 8000): Uint8Array {
  const n = ms * BYTES_PER_MS
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = muLawEncode(Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / 8000)))
  return out
}

/** `ms` of digital silence (μ-law 0xFF is zero). */
export const silence = (ms: number) => new Uint8Array(ms * BYTES_PER_MS).fill(0xff)
