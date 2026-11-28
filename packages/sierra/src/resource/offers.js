/**
 * offers.js — which services an app has and which methods each offers.
 *
 * `methods:` lives in api/src/services, not in the schema, so nothing the
 * browser holds said that a service leaves out patch: a scaffolded page drew
 * Save on it and the click answered 405 (`FJS-4666`), and a picker asked a
 * service that did not exist and warned on every render (`FJS-4667`). The
 * app answers `GET /_services` for this, read once per client — per app — over
 * `client.fetch`, since sierra imports nothing from junction.
 *
 * Until the answer arrives, and when it cannot be had, everything is offered:
 * the same rule as `x-gate`. This decides what the UI draws; the server still
 * refuses what it refuses.
 */

import { watchProxy } from '@frontierjs/mesa/runtime'

/** @type {WeakMap<object, { state: { services: Record<string, string[]>|null }, ready: Promise<Record<string, string[]>|null> }>} */
const _byClient = new WeakMap()

function heldFor(client) {
  if (!client || typeof client.fetch !== 'function') return null
  let held = _byClient.get(client)
  if (held) return held
  const state = watchProxy({ services: null })
  const ready = Promise.resolve()
    .then(() => client.fetch('/_services'))
    .then(res => res.json())
    .then(list => {
      if (!Array.isArray(list)) return null
      const services = Object.create(null)
      for (const s of list) if (s && typeof s.name === 'string' && Array.isArray(s.methods)) services[s.name] = [...s.methods]
      state.services = services
      return services
    })
    // An older server answers 404 here, and a page offline answers nothing:
    // neither is a reason to hide a button the server would take.
    .catch(() => null)
  held = { state, ready }
  _byClient.set(client, held)
  return held
}

const answer = (services, service, op) =>
  !services || (Object.hasOwn(services, service) && services[service].includes(op))

/**
 * Does `service` offer `op`, as far as is known right now? `true` until the
 * app has answered. Reactive: a page that read `true` re-renders when the
 * answer says otherwise.
 *
 * @param {object} client
 * @param {string} service
 * @param {string} op
 * @returns {boolean}
 */
export function offeredNow(client, service, op) {
  return answer(heldFor(client)?.state.services ?? null, service, op)
}

/**
 * The same question, once the app has answered — for work that is about to
 * send a request and can wait one.
 *
 * @param {object} client
 * @param {string} service
 * @param {string} op
 * @returns {Promise<boolean>}
 */
export async function offered(client, service, op) {
  return answer((await heldFor(client)?.ready) ?? null, service, op)
}
