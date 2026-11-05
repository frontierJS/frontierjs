// src/errors.ts -- conduit's error -> the app's.
//
// Conduit grades by status, and for a push the status is the wrong axis: a
// 400 `BadDeviceToken` and a 400 `TopicDisallowed` are the same `client_error`
// where one says *delete the row* and the other *fix the build*. APNs puts the
// answer in the body as `{ reason }` and conduit keeps the body on `error.raw`.
// One owner: nothing else in the package reads `raw` or `meta.status`.

import type { ConduitError } from '@frontierjs/conduit'
import type { ApnsErrorBody } from './types.ts'

export type ApnsFailureKind =
  | 'unregistered'   // the device is gone: delete the token row, never retry
  | 'refused'        // our request was wrong (topic, payload shape, argument)
  | 'too_large'      // Apple measured the payload over its limit
  | 'forbidden'      // the credential is fine and this topic is not ours
  | 'remint'         // the provider token was refused: forget it and send again
  | ConduitError['kind']

export interface ApnsFailure {
  kind:          ApnsFailureKind
  message:       string
  retryable:     boolean
  /** Apple's own word: `BadDeviceToken`, `Unregistered`. */
  code?:         string
  /** `Unregistered` only: when the device last had the token, ms since epoch. */
  timestamp?:    number
  retryAfterMs?: number
  indeterminate?: boolean
}

const parse = <T>(raw: unknown): T | null => {
  try { return typeof raw === 'string' ? JSON.parse(raw) : (raw as T) } catch { return null }
}

const REASONS: Record<string, ApnsFailureKind> = {
  BadDeviceToken:         'unregistered',
  Unregistered:           'unregistered',
  DeviceTokenNotForTopic: 'unregistered',
  ExpiredProviderToken:   'remint',
  InvalidProviderToken:   'remint',
  MissingProviderToken:   'remint',
  PayloadTooLarge:        'too_large',
  TopicDisallowed:        'refused',
  BadTopic:               'refused',
  MissingTopic:           'refused',
  PayloadEmpty:           'refused',
  BadMessageId:           'refused',
  BadExpirationDate:      'refused',
  BadPriority:            'refused',
  InvalidPushType:        'refused',
  BadCollapseId:          'refused',
  Forbidden:              'forbidden',
}

export function translate(error: ConduitError): ApnsFailure {
  const base: ApnsFailure = {
    kind:      error.kind,
    message:   error.message,
    retryable: error.retryable,
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(error.indeterminate ? { indeterminate: true } : {}),
  }
  const body = parse<ApnsErrorBody>(error.raw)
  if (!body?.reason) return base
  const kind = REASONS[body.reason] ?? (error.kind === 'client_error' ? 'refused' : error.kind)
  return {
    ...base,
    kind,
    code:      body.reason,
    message:   `APNs: ${body.reason}`,
    // A vendor word changed the kind, and no word above is worth a second try as-is.
    retryable: kind === error.kind ? error.retryable : false,
    ...(body.timestamp !== undefined ? { timestamp: body.timestamp } : {}),
  }
}
