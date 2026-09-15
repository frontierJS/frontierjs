/*
 * datetime-oracle.mjs — regenerates datetime-oracle.json from the Temporal polyfill.
 *
 * The polyfill is the oracle and never a dependency: this package declares none,
 * so it is installed somewhere else and resolved from the working directory.
 *
 *   cd "$(mktemp -d)" && npm i @js-temporal/polyfill@0.5.1
 *   node <repo>/packages/toolbelt/test/fixtures/datetime-oracle.mjs
 *
 * Run it under NODE. The polyfill reads zone rules from the host's ICU exactly as
 * the kit does, so oracle and kit agree by construction on one runtime; the spec
 * then runs under bun as well, which is where a zone whose rules changed shows up.
 * That is why ZONES holds no zone whose rules moved recently (`America/Asuncion`
 * disagreed between node and bun for 36 months of 2020-2030 when this was written).
 *
 * Wall clocks are sampled around every transition in the window, on both sides
 * of it in both offsets, plus an ordinary midday each month — the edges are where
 * a hand-rolled inverse goes wrong and the middles are where a broken one still
 * looks right.
 */

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { Temporal } = createRequire(join(process.cwd(), 'noop.js'))('@js-temporal/polyfill')

const ZONES = [
  'UTC',
  'America/New_York',
  'America/Denver',
  'America/St_Johns',     // -3:30 with DST
  'America/Santiago',     // transitions at midnight
  'Europe/London',
  'Europe/Dublin',        // negative DST in the rules
  'Asia/Kolkata',         // +5:30, no DST
  'Asia/Kathmandu',       // +5:45
  'Australia/Lord_Howe',  // a 30-minute DST shift
  'Pacific/Auckland',     // southern hemisphere
  'Pacific/Chatham',      // +12:45 with DST
]
const FROM = 2024
const TO   = 2027
const MODES = ['compatible', 'earlier', 'later', 'reject']
const EDGES = [-61, -60, -30, -1, 0, 1, 30, 59, 60, 61]

const pad  = (n, w = 2) => String(n).padStart(w, '0')
const wall = (dt) => `${pad(dt.year, 4)}-${pad(dt.month)}-${pad(dt.day)}T${pad(dt.hour)}:${pad(dt.minute)}`

const walls = []
const transitions = []
for (const zone of ZONES) {
  const seen = new Set()
  const add = (dt) => {
    const key = wall(dt)
    if (seen.has(key)) return
    seen.add(key)
    walls.push([zone, key])
  }
  for (let y = FROM; y <= TO; y++) for (let m = 1; m <= 12; m++) add(Temporal.PlainDateTime.from({ year: y, month: m, day: 15, hour: 12 }))

  let z = Temporal.ZonedDateTime.from({ year: FROM, month: 1, day: 1, timeZone: zone })
  for (;;) {
    const next = z.getTimeZoneTransition('next')
    if (!next || next.year > TO) break
    transitions.push([zone, next.epochMilliseconds])
    const before = next.subtract({ nanoseconds: 1 })
    for (const side of [before, next]) {
      const pdt = side.toPlainDateTime().round({ smallestUnit: 'minute', roundingMode: 'floor' })
      for (const e of EDGES) add(pdt.add({ minutes: e }))
    }
    z = next
  }
}

const resolve = walls.map(([zone, w]) => {
  const pdt = Temporal.PlainDateTime.from(w)
  const row = [zone, w]
  for (const disambiguation of MODES) {
    try {
      row.push(pdt.toZonedDateTime(zone, { disambiguation }).epochMilliseconds)
    } catch {
      row.push(null)
    }
  }
  return row
})

// partsIn: every compatible instant above, read back, plus the millisecond each
// transition happens at and the one before it.
const parts = []
const instants = [...resolve.map(([zone, , ms]) => [zone, ms]), ...transitions.flatMap(([zone, ms]) => [[zone, ms - 1], [zone, ms]])]
for (const [zone, ms] of instants) {
  const z = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone)
  parts.push([zone, ms, z.year, z.month, z.day, z.hour, z.minute, z.second, z.millisecond, z.dayOfWeek, z.offsetNanoseconds / 6e10])
}

// The ISO week year differs from the calendar year only at the ends of a year.
const weeks = []
for (let y = 1998; y <= 2032; y++) {
  for (const [m, d] of [[1, 1], [1, 2], [1, 3], [1, 4], [1, 7], [6, 15], [12, 28], [12, 29], [12, 30], [12, 31]]) {
    const p = Temporal.PlainDate.from({ year: y, month: m, day: d })
    weeks.push([`${pad(y, 4)}-${pad(m)}-${pad(d)}`, p.weekOfYear, p.yearOfWeek])
  }
}

// Plain-date arithmetic: every month end, both leap days, and a mid-month control,
// moved by each unit alone and combined. A clamp that remembers its day, or one
// that rolls into the next month, disagrees on the month ends and nowhere else.
const DATES = ['2023-01-31', '2023-02-28', '2024-01-29', '2024-01-30', '2024-01-31', '2024-02-29',
  '2024-03-31', '2024-04-30', '2024-05-31', '2024-08-31', '2024-10-31', '2024-12-31', '2025-12-31', '2026-06-15']
const DURATIONS = [{ months: 1 }, { months: -1 }, { months: 2 }, { months: 11 }, { months: 13 }, { months: -13 },
  { years: 1 }, { years: -1 }, { years: 4 }, { weeks: 2 }, { weeks: -1 }, { days: 1 }, { days: -1 }, { days: 366 },
  { years: 1, months: 1, days: 1 }, { months: -1, days: -1 }]
const added = []
for (const d of DATES) for (const duration of DURATIONS) {
  added.push([d, duration, Temporal.PlainDate.from(d).add(duration, { overflow: 'constrain' }).toString()])
}
const between = []
for (const a of DATES) for (const b of DATES) {
  between.push([a, b, Temporal.PlainDate.from(a).until(b, { largestUnit: 'day' }).days])
}

// startOfDay: the local day holding every transition, the days either side, and a
// mid-month control. Santiago moves its clocks AT midnight, which is the case
// where a day does not start at 00:00.
const days = []
for (const zone of ZONES) {
  const seen = new Set()
  const add = (date) => {
    const key = date.toString()
    if (seen.has(key)) return
    seen.add(key)
    days.push([zone, key, date.toZonedDateTime(zone).epochMilliseconds])
  }
  for (let y = FROM; y <= TO; y++) for (let m = 1; m <= 12; m++) add(Temporal.PlainDate.from({ year: y, month: m, day: 15 }))
  for (const [z, ms] of transitions) {
    if (z !== zone) continue
    const local = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDate()
    for (const shift of [-1, 0, 1]) add(local.add({ days: shift }))
  }
}

const out = {
  generator: 'node packages/toolbelt/test/fixtures/datetime-oracle.mjs, from a directory holding @js-temporal/polyfill',
  polyfill:  '@js-temporal/polyfill@0.5.1',
  icu:       process.versions.icu,
  tz:        process.versions.tz,
  modes:     MODES,
  resolve,
  parts,
  weeks,
  added,
  between,
  days,
}
const target = join(dirname(fileURLToPath(import.meta.url)), 'datetime-oracle.json')
writeFileSync(target, JSON.stringify(out) + '\n')
console.log(`${resolve.length} wall clocks, ${parts.length} instants, ${weeks.length} week dates, ${added.length} additions, ${between.length} spans, ${days.length} day starts → ${target}`)
