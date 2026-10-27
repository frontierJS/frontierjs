// web/src/lib/sugar.js -- convenience methods on the built-in types, so a template
// writes {order.total?.toMoney()} and {user.name.initials()}. The methods are
// @frontierjs/toolbelt/sugar's and this file installs them; main.js imports it
// first. Delete a line to drop a group, or this file and its import to drop
// all of them. No framework package calls these, so removing them breaks only
// this app's own code.
//
// toMoney is CENTS, what a @money column stores: (1299).toMoney() is $12.99.
// toCurrency is DOLLARS: (12.99).toCurrency() is $12.99. Read a column with ?.
// -- a missing amount renders blank in a template, and a method called on it
// throws.

import { number, bigint, string, date, array, object, json, func } from '@frontierjs/toolbelt/sugar'
import { dt } from '@frontierjs/mesa/browser'

// A name the platform already has is refused, never replaced: a library that
// shadowed Array.prototype.flatten made the language rename its own to flat.
const SUGAR = Symbol.for('frontierjs.sugar')

function install(Type, { proto = {}, statics = {} }) {
  const label = Type.name || Type[Symbol.toStringTag]
  for (const [target, methods, at] of [[Type.prototype, proto, '.prototype.'], [Type, statics, '.']]) {
    for (const [name, value] of Object.entries(methods)) {
      if (name in target && !target[name]?.[SUGAR]) throw new Error('sugar: ' + label + at + name + ' already exists')
      value[SUGAR] = true
      Object.defineProperty(target, name, { value, writable: true, configurable: true })
    }
  }
}

install(Number,   number())
install(BigInt,   bigint())
install(String,   string({ dt }))
install(Date,     date(dt))
install(Array,    array())
install(Object,   object())
install(JSON,     json())
install(Function, func())

// ─── extras ─────────────────────────────────────────────────────────────────
// Timers, the network, and calls that change what they are given: not pure,
// so not in the kit, and this copy is the app's own.

install(Promise, { statics: {
  sleep: (seconds = 1) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),

  // Every call settles. A call superseded inside the window gets the result of
  // the one that ran, where dropping its timer left its caller awaiting forever.
  debounce(fn, delay, { leading = true } = {}) {
    let timer, waiting = false, queued = []
    return (...args) => new Promise((resolve, reject) => {
      const run = () => Promise.resolve().then(() => fn(...args))
      if (leading && !waiting) {
        waiting = true
        run().then(resolve, reject)
        timer = setTimeout(() => { waiting = false }, delay)
        return
      }
      clearTimeout(timer)
      queued.push([resolve, reject])
      timer = setTimeout(() => {
        const settle = queued
        queued = []
        waiting = false
        run().then((v) => settle.forEach(([ok]) => ok(v)), (e) => settle.forEach(([, no]) => no(e)))
      }, delay)
    })
  },
} })

install(URL, {
  proto: {
    fetch(type = 'json') { return fetch(this).then((res) => res[type]()) },
  },
  statics: {
    async exists(url) {
      try { return (await fetch(url, { method: 'HEAD' })).ok } catch { return false }
    },
  },
})

install(Array, { statics: {
  upsert(items, instance, { position = 'end' } = {}) {
    const index = items.findIndex((item) => item.id === instance.id)
    if (index !== -1) items[index] = instance
    else if (typeof position === 'number') items.splice(position, 0, instance)
    else if (position === 'start') items.unshift(instance)
    else items.push(instance)
    return items
  },
  // Reassigns the row in place so a reactive list sees it change. An id not in
  // the list is left alone; index -1 wrote a property named '-1'.
  reset(items, instance) {
    const index = items.findIndex((item) => item.id === instance.id)
    // biome-ignore lint/correctness/noSelfAssign: the self-assign is how a Mesa list learns a row changed
    if (index !== -1) items[index] = items[index]
    return items
  },
} })

install(Object, { statics: {
  // A missing step on the way is made, where the legacy copy threw on it.
  put(path, obj, value, cb) {
    const keys = path.split('.')
    let at = obj
    for (const key of keys.slice(0, -1)) at = at[key] ??= {}
    return (at[keys.at(-1)] = cb ? cb(value) : value)
  },
  delete(path, obj) {
    const keys = path.split('.')
    const at = keys.slice(0, -1).reduce((acc, key) => acc?.[key], obj)
    if (at != null) delete at[keys.at(-1)]
  },
} })
