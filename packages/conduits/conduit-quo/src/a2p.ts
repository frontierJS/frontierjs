// src/a2p.ts — the workspace's A2P (10DLC) registration: get, create, update, submit.
//
// A plain answer, not a mirror row (owner, 2026-10-22): no event reports the
// registration, so a row would be only as fresh as the last read, and its
// business info carries the tax ID, which an app's mirror would then hold.
// An app that shows the status reads it, as it reads a webhook.
//
// A workspace has at most one, so no call takes an id. Quo's autofill writes
// the `messaging` half from the business info and `messageTypes`, which no
// read gives back; a submit before autofill is done is a 409.

import type { ConduitResult } from '@frontierjs/conduit'
import { translate, type QuoFailure } from './errors.ts'
import type { QuoSend } from './index.ts'
import {
  QUO_A2P_BUSINESS_TYPES, QUO_A2P_COMPANY_TYPES, QUO_A2P_INDUSTRIES, QUO_A2P_REGIONS, QUO_A2P_ID_TYPES, QUO_A2P_EXCHANGES,
  QUO_A2P_JOB_POSITIONS, QUO_A2P_MESSAGE_TYPES, type QuoA2PChanges, type QuoA2PDraft, type QuoA2PRegistration,
} from './types.ts'

const A2P_PATH = '/a2p-registration'
const failed = (r: ConduitResult<unknown>): QuoFailure => translate(r.error!, r.meta?.status)

type Check = (v: unknown) => string | null
const text: Check = v => typeof v === 'string' && v.length >= 1 && v.length <= 255 ? null : 'a string of 1–255 characters'
const orNull = (c: Check): Check => v => v === null ? null : c(v)
const oneOf = (list: readonly string[]): Check => v => list.includes(v as string) ? null : `one of ${list.join(', ')}`
const whole: Check = v => Number.isInteger(v) ? null : 'an integer'
const listOf = (list: readonly string[], max = Infinity): Check => v =>
  Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(x => list.includes(x)) ? null : `a list of ${max === Infinity ? '1 or more' : `1–${max}`} of ${list.join(', ')}`
const uri: Check = v => text(v) ?? (URL.canParse(v as string) ? null : 'a URL')
const email: Check = v => text(v) ?? (/^[^@\s]+@[^@\s]+$/.test(v as string) ? null : 'an email address')
const e164: Check = v => typeof v === 'string' && /^\+[1-9]\d{1,14}$/.test(v) ? null : 'an E.164 number'

const TOP: Record<string, Check> = {
  name: text, alternateName: orNull(text), businessType: oneOf(QUO_A2P_BUSINESS_TYPES), companyType: oneOf(QUO_A2P_COMPANY_TYPES),
  industry: oneOf(QUO_A2P_INDUSTRIES), employeeCount: whole, avgDailyCallVolume: whole, regionsOfOperation: listOf(QUO_A2P_REGIONS, 5),
  websiteUrl: uri, idType: oneOf(QUO_A2P_ID_TYPES), idNumber: text, ticker: orNull(text), exchange: orNull(oneOf(QUO_A2P_EXCHANGES)),
  messageTypes: listOf(QUO_A2P_MESSAGE_TYPES),
}
const NESTED: Record<string, Record<string, Check>> = {
  address: { line1: text, line2: orNull(text), city: text, region: text, postalCode: text, country: text },
  personOfContact: { firstName: text, lastName: text, jobTitle: text, jobPosition: oneOf(QUO_A2P_JOB_POSITIONS), email, phoneNumber: e164 },
}
/** A patch naming one of these restarts autofill, and autofill needs `messageTypes`. */
const AUTOFILLS = ['name', 'alternateName', 'businessType', 'websiteUrl']
const AUTOFILLS_CONTACT = ['firstName', 'lastName']

const refuse = (why: string): never => { throw new TypeError(`quo: ${why}`) }

/**
 * The body Quo is sent, every field checked against the spec's schema. A
 * create names every field; a patch names any, one level down as well. A key
 * the registration does not have is refused, since Quo would drop it unread.
 * The rules Quo states only in prose (an EIN's nine digits, a ticker for a
 * `Public` company) are Quo's 422 to answer.
 */
function a2pBody(input: Record<string, unknown>, create: boolean): Record<string, unknown> {
  if (!input || typeof input !== 'object') refuse('a registration is an object')
  const fields = (given: Record<string, unknown>, table: Record<string, Check>, where: string) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(given)) {
      if (v === undefined) continue
      if (!(k in table)) refuse(`'${where}${k}' is not a field of the A2P registration`)
      const bad = table[k]!(v)
      if (bad) refuse(`${where}${k} is ${bad}`)
      out[k] = v
    }
    if (create) for (const k of Object.keys(table)) if (!(k in out)) refuse(`a registration names ${where}${k}`)
    return out
  }
  const { address, personOfContact, ...top } = input
  const body = fields(top, TOP, '')
  for (const [k, v] of Object.entries({ address, personOfContact })) {
    if (v === undefined && !create) continue
    if (!v || typeof v !== 'object' || Array.isArray(v)) refuse(`${k} is an object`)
    const part = fields(v as Record<string, unknown>, NESTED[k]!, `${k}.`)
    if (!Object.keys(part).length) refuse(`${k} names at least one field`)
    body[k] = part
  }
  if (!Object.keys(body).length) refuse('an A2P update names at least one field')
  const contact = body.personOfContact as Record<string, unknown> | undefined
  const autofills = AUTOFILLS.some(k => k in body) || AUTOFILLS_CONTACT.some(k => contact && k in contact)
  if (autofills && !('messageTypes' in body)) refuse('a write naming the business name, type, website or contact name starts autofill, which needs messageTypes')
  return body
}

const when = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Quo's registration with its times as `Date`; null for anything not an `RG…`. */
export function a2pRegistration(raw: unknown): QuoA2PRegistration | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !/^RG./.test(r.id)) return null
  return { ...r, firstSubmittedAt: when(r.firstSubmittedAt), createdAt: when(r.createdAt), updatedAt: when(r.updatedAt) } as QuoA2PRegistration
}

/**
 * The registration, or `null` when the workspace has none: Quo answers that
 * 404 rather than a null `data`, and it is no failure. Idempotent; conduit replays it.
 */
export async function getA2PRegistration(quo: QuoSend): Promise<{ registration?: QuoA2PRegistration | null; error?: QuoFailure }> {
  const r = await quo.dated<{ data: unknown }>({ method: 'GET', path: A2P_PATH })
  if (r.error) return r.meta?.status === 404 ? { registration: null } : { error: failed(r) }
  return { registration: a2pRegistration(r.data?.data) ?? undefined }
}

/**
 * The draft, every field named; it starts autofill. Not replayed: a workspace
 * has one registration, so the replay of a create that landed is Quo's 409.
 * After `indeterminate`, `getA2PRegistration` says whether it landed. A
 * lapsed subscription is a 402, `billing`.
 */
export async function createA2PRegistration(quo: QuoSend, draft: QuoA2PDraft): Promise<{ registration?: QuoA2PRegistration; error?: QuoFailure }> {
  const body = a2pBody(draft as unknown as Record<string, unknown>, true)
  const r = await quo.dated<{ data: unknown }>({ method: 'POST', path: A2P_PATH, body })
  if (r.error) return { error: failed(r) }
  return { registration: a2pRegistration(r.data?.data) ?? undefined }
}

/**
 * Only the fields named change, `address` and `personOfContact` one level
 * down as well; `null` clears where the spec allows it. A draft alone takes
 * a patch: a submitted one is Quo's 409, `refused`. Replayed, since it sets
 * values, though a replay naming the business name restarts autofill.
 */
export async function updateA2PRegistration(quo: QuoSend, changes: QuoA2PChanges): Promise<{ registration?: QuoA2PRegistration; error?: QuoFailure }> {
  const body = a2pBody(changes as Record<string, unknown>, false)
  const r = await quo.dated<{ data: unknown }>({ method: 'PATCH', path: A2P_PATH, body, replayable: true })
  if (r.error) return { error: failed(r) }
  return { registration: a2pRegistration(r.data?.data) ?? undefined }
}

/**
 * Sends the draft to the carriers, and Quo charges for it: a payment that does
 * not complete is a 402, `billing`. The acknowledgement is the caller's to
 * make, so it is an argument rather than a constant here.
 *
 * Not replayed, since a submit bills. A 409 is read rather than believed: a
 * registration already submitted and `pending` or `approved` is the submit
 * done, which is what a retry after `indeterminate` finds; one still a draft
 * is autofill running, `refused` and retryable shortly. A `rejected` or
 * `failed` one is resubmitted by this call, and bills again.
 */
export async function submitA2PRegistration(quo: QuoSend, req: { forbiddenMessageTopicsAcknowledged: true }): Promise<{ registration?: QuoA2PRegistration; error?: QuoFailure }> {
  if (req?.forbiddenMessageTopicsAcknowledged !== true) refuse('a submit acknowledges the forbidden message topics (forbiddenMessageTopicsAcknowledged: true)')
  const r = await quo.dated<{ data: unknown }>({ method: 'POST', path: `${A2P_PATH}/submit`, body: { forbiddenMessageTopicsAcknowledged: true } })
  if (!r.error) return { registration: a2pRegistration(r.data?.data) ?? undefined }
  const error = failed(r)
  if (r.meta?.status !== 409) return { error }
  const now = await getA2PRegistration(quo)
  const reg = now.registration
  if (reg && !reg.draft && (reg.status === 'pending' || reg.status === 'approved')) return { registration: reg }
  return { error: reg?.draft ? { ...error, retryable: true } : error }
}
