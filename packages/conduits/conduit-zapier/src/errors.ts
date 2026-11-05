// C3 — the one reader of `error.raw` and `meta.status`. Zapier grades a hook
// post by STATUS and documents no body: 200 is taken, 404 is a Zap turned off
// or deleted, 410 is a REST Hook unsubscribed, 429 is the account's rate
// limit. A body is read only for a word to put in the message.

import type { ConduitError, ResponseValidator } from '@frontierjs/conduit'
import type { HookReceipt } from './types.ts'

export type ZapierFailureKind =
  | 'off'      // 404: the Zap is turned off or deleted. Zapier answers 200 for hours after the switch, so this is late and final
  | 'gone'     // 410: the REST Hook was unsubscribed; the app's subscription row is dead
  | 'refused'  // any other 4xx: Zapier read the request and said no
  | ConduitError['kind']

export interface ZapierFailure {
  kind:           ZapierFailureKind
  message:        string
  retryable:      boolean
  /** The post left and Zapier may have run the Zap; no read says (C6). */
  indeterminate?: boolean
  retryAfterMs?:  number
}

const wordOf = (raw: unknown): string | undefined => {
  if (raw == null) return undefined
  if (typeof raw === 'string') { const t = raw.trim(); return t ? t.slice(0, 120) : undefined }
  if (typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const w = o.error ?? o.message ?? o.detail ?? o.status
  return typeof w === 'string' ? w : undefined
}

/**
 * C4 — what a hook answers under a 200: nothing (silent mode) or
 * `{ status: 'success', … }`. A body naming another status is refused so it
 * lands as `invalid_response` rather than a success holding a wrong receipt.
 */
export const hookEnvelope: ResponseValidator<Omit<HookReceipt, 'status'>> = {
  validate(data) {
    if (data === null || data === undefined || data === '') return { ok: true, value: { silent: true } }
    if (typeof data !== 'object' || Array.isArray(data)) return { ok: false, errors: [`not a hook receipt: ${typeof data}`] }
    const o = data as Record<string, unknown>
    if (o.status !== undefined && o.status !== 'success') return { ok: false, errors: [`status ${String(o.status)}`] }
    return { ok: true, value: {
      silent: false,
      ...(typeof o.attempt === 'string'    ? { attempt: o.attempt }      : {}),
      ...(typeof o.id === 'string'         ? { id: o.id }                : {}),
      ...(typeof o.request_id === 'string' ? { requestId: o.request_id } : {}),
    } }
  },
}

export function translate(error: ConduitError, status?: number): ZapierFailure {
  const word = wordOf(error.raw)
  const base: ZapierFailure = {
    kind: error.kind, message: word ? `Zapier: ${word}` : error.message, retryable: error.retryable,
    ...(error.indeterminate ? { indeterminate: true } : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
  }
  if (status === 404) return { ...base, kind: 'off', retryable: false }
  if (status === 410) return { ...base, kind: 'gone', retryable: false }
  if (error.kind === 'client_error') return { ...base, kind: 'refused', retryable: false }
  return base
}
