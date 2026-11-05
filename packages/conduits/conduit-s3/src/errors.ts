// src/errors.ts — an S3 error is XML with a `<Code>`, and the status alone is
// not enough: a 403 is a wrong key (`SignatureDoesNotMatch`), a right key the
// policy refuses (`AccessDenied`), or a clock fifteen minutes out
// (`RequestTimeTooSkewed`), and only the first is a credential conduit should
// forget.

import type { ConduitError } from '@frontierjs/conduit'

export type S3FailureKind = 'missing' | 'forbidden' | 'clock_skew' | 'etag_mismatch' | 'refused' | ConduitError['kind']

export interface S3Failure { kind: S3FailureKind; code?: string; message: string; retryable: boolean; retryAfterMs?: number }

export function errorCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  return raw.match(/<Code>([^<]+)<\/Code>/)?.[1]
}

export function translate(error: ConduitError): S3Failure {
  const code = errorCode(error.raw)
  const base: S3Failure = { kind: error.kind, message: error.message, retryable: error.retryable,
    ...(code ? { code } : {}), ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  switch (code) {
    case 'NoSuchKey': case 'NoSuchBucket': return { ...base, kind: 'missing', retryable: false }
    case 'AccessDenied':                   return { ...base, kind: 'forbidden', retryable: false }
    case 'RequestTimeTooSkewed':           return { ...base, kind: 'clock_skew', retryable: false }
    case 'PreconditionFailed':             return { ...base, kind: 'etag_mismatch', retryable: false }
    case 'InvalidArgument': case 'MalformedXML': case 'EntityTooLarge': return { ...base, kind: 'refused', retryable: false }
    default: return base
  }
}
