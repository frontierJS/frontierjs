/*
 * sugar.js — convenience methods for the built-in types, as TABLES an app
 * installs. `(1299).toMoney()` in a template instead of an import and a call.
 *
 * Nothing here touches a prototype. Each factory answers
 * `{ proto, statics }` — the methods for `Type.prototype` and for `Type` — and
 * the app's own `web/src/lib/sugar.js` (written by `fli new`) puts them there.
 * Installing is mutating a global, and this package's standing is that it
 * does neither (`FJS-D26`), so the one impure loop lives in the app, where
 * deleting a line turns a group off.
 *
 * A method here is the kit beside it called with `this` — formatting stays
 * owned by `/units`, casing by `/inflect`, dates by `/datetime` — so a screen
 * that calls `formatMinor` and one that calls `.toMoney()` cannot drift.
 *
 * What cannot be pure is not here: timers, the network, and the statics that
 * MUTATE their argument (`Array.upsert`, `Object.put`) are app-file extras,
 * because a pure copy of a mutating call is a call that silently does nothing
 * where the legacy one wrote.
 */

import { formatMinor, formatMoney } from '../units/units.js'
import { camel, kebab, snake, pascal, humanize } from '../inflect/inflect.js'

/**
 * Number methods. Two money names, a hundredfold apart, and the name says
 * which: `toMoney` is MINOR units, what a `@money` column stores; `toCurrency`
 * is MAJOR units, what legacy frontier's `toCurrency` took, so a ported call
 * shows the same amount it did.
 *
 * `currency` is the default for both. Without one a call must name its own,
 * and one that does not THROWS — a console that prices in EUR and USD would
 * otherwise print euros as dollars (`FJS-D1512`).
 *
 * @param {{ currency?: string, locale?: string }} [opts]
 */
export function number({ currency, locale } = {}) {
  const pick = (cur) => {
    const code = cur ?? currency
    if (!code) throw new TypeError('sugar: this number has no currency. Pass one, toMoney(\'USD\'), or install number({ currency }) with a default.')
    return code
  }
  return {
    proto: {
      toMoney(cur, opts) {
        return formatMinor(this.valueOf(), pick(cur), { locale, ...opts })
      },
      toCurrency(cur, opts) {
        return formatMoney(this.valueOf(), pick(cur), { locale, ...opts })
      },
      // Shifted by the exponent rather than multiplied: 1.005 * 100 is
      // 100.49999999999999, so the multiply-then-round copy answered 1 for
      // (1.005).round(2).
      round(places = 0) {
        return shift(Math.round(shift(this.valueOf(), places)), -places)
      },
      prefix(text) {
        return text + this.valueOf()
      },
      postfix(text) {
        return this.valueOf() + text
      },
    },
    statics: {},
  }
}

const shift = (n, by) => {
  const [m, e = '0'] = String(n).split('e')
  return Number(`${m}e${Number(e) + by}`)
}

/**
 * BigInt has no JSON form, so `JSON.stringify` throws on one. The legacy copy
 * answered `Number(this)`, which silently rounds past 2^53 — a row id that
 * reached the screen as a neighbor's. Past the safe range this THROWS.
 */
export function bigint() {
  return {
    proto: {
      toJSON() {
        const n = Number(this.valueOf())
        if (!Number.isSafeInteger(n)) throw new RangeError(`sugar: ${this.valueOf()}n is past Number.MAX_SAFE_INTEGER, and a JSON number would round it`)
        return n
      },
    },
    statics: {},
  }
}

/**
 * String methods. Casing is `/inflect`'s, which keeps an initialism whole —
 * `'SKU'.pascalCase()` is `SKU` where lodash's answered `Sku`.
 *
 * `dt` is the app's `createDatetime` instance; `dateFormat` is absent without
 * one, because a date formats in a zone and this kit has none.
 *
 * @param {{ dt?: { format: Function } }} [opts]
 */
export function string({ dt } = {}) {
  const proto = {
    // The legacy `String.is`: the string when it matches, '' when not, so a
    // template writes class={status.is('active')}.
    is(other) {
      return String(this) === other ? String(this) : ''
    },
    capitalize() {
      const s = String(this)
      return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
    },
    camelCase()  { return camel(String(this)) },
    kebabCase()  { return kebab(String(this)) },
    snakeCase()  { return snake(String(this)) },
    pascalCase() { return pascal(String(this)) },
    humanCase()  { return humanize(String(this)) },
    // Split on any run of whitespace: 'Ada  Lovelace' had an empty word between
    // the two spaces. A word's first CODE POINT, so an emoji is not cut in half.
    initials() {
      return String(this).split(/\s+/).filter(Boolean).map((w) => [...w][0]).join('')
    },
    // The legacy formula, kept exactly: a color picked from a name's hash
    // would otherwise move for every ported user.
    hash() {
      return String(this).split('').reduce((h, letter) => letter.charCodeAt(0) + ((h << 5) - h), 0)
    },
  }
  if (dt) proto.dateFormat = function (pattern, opts) { return dt.format(String(this), pattern, opts) }

  return {
    proto,
    statics: {
      // YYYY-MM-DD and a real day: 2025-02-30 parses to March 2 and is refused.
      isDate(s) {
        if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
        const d = new Date(`${s}T00:00:00Z`)
        return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s)
      },
      isMediaPath(s, { type = 'image' } = {}) {
        return typeof s === 'string' && MEDIA[type] ? s.match(MEDIA[type]) : null
      },
      base64GetType(s) {
        const m = /^data:image\/([a-zA-Z0-9+_.-]+);base64,/.exec(s)
        if (!m) throw new TypeError('sugar: not a base64 image data URL')
        return m[1]
      },
    },
  }
}

const MEDIA = { image: /\.(?<type>png|svg|jpg|jpeg|gif|webp|avif)$/i }

/**
 * Date methods over the app's `createDatetime` instance — the zone, the
 * locale and the clock come from it, so `relativeToNow` is a call this kit
 * makes without reading a clock.
 *
 * @param {ReturnType<typeof import('../datetime/datetime.js').createDatetime>} dt
 */
export function date(dt) {
  if (!dt || typeof dt.format !== 'function') {
    throw new TypeError('sugar: date() needs the app\'s datetime instance — date(dt), where dt = createDatetime({ timeZone, now })')
  }
  return {
    proto: {
      format(pattern, opts)          { return dt.format(this, pattern, opts) },
      relativeTo(other, opts)        { return dt.relative(this, other, opts) },
      relativeToNow(opts)            { return dt.relativeToNow(this, opts) },
    },
    statics: {
      format:        (d, pattern, opts) => dt.format(d, pattern, opts),
      relativeTo:    (d, other, opts)   => dt.relative(d, other, opts),
      relativeToNow: (d, opts)          => dt.relativeToNow(d, opts),
    },
  }
}

/**
 * Array statics that answer a new value. `remove` filters by id;
 * `objectify` keys a list. The legacy `groupBy` is `Object.groupBy` now — the
 * platform renamed its own because libraries had taken the name.
 */
export function array() {
  return {
    proto: {},
    statics: {
      remove(items, instance) {
        const id = instance !== null && typeof instance === 'object' ? instance.id : instance
        return items.filter((item) => item.id !== id)
      },
      objectify(items, keyOf) {
        const out = {}
        for (const item of items) out[keyOf(item)] = item
        return out
      },
    },
  }
}

export function object() {
  return {
    proto: {},
    statics: {
      isEmpty: (obj) => obj == null || Object.keys(obj).length === 0,
      map:     (obj, fn) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v, k)])),
    },
  }
}

/**
 * `JSON.try` — the parsed value, or undefined where it would throw. Legacy
 * semantics kept: only an object, an array or a boolean comes back, so
 * `JSON.try('5')` is undefined and a caller's `?? {}` still fires.
 */
export function json() {
  return {
    proto: {},
    statics: {
      try(text) {
        let value
        try { value = JSON.parse(text) } catch { return undefined }
        if (typeof value === 'boolean') return value
        return value && typeof value === 'object' ? value : undefined
      },
    },
  }
}

export function func() {
  return {
    proto: {
      printToString() {
        return this.toString().replaceAll(/[\n\t]/g, '').replaceAll(/\s{2,}/g, ' ')
      },
    },
    statics: {
      noop() {},
      identity: (x) => x,
    },
  }
}
