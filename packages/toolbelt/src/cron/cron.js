// cron/cron.js — what a five-field cron expression MEANS.
//
// One grammar, one reading. There were two: caravan's scheduler and junction's
// `app.scheduler` each parsed cron, and they were broken differently, so the
// same expression named two different schedules depending on which timer
// happened to be holding it (`FJS-767`).
//
//   0 1-5,8 * * *      caravan: hours 1,2,3,4,5     junction: hours 1,8
//   0 1-5/2 * * *      caravan: hours 1,2,3,4,5     junction: every 2nd hour
//   0 25 * * *         both: parsed, then matched no minute, for ever
//
// Neither consulted a bound, and each took ONE operator per field — caravan the
// first character it found, junction the first branch that matched — so a
// compound term was silently truncated to whatever survived the split.
//
// This kit answers what the expression admits and nothing about time: the field
// SETS, and whether a set of clock parts is in them. WHEN a scheduler looks, and
// in which zone, stays with the scheduler — caravan reads a named zone through
// `toLocaleString` and walks a wall clock across daylight boundaries, junction's
// in-process timer reads the host clock, and neither is a fact about the
// grammar.
//
// Every value is a SET rather than an operator plus operands, which is what
// makes both defects go away at once: every term is read, and every number is
// compared to its field's bounds as it goes in.

const DAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa']

export const CRON_FIELDS = [
  { key: 'minutes', name: 'minute',       min: 0, max: 59 },
  { key: 'hours',   name: 'hour',         min: 0, max: 23 },
  { key: 'date',    name: 'day of month', min: 1, max: 31 },
  { key: 'month',   name: 'month',        min: 1, max: 12 },
  // `accepts` is wider than the canonical set: Sunday is 0 AND 7 in every cron
  // there is, so 7 is admitted and folded back. Reading it as a literal 7 made
  // one spelling of one day work — `sun` normalizes to 0 — and the other match
  // no day at all; replacing the digit before parsing instead turns `5-7` into
  // the backwards range `5-0`, so the fold has to happen to the VALUES.
  { key: 'day',     name: 'day of week',  min: 0, max: 6, accepts: 7, fold: (v) => v % 7 },
]

// The longest each month can be. February is 29 rather than 28 because a
// schedule on the 29th is legitimate and fires in a leap year.
const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function bad(line, why) {
  throw new Error(`Invalid cron expression: "${line}" — ${why}`)
}

function parseField(item, def, line) {
  const out = new Set()

  const num = (text, what, term) => {
    if (text === '')        bad(line, `${def.name} ${what} is missing in "${term}"`)
    if (!/^\d+$/.test(text)) bad(line, `${def.name} ${what} is not a number: "${text}"`)
    return Number(text)
  }
  const top = def.accepts ?? def.max
  const inRange = (v, what) => {
    if (v < def.min || v > top)
      bad(line, `${def.name} ${what} is ${v}, outside ${def.min}-${top}`)
    return v
  }

  for (const term of item.split(',')) {
    if (term === '') bad(line, `${def.name} has an empty term in "${item}"`)

    // `a/n` and `*/n` are the same shape — a range and a step over it. Vixie
    // reads a bare `a/n` as `a-max/n`, which is what makes `*/n` mean
    // `min-max/n` rather than a special case.
    const [spec, stepText, ...rest] = term.split('/')
    if (rest.length) bad(line, `${def.name} has more than one step in "${term}"`)

    let step = 1
    if (stepText !== undefined) {
      step = num(stepText, 'step', term)
      // `*/0` reached `current % 0`, which is NaN and therefore false for every
      // minute there is.
      if (step === 0) bad(line, `${def.name} has a step of 0 in "${term}"`)
    }

    let from, to
    if (spec === '*') {
      from = def.min
      to   = def.max
    } else if (spec.includes('-')) {
      const [a, b, ...more] = spec.split('-')
      if (more.length) bad(line, `${def.name} has more than one range in "${term}"`)
      from = inRange(num(a, 'range start', term), 'range start')
      to   = inRange(num(b, 'range end',   term), 'range end')
      if (from > to) bad(line, `${def.name} range "${spec}" runs backwards`)
    } else {
      from = inRange(num(spec, 'value', term), 'value')
      to   = stepText === undefined ? from : top
    }

    for (let v = from; v <= to; v += step) out.add(def.fold ? def.fold(v) : v)
  }

  return out
}

/**
 * Is there any day this can ever land on?
 *
 * `0 9 31 2 *` parses cleanly — every field is in range — and matches no minute
 * that will ever exist. That is the same silence as an out-of-range field and
 * it is decidable here rather than by walking a calendar: a schedule can fire
 * only if some admitted month is long enough for some admitted date.
 */
function refuseImpossibleDate(fields, line) {
  const dates = [...fields.date]
  for (const m of fields.month) if (dates.some(d => d <= MONTH_LENGTHS[m - 1])) return
  bad(line, `day of month ${dates.join(', ')} never occurs in month ${[...fields.month].join(', ')}`)
}

/**
 * A cron expression into the values each field admits.
 *
 * Throws on anything it cannot mean, naming the field and the bound. That is
 * the whole point: an expression nothing can match used to register, appear in
 * `registrations()` and in `jobs.snapshot.md`, and never run — `FJS-327`'s
 * silence one layer down, where the schedule is not merely unobserved but
 * unmatchable.
 */
export function parseCron(line) {
  // Named days: monday/mon/MON → numeric index. Two characters is enough to
  // separate all seven, and it is applied to the whole line because a name can
  // only be a day here.
  const normalized = String(line).toLowerCase().replace(/[a-z]+/g, (text) => {
    const idx = DAYS.indexOf(text.substring(0, 2))
    return idx >= 0 ? String(idx) : text
  })

  const items = normalized.split(/\s|\t/).filter(Boolean)
  if (items.length !== 5)
    bad(line, `expected 5 fields (minute hour date month day), got ${items.length}`)

  const fields = {}
  for (let i = 0; i < CRON_FIELDS.length; i++) {
    const def = CRON_FIELDS[i]
    fields[def.key] = parseField(items[i], def, line)
  }

  refuseImpossibleDate(fields, line)
  return fields
}

/**
 * Does this clock reading match?
 *
 * `parts` is `{ minutes, hours, date, month, day }` with month 1-12 and day
 * 0-6 — the caller reads them off whatever clock it is asking about, which is
 * the half that is not the grammar's business.
 */
export function cronMatches(fields, parts) {
  for (const { key } of CRON_FIELDS) if (!fields[key].has(parts[key])) return false
  return true
}
