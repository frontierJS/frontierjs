// src/subscriptions.ts — Graph change notifications on a mailbox.
//
// A subscription lives at most 4230 minutes (just under three days) and is
// renewed by PATCH; one that lapsed answers 404 and is created again. Graph
// validates the notification URL at create: a POST carrying
// `?validationToken=…` that the endpoint must echo, 200, text/plain, within
// ten seconds (`handshake` in receive.ts). Every notification carries the
// subscription's `clientState`, which is the only thing proving it is
// Graph's: a secret per subscription, minted here, compared constant-time in
// the dialect.
//
// `ensureSubscription` keeps one alive: it stores a fresh clientState BEFORE
// the create, because a notification can arrive before the create's answer
// does, and a receiver that has not been told the secret refuses it.

import { randomBytes } from 'node:crypto'
import type { ConduitResult } from '@frontierjs/conduit'
import { translate } from './errors.ts'
import { type Answer, type MicrosoftSend } from './index.ts'
import type { Subscription } from './types.ts'

const translateOf = (r: ConduitResult<unknown>) => translate(r.error!, r.meta.status)

export const MAX_SUBSCRIPTION_MINUTES = 4230
export const SUBSCRIPTION_RESOURCE    = 'me/messages'
export const SUBSCRIPTION_CHANGES     = 'created,updated,deleted'

export const newClientState = () => randomBytes(24).toString('base64url')

export const expirationFor = (minutes = MAX_SUBSCRIPTION_MINUTES, now = Date.now()) =>
  new Date(now + Math.min(minutes, MAX_SUBSCRIPTION_MINUTES) * 60_000).toISOString()

export interface SubscriptionInput {
  notificationUrl:           string
  lifecycleNotificationUrl?: string
  clientState:               string
  minutes?:                  number
  resource?:                 string
  changeType?:               string
}

export function createSubscription(ms: MicrosoftSend, input: SubscriptionInput): Promise<Answer<'subscription', Subscription>> {
  const body = {
    changeType:          input.changeType ?? SUBSCRIPTION_CHANGES,
    notificationUrl:     input.notificationUrl,
    ...(input.lifecycleNotificationUrl ? { lifecycleNotificationUrl: input.lifecycleNotificationUrl } : {}),
    resource:            input.resource ?? SUBSCRIPTION_RESOURCE,
    expirationDateTime:  expirationFor(input.minutes),
    clientState:         input.clientState,
  }
  return ms.graph<Subscription>({ method: 'POST', path: '/subscriptions', body, validate: { validate: d => d && typeof d === 'object' && 'id' in d ? { ok: true, value: d as Subscription } : { ok: false, errors: ['no id'] } } })
    .then(r => r.error ? { error: translateOf(r) } : { subscription: r.data })
}

export function renewSubscription(ms: MicrosoftSend, id: string, minutes?: number): Promise<Answer<'subscription', Subscription>> {
  return ms.graph<Subscription>({ method: 'PATCH', path: `/subscriptions/${encodeURIComponent(id)}`, body: { expirationDateTime: expirationFor(minutes) } })
    .then(r => r.error ? { error: translateOf(r) } : { subscription: r.data })
}

export function deleteSubscription(ms: MicrosoftSend, id: string): Promise<Answer<'deleted', true>> {
  return ms.graph<null>({ method: 'DELETE', path: `/subscriptions/${encodeURIComponent(id)}` })
    .then(r => r.error ? { error: translateOf(r) } : { deleted: true })
}

export function listSubscriptions(ms: MicrosoftSend): Promise<Answer<'subscriptions', Subscription[]>> {
  return ms.graph<{ value?: Subscription[] }>({ method: 'GET', path: '/subscriptions' })
    .then(r => r.error ? { error: translateOf(r) } : { subscriptions: r.data?.value ?? [] })
}

/** What the app holds about its one subscription per mailbox. */
export interface SubscriptionStore {
  current(): Promise<{ id: string; clientState: string } | null> | { id: string; clientState: string } | null
  /** Called BEFORE a create with the state the new subscription will carry, and after with its id. */
  save(record: { id: string | null; clientState: string; expiresAt: string | null }): Promise<void> | void
}

export type Ensured =
  | { action: 'renewed';  subscription: Subscription }
  | { action: 'created';  subscription: Subscription; replaced: string | null }

/** Renew what exists; create what does not or what Graph says is gone. */
export async function ensureSubscription(ms: MicrosoftSend, store: SubscriptionStore, input: Omit<SubscriptionInput, 'clientState'>): Promise<Answer<'ensured', Ensured>> {
  const held = await store.current()
  if (held) {
    const r = await renewSubscription(ms, held.id, input.minutes)
    if (!r.error) {
      await store.save({ id: held.id, clientState: held.clientState, expiresAt: r.subscription!.expirationDateTime })
      return { ensured: { action: 'renewed', subscription: r.subscription! } }
    }
    if (r.error.kind !== 'gone') return { error: r.error }
  }
  const clientState = newClientState()
  await store.save({ id: null, clientState, expiresAt: null })
  const c = await createSubscription(ms, { ...input, clientState })
  if (c.error) return { error: c.error }
  await store.save({ id: c.subscription!.id, clientState, expiresAt: c.subscription!.expirationDateTime })
  return { ensured: { action: 'created', subscription: c.subscription!, replaced: held?.id ?? null } }
}
