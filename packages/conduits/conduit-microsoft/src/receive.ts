// src/receive.ts — the Dialect for Graph's change and lifecycle notifications
// (FJS-D899), and the one piece that cannot ride `app.conduit.receive()`.
//
// ─── What proves a delivery is Graph's ────────────────────────────────────
// Nothing on the wire is signed. Graph puts the subscription's `clientState`
// — a secret we minted at create — in every notification, and that is the
// whole proof. So the credential is PER SUBSCRIPTION, a row, and the
// receiver's `credential` is a function: `subscriptionIdOf(delivery)` names
// the row, the app reads its clientState, and `verify` compares every item's
// `clientState` to it constant-time (FJS-1804 is this case).
//
// ─── The handshake is a raw route (C13) ───────────────────────────────────
// At create, Graph POSTs `?validationToken=…` and wants the token echoed as
// text/plain. Conduit's receiver answers its own `{received, outcome}` body,
// so the echo cannot go through it: the app mounts `handshake` on the
// notification path ahead of the receiver, or conduit grows a dialect hook
// for a pre-body challenge. Named in PROJECT_STATE.md.
//
// ─── Two ids ──────────────────────────────────────────────────────────────
// `resourceData.id` is the REST id even when every GET answers immutable ids;
// `resourceIdOf` reads it, and a GET by it answers the immutable one.

import { timingSafeEqual } from 'node:crypto'
import type { Delivery, Dialect, ReceivedEvent } from '@frontierjs/conduit'
import type { ChangeNotification, LifecycleNotification } from './types.ts'

/** The subscription's clientState. */
export type GraphCred = string

export interface GraphChangeEvent extends ReceivedEvent {
  type:    'change'
  payload: { subscriptionId: string; notifications: ChangeNotification[] }
}

export interface GraphLifecycleEvent extends ReceivedEvent {
  type:    'lifecycle'
  payload: { subscriptionId: string; events: LifecycleNotification[] }
}

export const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const itemsOf = <T extends ChangeNotification>(d: Delivery): T[] | null => {
  const body = d.body as { value?: unknown } | null
  if (!body || typeof body !== 'object' || !Array.isArray(body.value)) return null
  return body.value as T[]
}

/** Which row's secret verifies this delivery: the first item's subscription; a batch naming two is not one Graph sends. */
export function subscriptionIdOf(d: Delivery): string | null {
  const items = itemsOf(d)
  if (!items?.length) return null
  const id = items[0].subscriptionId
  if (!id || items.some(i => i.subscriptionId !== id)) return null
  return id
}

/** Graph's `resourceData.id`, or the tail of `resource` (`Users/{u}/Messages/{id}`). */
export const resourceIdOf = (n: ChangeNotification): string | null =>
  n.resourceData?.id ?? n.resource?.split('/').pop() ?? null

const verify = (d: Delivery, cred: GraphCred) => {
  const items = itemsOf(d)
  if (!items?.length) return { ok: false as const, reason: 'no notifications in the body' }
  if (!cred) return { ok: false as const, reason: 'no clientState held for this subscription' }
  for (const n of items) if (typeof n.clientState !== 'string' || !same(n.clientState, cred)) return { ok: false as const, reason: 'clientState does not match the subscription' }
  return { ok: true as const }
}

const stable = (parts: (string | undefined)[]) => parts.map(p => p ?? '').join('|')

/** Change notifications: created/updated/deleted on a message. One event per delivery, the app walks its items. */
export const graphChangeDialect: Dialect<GraphCred, GraphChangeEvent> = {
  verify,
  parse(d) {
    const items = itemsOf<ChangeNotification>(d)
    const id = subscriptionIdOf(d)
    if (!items || !id) return null
    const notifications = items.filter(n => !('lifecycleEvent' in n))
    if (!notifications.length) return null
    return { id: `${id}:${notifications.map(n => stable([n.changeType, resourceIdOf(n) ?? undefined])).sort().join(',')}`, type: 'change', payload: { subscriptionId: id, notifications } }
  },
  dedupeKey: (_d, ev) => ev.id,
}

/** Lifecycle notifications: reauthorizationRequired · subscriptionRemoved · missed. */
export const graphLifecycleDialect: Dialect<GraphCred, GraphLifecycleEvent> = {
  verify,
  parse(d) {
    const items = itemsOf<LifecycleNotification>(d)
    const id = subscriptionIdOf(d)
    if (!items || !id) return null
    const events = items.filter(n => typeof n.lifecycleEvent === 'string')
    if (!events.length) return null
    return { id: `${id}:${events.map(e => stable([e.lifecycleEvent, e.subscriptionExpirationDateTime])).sort().join(',')}`, type: 'lifecycle', payload: { subscriptionId: id, events } }
  },
  dedupeKey: (_d, ev) => ev.id,
}

/** Graph's validation challenge, if this request is one: answer it with this Response and do nothing else. */
export function handshake(url: string | URL): Response | null {
  const token = new URL(url).searchParams.get('validationToken')
  if (token === null) return null
  return new Response(token, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
