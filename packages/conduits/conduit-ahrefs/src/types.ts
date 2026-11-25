// src/types.ts — what Ahrefs answers and what this package answers back.

/** Every error body Ahrefs sends is one of two shapes: `{ error }` (400, 403 units, 5xx) or a bare array (`["Error","Unauthorized"]`, 401 and the keyless 403). */
export type AhrefsErrorBody = { error?: string } | string[]

/** What a call cost, read off the five `x-api-*` headers. A header Ahrefs did not send is `null`, never 0: an unknown cost is not a free call. */
export interface Cost {
  rows:   number | null
  perRow: number | null
  /** What the call would cost. A free test target reports 50 here and 0 in `actual`. */
  total:  number | null
  /** What was charged. */
  actual: number | null
  cache:  'hit' | 'miss' | 'no_cache' | null
}

/** A call's answer and what it cost. For a call made of several requests, the cost is the last one's: every call here is free. */
export interface Answered<T> { value: T; cost: Cost }

export interface Project {
  id:        string
  name:      string
  /** As Ahrefs stores it, trailing slash and all. Match on `bare()`, never on this. */
  url:       string
  mode:      string
  protocol:  string
  access:    string
}

export interface SiteAudit {
  healthScore: number
  /** When the last crawl finished, ISO. */
  date:        string
  status:      string
  errors:      number
  warnings:    number
  notices:     number
  total:       number
}

export interface UnitsBalance { limit: number | null; used: number; left: number | null }
export interface Limits {
  plan:      string
  /** The key's own expiry, ISO. A key past it is a 401. */
  expiresAt: string | null
  resetsAt:  string | null
  key:       UnitsBalance
  workspace: UnitsBalance
}
