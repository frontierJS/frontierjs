// ─── intent.js — what a person asked, resolved against the app's own seed ─────
//
// `IDEAS/intent-recognizer.md` is the design and this is its middle: the part a
// model is never allowed to do. A person's words arrive already translated into
// a CANDIDATE — realm-free words, a kind, a claim — and this module looks them up
// in what the app commits and answers a verdict with a citation. The model at
// either end is not here; this runs the same way twice for the same candidate.
//
// ── Three rules the code holds rather than trusts ─────────────────────────────
//
// A candidate NAMES NOTHING. `Customer.notes`, `preferredContactTime` — an
// identifier from the translator is a fact it invented, and grading it would
// grade a hallucination. `checkCandidate` refuses any word shaped like one. The
// identifier in an answer is always one this module produced.
//
// A WRONG ANSWER IS WORSE THAN NO ANSWER. Words that match two things are not
// resolved to the likelier one: they come back `unhomed` with both named. Run 1's
// one wrong verdict read as a clean refusal, and nothing said so.
//
// NOTHING HERE PROMISES. A `needs us` carries a cost CLASS — the deepest realm the
// change reaches — and never a duration.
//
// ── What it reads ─────────────────────────────────────────────────────────────
//
// The parsed seed (litestone's `parseFile(...).schema`, handed in — this package
// takes no dependency on litestone) and the TEXT of three committed snapshots:
// `surface.snapshot.md`, `routes.snapshot.md`, `notifications.snapshot.md`. All
// four are regenerated and CI-gated, which is the whole argument for resolving
// against them rather than against documentation.
//
// ── What it cannot see, stated rather than guessed ────────────────────────────
//
// What a SCREEN shows. The route table names screens and nothing indexes their
// contents, so a UI fact resolves its data half and reports the screen half as
// `unverified`. Run 1 measured that gap at fourteen of sixty.
//
// Zero dependencies beyond `@frontierjs/toolbelt/inflect`, plain ESM, node or bun.

import { singularize, words as splitWords, humanize } from '@frontierjs/toolbelt/inflect'

// ─── the candidate ────────────────────────────────────────────────────────────

/** What the person is doing with the fact. */
export const CLAIMS = ['question', 'change', 'broken']

/**
 * The kinds a fact may be, grouped by the realm a NEEDED change would reach.
 * The translator picks a kind; it may classify, it may not name.
 */
export const KINDS = {
  // Data — the thing and its parts
  entity:      'data',   // a noun the app might hold: "rewards points"
  attribute:   'data',   // a property of a noun: "a private note on a customer"
  edit:        'data',   // changing a value that is already stored: "change the size on an order"
  move:        'data',   // a state change: "undo a shipped order", "mark invoices paid"
  sum:         'data',   // a derived number over children: "total of a pay run"
  view:        'data',   // a projection over rows: "best-selling candles"
  export:      'data',   // rows leaving as a file: "every invoice from last month"
  createdBy:   'data',   // who made a row: "filter orders by who created them"
  // API — behavior
  method:      'api',    // an action the app runs: "refund part of an order"
  notification: 'api',   // something the app tells somebody: "a reminder before a class"
  // UI — what a screen shows or offers
  column:      'ui',     // "show the discount on the orders list"
  filter:      'ui',     // "filter orders by status"
  action:      'ui',     // "a button to print twenty orders"
  display:     'ui',     // "the photo changes with the size"
}

// An identifier has a dot, an inner capital or an underscore between letters.
// A plain word has none, and a translator emitting one has named something.
const IDENTIFIER = /\.|[a-z][A-Z]|^[A-Z][a-z]+[A-Z]|[A-Za-z]_[A-Za-z]/

/**
 * Refuse a candidate that is not one. Returns the reasons, `[]` when it is sound.
 * The identifier rule is the load-bearing one; the rest is shape.
 */
export function checkCandidate(candidate) {
  const out = []
  if (!candidate || typeof candidate !== 'object') return ['a candidate is an object']
  if (!CLAIMS.includes(candidate.claim)) out.push(`claim must be one of ${CLAIMS.join(', ')}`)
  if (!Array.isArray(candidate.facts) || !candidate.facts.length) out.push('a candidate carries at least one fact')
  for (const [i, f] of (candidate.facts ?? []).entries()) {
    if (!(f?.kind in KINDS)) out.push(`fact ${i}: kind must be one of ${Object.keys(KINDS).join(', ')}`)
    for (const key of ['about', 'words', 'from', 'to']) {
      const v = f?.[key]
      if (v == null) continue
      if (typeof v !== 'string') { out.push(`fact ${i}: ${key} is a string of plain words`); continue }
      if (IDENTIFIER.test(v)) out.push(`fact ${i}: ${key} "${v}" names something — a candidate carries words, never an identifier`)
    }
    if (f?.pick != null && typeof f.pick !== 'string') out.push(`fact ${i}: pick is one id off the menu`)
    if (!f?.about && !f?.words && !f?.pick) out.push(`fact ${i}: needs about, words or pick`)
  }
  return out
}

// ─── terms ────────────────────────────────────────────────────────────────────

const STOP = new Set(['a', 'an', 'the', 'of', 'on', 'for', 'to', 'my', 'our', 'their', 'in', 'by', 'and', 'each', 'every', 'per'])

/** Words as the index compares them: split, lowercased, singular, no filler. */
export function terms(text) {
  if (!text) return []
  return splitWords(String(text))
    .map(w => singularize(w.toLowerCase()))
    .filter(w => w && !STOP.has(w))
}

const phrase = (text) => terms(text).join(' ')

// ─── the snapshots ────────────────────────────────────────────────────────────

/** `surface.snapshot.md` → services, each with its model, methods and grades. */
export function parseSurface(text = '') {
  const services = []
  let cur = null
  for (const line of text.split('\n')) {
    const head = line.match(/^### `([^`]+)` · model `([^`]+)`/)
    if (head) { cur = { name: head[1], model: head[2], methods: [], custom: [], grades: {} }; services.push(cur); continue }
    if (!cur) continue
    const list = line.match(/^- \*\*(methods|custom methods)\*\* — (.*)$/)
    if (list) {
      const names = [...list[2].matchAll(/`([^`]+)`/g)].map(m => m[1])
      if (list[1] === 'methods') cur.methods = names
      else cur.custom = names
      continue
    }
    const grade = line.match(/^ {2}- `([^`]+)` — (.*)$/)
    if (grade) cur.grades[grade[1]] = grade[2].replace(/\*\*/g, '')
  }
  return services
}

/** `routes.snapshot.md` → `{ path, file }` for every route row. */
export function parseRoutes(text = '') {
  return [...text.matchAll(/^\| `(\/[^`]*)` \| `([^`]+)` \|/gm)].map(m => ({ path: m[1], file: m[2] }))
}

/** `notifications.snapshot.md` → the declared types and their transports. */
export function parseNotifications(text = '') {
  return [...text.matchAll(/^\| `([A-Z][A-Za-z0-9]*)` \| (.*) \|$/gm)]
    .map(m => ({ type: m[1], transports: [...m[2].matchAll(/`([^`]+)`/g)].map(t => t[1]) }))
}

// ─── the index ────────────────────────────────────────────────────────────────

const attr   = (node, kind) => (node.attributes ?? []).find(a => a.kind === kind)
const attrs  = (node, kind) => (node.attributes ?? []).filter(a => a.kind === kind)
const gateOf = (model) => {
  const g = attr(model, 'gate')?.value
  if (g == null) return null
  const parts = String(g).split('.').map(Number)
  const at = (i) => parts[Math.min(i, parts.length - 1)]
  return { read: at(0), create: at(1), update: at(2), delete: at(3) }
}

/**
 * Everything a fact can resolve to, built once per app.
 *
 * Each entry carries the PHRASES it answers to — its own name in words, and its
 * `@label` where it declares one — and the tokens those phrases hold. No synonym
 * list: a word the seed does not use is a miss here, and a miss is the
 * measurement run 2 exists to take.
 */
export function buildIndex({ schema, surface = '', routes = '', notifications = '' }) {
  const models = schema?.models ?? []
  const services = parseSurface(surface)
  const entries = []
  const add = (entry, texts) => {
    const phrases = [...new Set(texts.filter(Boolean).map(phrase).filter(Boolean))]
    entries.push({ ...entry, phrases, tokens: new Set(phrases.flatMap(p => p.split(' '))) })
  }

  for (const m of models) {
    add({ type: 'model', id: m.name, model: m.name }, [humanize(m.name)])
    // A foreign key and the relation it backs are ONE fact to a person — "the
    // variant on a photo" — and both commonly carry the same `@label`. Indexed
    // apart they make every such word ambiguous, so the key answers only to its
    // own column name and the relation answers to the label.
    const keys = new Set((m.fields ?? []).flatMap(f => attr(f, 'relation')?.fields ?? []))
    for (const f of m.fields ?? []) {
      if (keys.has(f.name)) { add({ type: 'field', id: `${m.name}.${f.name}`, model: m.name, field: f }, [f.name]); continue }
      const label = attr(f, 'label')?.text
      add({ type: 'field', id: `${m.name}.${f.name}`, model: m.name, field: f }, [humanize(f.name), label])
    }
    for (const t of attrs(m, 'transitions')) {
      for (const [name, move] of Object.entries(t.transitions ?? {}))
        add({ type: 'move', id: `${m.name}.${t.field}:${name}`, model: m.name, field: t.field, name, move }, [humanize(name)])
    }
  }
  for (const v of schema?.views ?? [])
    add({ type: 'view', id: v.name, model: v.name }, [humanize(v.name)])
  for (const s of services)
    for (const method of s.custom)
      add({ type: 'method', id: `${s.name}.${method}`, service: s.name, model: s.model, name: method, grade: s.grades[method] ?? null }, [humanize(method)])
  for (const n of parseNotifications(notifications))
    add({ type: 'notification', id: n.type, transports: n.transports }, [humanize(n.type)])

  return {
    models: new Map(models.map(m => [m.name, m])),
    enums: new Map((schema?.enums ?? []).map(e => [e.name, e])),
    services,
    routes: parseRoutes(routes),
    entries,
  }
}

// ─── resolution ───────────────────────────────────────────────────────────────

/**
 * Words → the entries they name, among those `filter` admits.
 *
 * `exact` is a phrase match. `partial` is every word of the query appearing in
 * one entry's words — "note" finds `notes`, "private note" does not find it. A
 * query that matches several entries at the best tier is AMBIGUOUS and resolves
 * to nothing, because choosing is the thing a lookup must not do.
 */
export function resolve(index, text, filter = () => true) {
  const q = phrase(text)
  if (!q) return { status: 'empty', matches: [] }
  const pool = index.entries.filter(filter)
  const exact = pool.filter(e => e.phrases.includes(q))
  if (exact.length === 1) return { status: 'resolved', tier: 'exact', match: exact[0], matches: exact }
  if (exact.length > 1) return { status: 'ambiguous', tier: 'exact', matches: exact }
  const qt = q.split(' ')
  const partial = pool.filter(e => qt.every(t => e.tokens.has(t)))
  if (partial.length === 1) return { status: 'resolved', tier: 'partial', match: partial[0], matches: partial }
  if (partial.length > 1) return { status: 'ambiguous', tier: 'partial', matches: partial }
  return { status: 'missing', matches: [] }
}

/** The noun a fact is about, as a model — directly, or through its own service's name. */
function resolveAbout(index, about) {
  if (!about) return { status: 'empty', matches: [] }
  const direct = resolve(index, about, e => e.type === 'model')
  if (direct.status !== 'missing') return direct
  const q = phrase(about)
  const viaService = index.services.filter(s => phrase(humanize(s.name)) === q && index.models.has(s.model))
  if (viaService.length === 1) {
    const m = index.entries.find(e => e.type === 'model' && e.id === viaService[0].model)
    return { status: 'resolved', tier: 'service', match: m, matches: [m] }
  }
  return direct
}

// ─── the verdicts ─────────────────────────────────────────────────────────────

export const VERDICTS = ['exists', 'you can do this', 'declined by design', 'needs us', 'incident', 'unhomed']

// The cost ladder, cheapest first. `none` is a verdict that needs no change.
export const DEPTHS = ['none', 'ui', 'api', 'data-declaration', 'data-migration']

const deeper = (a, b) => (DEPTHS.indexOf(a) >= DEPTHS.indexOf(b) ? a : b)
const prose  = (node) => (node?.comments ?? []).join(' ').replace(/\s+/g, ' ').trim() || null

function fieldFacts(field) {
  const kinds = new Set((field.attributes ?? []).map(a => a.kind))
  return {
    optional:  !!field.type?.optional,
    immutable: kinds.has('immutable'),
    system:    kinds.has('system'),
    guarded:   kinds.has('guarded') || kinds.has('secret'),
    readPolicy: (field.attributes ?? []).some(a => a.kind === 'fieldAllow' && a.operations?.some(o => o === 'read' || o === 'all')),
  }
}

const unhomed = (fact, why, matches = []) => ({
  verdict: 'unhomed', depth: 'none', fact, why,
  candidates: matches.map(m => m.id),
})

// Words that found nothing are not evidence the thing is absent: the index has
// no synonyms, so "due date" misses `dueAt` and "private note" misses `notes`.
// Run 2 measured 21 confident wrong answers built on a miss. `needs us` is only
// answered from a POSITIVE fact — a state machine absent, two known states with
// no edge, a declaration the model lacks.
const miss = (fact, where, extra = {}) => ({
  ...unhomed(fact, `nothing ${where} is called "${fact.words ?? fact.about}" — it may exist under another name`), ...extra,
})

// ─── the menu ─────────────────────────────────────────────────────────────────

/**
 * Every entry a translator may choose, one line each, with the schema's own
 * comment beside it. Words alone answered 18% of run 2 — a person describes a
 * situation, not a field — so the translator reads this and picks, and the
 * verdict is still decided here from the entry it picked. A pick not on the menu
 * is refused, which is what keeps a chosen id from being an invented one.
 */
export function menu(index) {
  return index.entries.map(e => {
    const node = e.type === 'model' ? index.models.get(e.id) : e.type === 'field' ? e.field : null
    const note = prose(node)
    return { id: e.id, type: e.type, words: e.phrases[0] ?? '', ...(note ? { note: note.slice(0, 160) } : {}) }
  })
}

/** One fact → one verdict. Pure over the index. */
export function judgeFact(index, fact, claim) {
  // A pick stands in for the words: the entry it names is the match wherever a
  // rule asks for its type, and its model is the noun.
  const picked = fact.pick ? index.entries.find(e => e.id === fact.pick) : null
  if (fact.pick && !picked) return unhomed(fact, `"${fact.pick}" is not on the menu`)
  const byPick = (filter) => picked && filter(picked) ? { status: 'resolved', tier: 'pick', match: picked, matches: [picked] } : null
  const lookup = (text, filter) => byPick(filter) ?? resolve(index, text, filter)
  const pickedModel = picked?.model && index.models.has(picked.model)
    ? { status: 'resolved', tier: 'pick', match: index.entries.find(e => e.type === 'model' && e.id === picked.model) } : null
  const about = pickedModel ?? resolveAbout(index, fact.about)
  if (about.status === 'ambiguous') return unhomed(fact, `"${fact.about}" names more than one thing`, about.matches)
  const model = about.status === 'resolved' ? index.models.get(about.match.id) : null

  // A live row is wrong. There is no design question, so nothing is designed —
  // but the answer still says where the truth is kept, which is most of the
  // work somebody routing it will do first.
  if (claim === 'broken') {
    if (!model) return unhomed(fact, fact.about ? `a report about "${fact.about}", which names nothing in the seed` : 'a report that names no noun')
    return { verdict: 'incident', depth: 'none', fact, target: model?.name ?? null,
      cite: model ? `db/schema.lite · model ${model.name}` : null,
      why: model ? `the truth is kept on ${model.name}` : 'routed to a person; nothing in the seed named where the truth lives' }
  }

  const within = (type) => (e) => e.type === type && (!model || e.model === model.name)

  switch (fact.kind) {
    case 'entity': {
      const hit = lookup(fact.words ?? fact.about, e => e.type === 'model')
      if (hit.status === 'ambiguous') return unhomed(fact, 'the words name more than one model', hit.matches)
      if (hit.status === 'resolved') return { verdict: 'exists', depth: 'none', fact, target: hit.match.id, tier: hit.tier, cite: `db/schema.lite · model ${hit.match.id}`, prose: prose(index.models.get(hit.match.id)) }
      return miss(fact, 'in the seed')
    }

    case 'attribute':
    case 'edit':
    case 'column':
    case 'filter':
    case 'display': {
      if (!model) return unhomed(fact, fact.about ? `nothing in the seed is called "${fact.about}"` : 'a property of what? the fact names no noun')
      const hit = lookup(fact.words, within('field'))
      if (hit.status === 'ambiguous') return unhomed(fact, `"${fact.words}" matches more than one field on ${model.name}`, hit.matches)
      const ui = KINDS[fact.kind] === 'ui'

      if (hit.status === 'missing') {
        // The pool is a positive fact and is said; it is not a verdict, because
        // the field may already exist under a name these words missed.
        const pool = attr(model, 'extensible') ? [`${model.name} declares a pool of custom fields — if this is new, adding one needs no developer`] : []
        return miss(fact, `on ${model.name}`, { notes: pool })
      }

      const field = hit.match.field
      const facts = fieldFacts(field)
      const cite  = `db/schema.lite · ${hit.match.id}`

      if (fact.kind === 'edit') {
        const gate = gateOf(model)
        if (facts.immutable) return { verdict: 'declined by design', depth: 'none', fact, target: hit.match.id, cite, why: `${hit.match.id} is @immutable — once written it is not restated`, prose: prose(field) ?? prose(model) }
        if (facts.system) return { verdict: 'declined by design', depth: 'none', fact, target: hit.match.id, cite, why: `${hit.match.id} is @system — the application writes it, a person does not`, prose: prose(field) }
        if (gate && gate.update >= 8) return { verdict: 'declined by design', depth: 'none', fact, target: hit.match.id, cite: `db/schema.lite · ${model.name} @@gate`, why: `${model.name} updates at ${gate.update} — only the system writes it`, prose: prose(model) }
        return { verdict: 'you can do this', depth: 'none', fact, target: hit.match.id, cite, why: gate ? `editable at level ${gate.update}` : 'editable' }
      }

      if (ui) return { verdict: 'needs us', depth: 'ui', fact, target: hit.match.id, cite,
        why: `the data is already there (${hit.match.id}); only a screen is missing`, unverified: ['screen'] }

      const notes = []
      if (facts.readPolicy) notes.push('not every caller may read it')
      if (facts.guarded)    notes.push('it is protected and never shown')
      return { verdict: 'exists', depth: 'none', fact, target: hit.match.id, tier: hit.tier, cite, notes, prose: prose(field) }
    }

    case 'move': {
      if (!model) return unhomed(fact, fact.about ? `nothing in the seed is called "${fact.about}"` : 'a move of what? the fact names no noun')
      const t = attrs(model, 'transitions')[0]
      if (!t) return { verdict: 'needs us', depth: 'data-migration', fact, target: model.name, why: `${model.name} has no state machine` }
      const values = index.enums.get(model.fields.find(f => f.name === t.field)?.type?.name)?.values?.map(v => v.name ?? v) ?? []
      const state = (w) => values.find(v => phrase(humanize(v)) === phrase(w)) ?? null
      const from = fact.from ? state(fact.from) : null
      const to   = fact.to   ? state(fact.to)   : null
      if (fact.from && !from) return unhomed(fact, `${model.name}.${t.field} has no state "${fact.from}"`)
      if (fact.to && !to) return unhomed(fact, `${model.name}.${t.field} has no state called "${fact.to}" — it may exist under another name`)

      let move = null
      if (fact.words || picked) {
        const hit = lookup(fact.words, within('move'))
        if (hit.status === 'ambiguous') return unhomed(fact, `"${fact.words}" matches more than one move`, hit.matches)
        if (hit.status === 'resolved') move = hit.match
      }
      if (!move && to) {
        const moves = index.entries.filter(e => within('move')(e) && e.move.to === to && (!from || e.move.from.includes(from)))
        if (moves.length > 1) return unhomed(fact, `more than one move reaches ${to}`, moves)
        move = moves[0] ?? null
      }
      if (!move) {
        if (from && to) return { verdict: 'needs us', depth: 'data-declaration', fact, target: `${model.name}.${t.field}`,
          cite: `db/schema.lite · ${model.name} @@transitions`, why: `no move takes ${model.name}.${t.field} from ${from} to ${to} — one edge` }
        return unhomed(fact, `no move on ${model.name} matches`)
      }
      if (from && !move.move.from.includes(from))
        return { verdict: 'needs us', depth: 'data-declaration', fact, target: move.id, cite: `db/schema.lite · ${model.name} @@transitions`,
          why: `${move.name} starts from ${move.move.from.join(' or ')}, not ${from} — one edge` }

      const cite = `db/schema.lite · ${model.name} @@transitions ${move.name}`
      // A `@system` move is not a person's to ask for — unless a service method
      // makes it on a caller's behalf, which only the surface can say. Reading
      // the seed alone here was run 1's one wrong answer (A24, `invoices.settle`).
      if (move.move.system) {
        const method = index.entries.find(e => e.type === 'method' && e.model === model.name && e.name === move.name)
        if (method) return { verdict: 'you can do this', depth: 'none', fact, target: method.id, cite: `surface.snapshot.md · ${method.id}`,
          why: `the move is the application's, and ${method.id} makes it for a person`, grade: method.grade }
        return { verdict: 'declined by design', depth: 'none', fact, target: move.id, cite, why: `${move.name} is @system — the application makes it, a person does not`, prose: prose(model) }
      }
      const level = Math.max(gateOf(model)?.update ?? 0, move.move.gate ?? 0)
      // A grid ANDed with the ladder: saying only the level would tell a
      // developer without the grant that they can.
      const grant = attr(model, 'capabilities') ? ` holding ${model.name}.${move.name}` : ''
      return { verdict: 'you can do this', depth: 'none', fact, target: move.id, cite, why: level ? `a person at level ${level}${grant} makes it` : `a person${grant} may make it` }
    }

    case 'sum':
    case 'view':
    case 'export':
    case 'createdBy': {
      if (fact.kind === 'view') {
        const hit = lookup(fact.words, e => e.type === 'view')
        if (hit.status === 'resolved') return { verdict: 'exists', depth: 'none', fact, target: hit.match.id, cite: `db/schema.lite · view ${hit.match.id}` }
        return miss(fact, 'among the views')
      }
      if (!model) return unhomed(fact, fact.about ? `nothing in the seed is called "${fact.about}"` : 'over what? the fact names no noun')
      const has = {
        export:    () => !!attr(model, 'export'),
        createdBy: () => !!attr(model, 'createdBy') || model.fields.some(f => attr(f, 'createdBy')),
        sum:       () => { const h = lookup(fact.words, within('field')); return h.status === 'resolved' && !!attr(h.match.field, 'from') },
      }[fact.kind]()
      // A sum is only known absent when the words found the field it would be.
      if (fact.kind === 'sum' && !has && lookup(fact.words, within('field')).status !== 'resolved') return miss(fact, `on ${model.name}`)
      const word = { export: '@@export', createdBy: '@@createdBy', sum: 'a @from sum' }[fact.kind]
      if (has) return { verdict: 'exists', depth: 'none', fact, target: model.name, cite: `db/schema.lite · ${model.name} ${word}` }
      return { verdict: 'needs us', depth: 'data-declaration', fact, target: model.name, why: `${word} on ${model.name} — one declaration, no column moves` }
    }

    case 'method': {
      const hit = lookup(fact.words, within('method'))
      if (hit.status === 'ambiguous') return unhomed(fact, `"${fact.words}" matches more than one method`, hit.matches)
      if (hit.status === 'resolved') return { verdict: 'exists', depth: 'none', fact, target: hit.match.id, cite: `surface.snapshot.md · ${hit.match.id}`, grade: hit.match.grade }
      return miss(fact, model ? `among ${model.name}'s methods` : 'among the methods')
    }

    case 'notification': {
      const hit = lookup(fact.words, e => e.type === 'notification')
      if (hit.status === 'resolved') return { verdict: 'exists', depth: 'none', fact, target: hit.match.id, cite: `notifications.snapshot.md · ${hit.match.id}`, transports: hit.match.transports }
      return miss(fact, 'among the notifications')
    }

    case 'action':
      if (!model) return unhomed(fact, fact.about ? `nothing in the seed is called "${fact.about}"` : 'on which screen? the fact names no noun')
      // Nothing indexes what a screen offers, so an action is never known absent.
      return unhomed(fact, `an action on a screen over ${model.name} — nothing indexes what a screen offers`, [])
  }
  return unhomed(fact, `no rule for kind "${fact.kind}"`)
}

// ─── the candidate, whole ─────────────────────────────────────────────────────

/**
 * A candidate → per-fact verdicts, the deepest cost, and the identity to dedupe by.
 *
 * The overall verdict is the most actionable one any fact reached, in the order a
 * person must act on it — an incident is routed before anything is designed. An
 * `unhomed` fact never hides behind a resolved one: `unhomed` lists them, and a
 * candidate every fact of which is unhomed is unhomed.
 */
export function recognize(index, candidate) {
  const refused = checkCandidate(candidate)
  if (refused.length) return { refused }

  const facts   = candidate.facts.map(f => judgeFact(index, f, candidate.claim))
  const homed   = facts.filter(f => f.verdict !== 'unhomed')
  const order   = ['incident', 'needs us', 'declined by design', 'you can do this', 'exists']
  const verdict = homed.length ? order.find(v => homed.some(f => f.verdict === v)) : 'unhomed'
  const depth   = facts.reduce((d, f) => deeper(d, f.depth), 'none')
  // Grouping by the resolved target, never by the words: two requests for dark
  // mode about two different surfaces read alike and are different answers.
  const identity = homed.length
    ? homed.map(f => `${f.verdict}:${f.target ?? '∅'}`).sort().join(' + ')
    : null

  return { verdict, depth, facts, identity, unhomed: facts.filter(f => f.verdict === 'unhomed') }
}
