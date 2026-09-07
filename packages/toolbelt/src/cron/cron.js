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
//
// Four fields are AND'd and day-of-month is not — `cronMatches` carries the
// rule. The asymmetry is cron's own and it reads as a bug, so it is the thing
// here most likely to be simplified back out.

const DAY_NAMES = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

export const CRON_FIELDS = [
  { key: 'minutes', name: 'minute',       min: 0, max: 59 },
  { key: 'hours',   name: 'hour',         min: 0, max: 23 },
  { key: 'date',    name: 'day of month', min: 1, max: 31 },
  { key: 'month',   name: 'month',        min: 1, max: 12, names: MONTH_NAMES },
  // `accepts` is wider than the canonical set: Sunday is 0 AND 7 in every cron
  // there is, so 7 is admitted and folded back. Reading it as a literal 7 made
  // one spelling of one day work — `sun` normalizes to 0 — and the other match
  // no day at all; replacing the digit before parsing instead turns `5-7` into
  // the backwards range `5-0`, so the fold has to happen to the VALUES.
  { key: 'day',     name: 'day of week',  min: 0, max: 6, accepts: 7, fold: (v) => v % 7, names: DAY_NAMES },
]

// The longest each month can be. February is 29 rather than 28 because a
// schedule on the 29th is legitimate and fires in a leap year.
const MONTH_LENGTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function bad(line, why) {
  throw new Error(`Invalid cron expression: "${line}" — ${why}`)
}

/**
 * A name in THIS field's own table — never the line's.
 *
 * Resolving names over the whole expression is how `0 0 * sat *` came to mean
 * June: six of the seven day names sit inside 1-12, so a name written in the
 * wrong field landed as a number rather than as an error. A table per field
 * also makes month names work, which every crontab admits and this refused.
 *
 * Any prefix of two letters or more that names exactly one entry. Two is enough
 * for every day and for no month, so `ju` is refused naming what it could be
 * while `jun` resolves — the ambiguity is checked rather than assumed.
 */
function nameToNumber(text, def) {
  if (!def.names || !/^[a-z]{2,}$/.test(text)) return null
  const hits = def.names.filter((n) => n.startsWith(text))
  if (hits.length === 1) return def.names.indexOf(hits[0]) + def.min
  if (hits.length > 1) return { ambiguous: hits }
  return null
}

function parseField(item, def, line) {
  const out = new Set()

  // Steps are digits and nothing else: `*/mon` is not a period.
  const num = (text, what, term) => {
    if (text === '')        bad(line, `${def.name} ${what} is missing in "${term}"`)
    if (!/^\d+$/.test(text)) bad(line, `${def.name} ${what} is not a number: "${text}"`)
    return Number(text)
  }

  // The positions a name may stand in — a whole value, or either end of a range.
  const value = (text, what, term) => {
    if (text === '') bad(line, `${def.name} ${what} is missing in "${term}"`)
    if (/^\d+$/.test(text)) return Number(text)
    const named = nameToNumber(text, def)
    if (typeof named === 'number') return named
    if (named && named.ambiguous)
      bad(line, `${def.name} ${what} "${text}" could be ${named.ambiguous.join(' or ')}`)
    bad(line, def.names
      ? `${def.name} ${what} is not a number or a ${def.name} name: "${text}"`
      : `${def.name} ${what} is not a number: "${text}"`)
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
      from = inRange(value(a, 'range start', term), 'range start')
      to   = inRange(value(b, 'range end',   term), 'range end')
      if (from > to) bad(line, `${def.name} range "${spec}" runs backwards`)
    } else {
      from = inRange(value(spec, 'value', term), 'value')
      to   = stepText === undefined ? from : top
    }

    for (let v = from; v <= to; v += step) out.add(def.fold ? def.fold(v) : v)
  }

  return out
}

/**
 * Was this field written as a star?
 *
 * The test is the TEXT and not the set, because that is the test cron makes: a
 * field is unrestricted when its FIRST CHARACTER is a star, so a bare star and
 * a step written over one both count and `0-6` does not — even though `0-6`
 * names every day there is. Reading completeness instead looks tidier and
 * diverges on exactly one line, `0 0 1 * 0-6`, which fires daily under cron and
 * on the 1st under the tidier rule, with nothing said either way. A silent
 * difference from the ecosystem's shape is what the familiarity adjudication
 * rules out.
 */
function isStar(fields, key) {
  return fields.stars.has(key)
}

/**
 * Is there any day this can ever land on?
 *
 * `0 9 31 2 *` parses cleanly — every field is in range — and matches no minute
 * that will ever exist. That is the same silence as an out-of-range field and
 * it is decidable here rather than by walking a calendar: a schedule can fire
 * only if some admitted month is long enough for some admitted date.
 *
 * Only asked where day-of-week is a star. Where it is not, the two date fields
 * are OR'd (see `cronMatches`) and the weekday alone can carry the schedule, so
 * `0 9 31 2 mon` fires on the Mondays in February and is not impossible at all.
 */
function refuseImpossibleDate(fields, line) {
  if (!isStar(fields, 'day')) return
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
  // Case is not a token here, so the whole line folds down. Names are resolved
  // per FIELD, inside `parseField`, and never over the line.
  const normalized = String(line).toLowerCase()

  const items = normalized.split(/\s|\t/).filter(Boolean)
  if (items.length !== 5)
    bad(line, `expected 5 fields (minute hour date month day), got ${items.length}`)

  const fields = { stars: new Set() }
  for (let i = 0; i < CRON_FIELDS.length; i++) {
    const def = CRON_FIELDS[i]
    fields[def.key] = parseField(items[i], def, line)
    // The first character, which is cron's own test — see `isStar`.
    if (items[i].startsWith('*')) fields.stars.add(def.key)
  }

  refuseImpossibleDate(fields, line)
  return fields
}

/**
 * Does this clock reading match?
 *
 * `parts` is `{ minutes, hours, date, month, day }` with month 1-12 and day
 * 0-6 — the caller reads them off whatever clock it is asking about, which is
 * the half that is not the grammar's business. A part that is missing is
 * REFUSED rather than answered: `{ minute: 0 }` for `{ minutes: 0 }` matched
 * nothing, for ever, which is the silence this kit exists to end.
 *
 * DAY OF MONTH AND DAY OF WEEK ARE OR'D when both are restricted, and AND'd
 * with the other three. That is cron's rule, not a convenience: `0 0 1 * mon`
 * means the first of the month AND every Monday, so a line copied out of a
 * crontab schedules here what it scheduled there. Under a uniform AND it fired
 * only when the 1st happened to BE a Monday — about one month in seven, which
 * is a schedule that runs and looks alive.
 *
 * Where either is a star the OR would be true of everything, so the answer is
 * the AND — which is the same answer the star's own full set would have given.
 * Restricted means *not written as a star*, cron's test rather than a tidier
 * one about the SET: `0-6` names every day and is still restricted, so
 * `0 0 1 * 0-6` fires daily. See `isStar`.
 */
export function cronMatches(fields, parts) {
  // `fields` comes from `parseCron` and from nowhere else — Sets do not survive
  // JSON, so anything that round-tripped is already not one. Named here because
  // reading `.stars` off it otherwise throws about a property nobody typed.
  if (!fields || !(fields.stars instanceof Set))
    throw new Error('cronMatches: fields must come from parseCron')

  for (const def of CRON_FIELDS) {
    if (!parts || !Object.hasOwn(parts, def.key) || !Number.isInteger(parts[def.key]))
      throw new Error(
        `cronMatches: parts.${def.key} must be a whole number — ` +
        `expected { ${CRON_FIELDS.map((f) => f.key).join(', ')} }, ` +
        `month 1-12 and day 0-6`
      )
  }

  for (const def of CRON_FIELDS) {
    if (def.key === 'date' || def.key === 'day') continue
    if (!fields[def.key].has(parts[def.key])) return false
  }

  const dateOk = fields.date.has(parts.date)
  const dayOk  = fields.day.has(parts.day)

  return isStar(fields, 'date') || isStar(fields, 'day')
    ? dateOk && dayOk
    : dateOk || dayOk
}
