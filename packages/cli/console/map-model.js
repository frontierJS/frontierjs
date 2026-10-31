// ─── map-model.js — what the `:map` pane draws, as data ───────────────────────
//
// The pure half of the console's `:map` (`IDEAS/one-console.md` 2.4): the
// project model built from `project:map --json`, the findings, the state
// machines and their layout, and the Warden's verdict for one model at one
// level. `Map.mesa` and the panes under it render these and decide nothing, so
// what the map calls a finding or a move is tested here, without a screen.

import { REF } from './map-reference.js'

// The one realm table (`FJS-D1697`): the console, the atlas, the website and
// any drawing of the framework read a realm's color here. A realm is identity,
// not status, so it never takes a bare `success`, `warning` or `danger` — a red
// Deploy would read as broken. Seven tones cannot give eight realms eight hues,
// and in the default theme primary and info are both blue and secondary is ink,
// so a realm is a MIX of tone tokens, chosen so all eight stay apart in the
// default theme (oklab distance ≥ 0.12). A theme where two collide names them
// outright as `--realm-<id>`, which is what the atlas's `theme-field` does.
export const REALM_ACCENT = {
  data:    'var(--color-primary)',
  api:     'var(--color-info)',
  ui:      'color-mix(in oklab, var(--color-muted) 30%, var(--color-success))',
  testing: 'color-mix(in oklab, var(--color-secondary) 50%, var(--color-muted))',
  tooling: 'color-mix(in oklab, var(--color-success) 30%, var(--color-warning))',
  deploy:  'color-mix(in oklab, var(--color-primary) 30%, var(--color-danger))',
  app:     'var(--color-secondary)',
  cross:   'var(--color-muted)',
}

// A default that is another token is a use-site fallback, never a `:root`
// declaration — declared once at the root it resolves there and no theme
// below reaches it.
export const realmColor = (realm) => `var(--realm-${realm}, ${REALM_ACCENT[realm] ?? 'var(--color-muted)'})`

/** The tone machinery reads `--bg-mix`, so a realm tints a card, pill or button the way a tone does. */
export const realmStyle = (realm) => `--bg-mix: ${realmColor(realm)}`

/** One `<prefix><realm>{--realm:…}` rule per realm, for a page that styles from its own sheet. */
export const realmCss = (prefix) =>
  Object.keys(REALM_ACCENT).map(realm => `${prefix}${realm}{--realm:${realmColor(realm)}}\n`).join('')

// ─── The model ────────────────────────────────────────────────────────────────
//
// Everything the page draws that is ABOUT THIS PROJECT comes from here, and
// every field of it comes off `project:map --json`. Nothing is invented: a section with no
// source renders as an Empty saying what would fill it.
export function buildModel(map) {
  const defs      = map.schema?.$defs ?? {}
  const services  = map.services  ?? []
  const resources = map.resources ?? []
  const app       = map.app       ?? null

  // A definition STATES its kind. Filtering on shape (`type === 'object'`) is
  // true of a `type` declaration and a view as well, so eleven payload shapes
  // were listed as models and each warned about a missing `@@gate` it cannot
  // carry (`FJS-1015`). A schema too old to say is treated as no models rather
  // than as every definition — the panel then says the schema needs
  // regenerating, which is true, where the guess said something false.
  const modelEntries = Object.entries(defs).filter(([, d]) => d['x-litestone-kind'] === 'model')
  const enumEntries  = Object.entries(defs).filter(([, d]) => d.type === 'string' && d.enum)

  const models = modelEntries.map(([name, def]) => ({
    name,
    gate:      def['x-gate'] ? gateStr(def['x-gate']) : null,
    softDelete: !!def.properties?.deletedAt,
    version:   def['x-version'] ?? null,
    relations: def['x-relations'] ?? [],
    fields: Object.entries(def.properties ?? {}).map(([fname, prop]) => ({
      name:     fname,
      type:     fieldType(prop),
      nullable: nullable(prop),
      readOnly: !!prop.readOnly,
      required: (def.required ?? []).includes(fname),
    })),
  }))

  const relations = []
  for (const m of models) {
    for (const rel of m.relations) {
      relations.push({
        from:      m.name,
        fromField: rel.fields?.[0] ?? rel.field ?? null,
        to:        rel.model,
        type:      rel.type === 'm2m' ? 'N→N' : 'N→1',
        cascade:   rel.onDelete === 'Cascade',
      })
    }
  }

  // A channel is DECLARED by a service. The old viewer gave every service three
  // invented events; a service that broadcasts nothing now says so.
  const channels = services
    .filter(s => s.channel)
    .map(s => ({
      channel:   s.channel,
      service:   s.name,
      resources: resources.filter(r => r.service === s.name).map(r => r.name),
    }))

  const nouns = {
    litestone: models.map(m => ({ name: m.name, meta: `${m.fields.length} fields`, badge: m.gate })),
    junction:  services.map(s => ({ name: s.name, meta: s.methods.join(' · '), badge: s.channel })),
    sierra:    resources.map(r => ({ name: r.name, meta: r.service ? `→ ${r.service}` : 'no service', badge: null })),
  }

  const packages = (map.packages ?? []).map(p => ({
    ...p,
    ...(REF.TIER1_REGISTRY.find(r => r.id === p.id) ?? {}),
  }))

  return {
    root:       map.meta?.root ?? '',
    name:       (map.meta?.root ?? '').split('/').filter(Boolean).pop() ?? 'project',
    generatedAt: map.meta?.generatedAt ?? null,
    models,
    enums:      enumEntries.map(([name, d]) => ({ name, values: d.enum })),
    services, resources, app, relations, channels, nouns, packages,
    migrations: map.migrations ?? [],
    env:        map.env ?? null,
    atlas:      map.atlas ?? { skipped: true },
    access:     map.access ?? null,
    machines:   buildMachines(defs, services, map.access),
    issues:     collectIssues({ services, resources, app, models, env: map.env, packages }),
  }
}

export function gateStr(g) { return [g.read, g.create, g.update, g.delete].join('.') }
export function nullable(prop) { return Array.isArray(prop.type) ? prop.type.includes('null') : false }
export function fieldType(prop) {
  if (prop.$ref) return prop.$ref.split('/').pop()
  if (prop['x-litestone-file']) return 'File'
  const t = Array.isArray(prop.type) ? prop.type.filter(x => x !== 'null')[0] : prop.type
  if (t === 'string' && prop.format) return prop.format === 'date-time' ? 'DateTime' : prop.format
  if (t === 'array') return (fieldType(prop.items ?? {})) + '[]'
  return t ?? 'unknown'
}

// ─── Issues ───────────────────────────────────────────────────────────────────
//
// Every row is something READ, and each names where to look. A judgement the
// data cannot support is not made: the old viewer flagged a missing
// `authenticate` hook on every service in the framework, which is a hook this
// framework does not use — `gateAuth` is the derived one and it is always there.
export function collectIssues({ services, resources, app, models, env, packages }) {
  const out = []

  if (!app) out.push({
    severity: 'error',
    msg:      'No app.snapshot.md — services, routes and plugins cannot be read',
    ref:      'run `junction app --app <entry>` at the project root',
  })

  // There is deliberately NO per-service gateAuth check. One lived here and was
  // false for every row it ever printed: it read the per-method `before` chain,
  // and `gateAuth` is an `around.all` hook that the service builder installs
  // unconditionally — zero occurrences in any `before` chain of any snapshot in
  // this repo. So it fired on exactly the services that expose a write method
  // and reported *ungated* about the one thing gated on every path (`FJS-1016`).
  // Where that question HAS a varying answer is the raw routes, which run below
  // the pipeline; the atlas panels are where it is asked.

  for (const m of models) {
    if (!m.gate) out.push({
      severity: 'warning',
      msg:      `Model '${m.name}' declares no @@gate`,
      ref:      'db/schema.lite — an ungated model is reachable at every level',
    })
  }

  for (const v of (env?.vars ?? [])) {
    if (v.required && v.status === 'missing') out.push({
      severity: 'error',
      msg:      `${v.key} is required and not set`,
      ref:      env.file,
      fix:      v.key,
    })
  }

  // *No resource binds to this service* is a fact about coverage, not a defect —
  // a read-side service an API caller uses is correctly bound by nothing — and
  // twenty-four rows of it pushed the real findings off the page. It is a column
  // in the services panel now.

  for (const p of packages) {
    if (!p.installed) out.push({
      severity: 'info',
      msg:      `${p.label} is not installed`,
      ref:      'package.json — the chain points it would occupy are unclaimed',
    })
  }

  return out
}

// The snapshot answers for four of the twenty nodes. Everywhere else the
// honest answer is that nothing here knows, and the panel simply does not
// claim to — rather than showing the reference list as though it were read.
export function liveHooksFor(model, id) {
  const phaseOf = { 'svc-before': 'before', 'svc-after': 'after', 'app-before': 'before', 'app-after': 'after' }
  const phase   = phaseOf[id]
  if (!phase) return null

  if (id.startsWith('app-')) {
    const hooks = model.app?.appHooks?.[phase] ?? {}
    return {
      head: 'app',
      rows: Object.entries(hooks).map(([m, fns]) => ({ owner: 'app', phase: `${phase}.${m}`, fns })),
    }
  }

  const rows = []
  for (const svc of model.services) {
    for (const [m, fns] of Object.entries(svc.hooks?.[phase] ?? {})) {
      rows.push({ owner: svc.name, phase: `${phase}.${m}`, fns })
    }
  }
  return { head: 'service', rows }
}

// Consecutive nodes of one realm are one band. The grouping is what makes a
// lane readable: four API nodes in a row are one stretch of the chain, not four
// unrelated boxes.
export function bands(nodes) {
  const out = []
  for (const n of nodes) {
    const last = out[out.length - 1]
    if (last && last.realm === n.realm) last.nodes.push(n)
    else out.push({ realm: n.realm, nodes: [n] })
  }
  return out
}

// ─── Machines and the Warden ──────────────────────────────────────────────────
//
// Two panels about how rows MOVE and who may move them, both read off the
// schema and nothing placed by hand. A machine is one `@@transitions` column
// with the `@@commitments` that fire its moves on a date; the Warden is
// `litestone access` read for one model at one caller level. The tables the
// schema panel already has answer *what is declared*; these answer *what does
// that mean for a row, and for this caller*.

// A move is drawn by who makes it. Status tones are kept for verdicts, so the
// four kinds take the non-status tones plus warning — an @system move is one a
// caller cannot ask for, which is the one a reader is most often surprised by.
export const MOVE_TONE = { person: 'primary', gated: 'secondary', app: 'warning', timed: 'info' }
export const MOVE_SAYS = {
  person: 'a caller asks for it',
  gated:  'only at a higher level',
  app:    'the app makes it, nobody can ask',
  timed:  'happens on a date',
}

// `services` reports the model as its service named it, which is sometimes the
// accessor (`orders`) rather than the model (`Order`).
export function servicesFor(services, name) {
  const lc = name.toLowerCase()
  const spellings = [lc, lc + 's', lc + 'es', lc.replace(/y$/, 'ies')]
  return services.filter(s => s.model === name || spellings.includes(String(s.model ?? '').toLowerCase()))
}

// The first paragraph of a model's `///` note — the schema's own words for it.
export function firstParagraph(desc) {
  if (!desc) return ''
  return desc.trim().split(/\n\s*\n| {2,}/)[0].replace(/\*\*|`/g, '').slice(0, 420)
}

export function timerWhen(t) {
  const o = t.offset
  return t.on + (!o ? '' : o.field ? ` + ${o.field}` : ` + ${o.value}${o.unit}`)
}

export function timerWords(t) {
  const o   = t.offset
  const src = t.owner === t.target ? '' : ` of its ${t.owner}`
  const at  = t.kind === 'day' ? `on the day of ${t.on}${src}` : `at ${t.on}${src}`
  const amt = !o ? '' : o.field ? `${o.field} days` : `${o.value} ${o.unit === 'd' ? 'days' : o.unit}`
  const w   = t.while
  const cond = !w ? ''
    : w.type === 'compare' && w.left?.type === 'field' && w.right?.type === 'literal'
      ? `, while the ${t.owner}'s ${w.left.name} is still ${w.right.value}`
      : ', while a condition holds'
  return (o ? `${amt} after ${t.on}${src}` : at) + cond
}

export function buildMachines(defs, services = [], access = null) {
  const timers = []
  for (const [owner, def] of Object.entries(defs))
    for (const [id, c] of Object.entries(def['x-commitments'] ?? {})) timers.push({ id, owner, ...c })

  // `@seals` is in the access reading and not in the JSON Schema's moves.
  const declared = (model, field, move) => (access?.models ?? [])
    .find(m => m.name === model)?.transitions?.find(t => t.field === field && t.name === move) ?? null

  const out = []
  for (const [name, def] of Object.entries(defs)) {
    if (def['x-litestone-kind'] !== 'model' || !def['x-transitions']) continue
    const update = def['x-gate']?.update ?? null
    const svc    = servicesFor(services, name)

    for (const [field, movesByName] of Object.entries(def['x-transitions'])) {
      const prop  = def.properties?.[field] ?? {}
      const ref   = prop.$ref ? defs[prop.$ref.split('/').pop()] : null
      const moves = Object.entries(movesByName).map(([mv, m]) => {
        const timer = timers.find(t => t.target === name && t.field === field && t.transition === mv) ?? null
        const kind  = timer ? 'timed'
          // 8 is asSystem() and nothing else, so a move graded there is the app's
          : m.system || Math.max(update ?? 0, m.gate ?? 0) >= 8 ? 'app'
          : m.gate != null && m.gate > (update ?? 0) ? 'gated'
          : 'person'
        return {
          name: mv, from: m.from.map(String), to: String(m.to),
          gate: m.gate ?? null, system: !!m.system, seals: !!declared(name, field, mv)?.seals,
          kind, timer,
          methods: svc.filter(s => (s.customMethods ?? []).includes(mv)).map(s => `${s.name}.${mv}()`),
        }
      })
      const named  = ref?.enum ?? (prop.type === 'boolean' ? [false, true] : [])
      const states = [...new Set([...named.map(String), ...moves.flatMap(m => [...m.from, m.to])])]
      const froms  = new Set(moves.flatMap(m => m.from))
      const tos    = new Set(moves.map(m => m.to))
      const entry  = prop.default != null ? String(prop.default) : null
      out.push({
        model: name, field, update, states, entry, moves,
        terminal:  states.filter(s => tos.has(s) && !froms.has(s)),
        unreached: states.filter(s => !tos.has(s) && s !== entry),
        note:      firstParagraph(def.description),
        services:  svc.map(s => s.name),
        channel:   svc.find(s => s.channel)?.channel ?? null,
        incoming:  timers.filter(t => t.target === name && t.field === field && t.owner !== name),
        outgoing:  timers.filter(t => t.owner === name && t.target !== name),
      })
    }
  }
  return out
}

// ── the layout ──
//
// Layered, left to right, with no library: the page needs no network, and a
// machine is a handful of states. A state's column is its distance from the
// entry, every final state shares the last column, and each forward move takes
// a slot in every column between its ends — the middle one holds its label —
// so a long move bends around the states it passes instead of through them.
// A move back, or between two states of one column, arcs outside the columns.
export const MONO_ADVANCE = 7.2   // px per character at 12px mono; boxes are sized from it

export function moveLabel(mv) {
  return mv.name + (mv.kind === 'gated' ? ` · ${mv.gate}+` : '') + (mv.seals ? ' · seals' : '') +
         (mv.timer ? ` · ${timerWhen(mv.timer)}` : '')
}

export function layoutMachine(mc) {
  const NODE_H = 40, LABEL_H = 22, GAP_X = 26, GAP_Y = 16, EMPTY_W = 36

  const start = mc.entry ?? mc.states[0]
  const rank  = new Map([[start, 0]])
  for (const queue = [start]; queue.length;) {
    const s = queue.shift()
    for (const m of mc.moves) if (m.from.includes(s) && !rank.has(m.to)) { rank.set(m.to, rank.get(s) + 1); queue.push(m.to) }
  }
  const final = new Set(mc.terminal)
  let last = 0
  for (const [s, r] of rank) if (!final.has(s)) last = Math.max(last, r)
  for (const s of mc.states) {
    if (!rank.has(s)) rank.set(s, 0)
    else if (final.has(s)) rank.set(s, last + 1)
  }

  const cols  = []
  const items = new Map()
  const add   = (c, it) => { (cols[c] ??= []).push(it); items.set(it.id, it); it.col = c; return it }
  for (const s of mc.states)
    add(2 * rank.get(s), { id: 's:' + s, kind: 'state', state: s, w: Math.max(84, s.length * 8 + 32), h: NODE_H, preds: [] })

  const forward = [], back = [], side = []
  for (const mv of mc.moves) {
    const b    = 2 * rank.get(mv.to)
    const text = moveLabel(mv)
    const lw   = text.length * MONO_ADVANCE + 16
    const ahead = []
    for (const f of mv.from) {
      const a = 2 * rank.get(f)
      const e = { mv, from: [f], to: mv.to, key: `${mv.name}:${f}`, text, lw }
      if (b < a) back.push(e)
      else if (b === a) {
        e.label = add(a + 1, { id: `l:${mv.name}:${f}`, kind: 'label', w: lw, h: LABEL_H, preds: ['s:' + f] })
        side.push(e)
      } else ahead.push(f)
    }
    if (!ahead.length) continue
    // Every forward from-state converges on ONE label in the gap before the
    // target, so a move out of three states reads as one move and not three.
    const label = add(b - 1, { id: `l:${mv.name}`, kind: 'label', w: lw, h: LABEL_H, preds: [] })
    const legs  = ahead.map(f => {
      const via = []
      let prev = 's:' + f
      for (let c = 2 * rank.get(f) + 1; c < b - 1; c++) {
        const it = add(c, { id: `d:${mv.name}:${f}:${c}`, kind: 'dummy', w: 0, h: 2, preds: [prev] })
        via.push(it)
        prev = it.id
      }
      label.preds.push(prev)
      return { from: f, via }
    })
    items.get('s:' + mv.to).preds.push(label.id)
    forward.push({ mv, from: ahead, to: mv.to, key: `${mv.name}:${ahead[0]}`, text, lw, label, legs })
  }

  // One barycenter sweep: each item sits near the items that lead into it.
  const pos = (it) => cols[it.col].indexOf(it) - (cols[it.col].length - 1) / 2
  for (let c = 1; c < cols.length; c++) {
    if (!cols[c]) continue
    const bary = new Map(cols[c].map((it, i) => [it, it.preds.length
      ? it.preds.reduce((n, p) => n + pos(items.get(p)), 0) / it.preds.length
      : i - (cols[c].length - 1) / 2]))
    cols[c].sort((x, y) => bary.get(x) - bary.get(y))
  }

  let cursor = 0
  for (let c = 0; c < cols.length; c++) {
    const col   = cols[c] ?? []
    const width = Math.max(c % 2 ? EMPTY_W : 0, ...col.map(it => it.w))
    const total = col.reduce((n, it) => n + it.h, 0) + GAP_Y * Math.max(0, col.length - 1)
    let y = -total / 2
    for (const it of col) { it.cx = cursor + width / 2; it.cy = y + it.h / 2; y += it.h + GAP_Y }
    cursor += width + GAP_X
  }

  const st     = (s) => items.get('s:' + s)
  const states = mc.states.map(s => st(s))
  const top    = Math.min(...[...items.values()].map(it => it.cy - it.h / 2))
  const curve  = (p, q) => {
    const dx = (q[0] - p[0]) / 2
    return p[1] === q[1] ? ` L${q[0]},${q[1]}` : ` C${p[0] + dx},${p[1]} ${q[0] - dx},${q[1]} ${q[0]},${q[1]}`
  }

  const edges = []
  for (const e of forward) {
    const b = st(e.to), lab = e.label
    let d = ''
    for (const leg of e.legs) {
      const a   = st(leg.from)
      const pts = [[a.cx + a.w / 2, a.cy], ...leg.via.map(it => [it.cx, it.cy]), [lab.cx - lab.w / 2, lab.cy]]
      d += `M${pts[0][0]},${pts[0][1]}`
      for (let i = 1; i < pts.length; i++) d += curve(pts[i - 1], pts[i])
    }
    const p = [lab.cx + lab.w / 2, lab.cy], q = [b.cx - b.w / 2 - 2, b.cy]
    edges.push({ ...e, d: d + `M${p[0]},${p[1]}` + curve(p, q), lx: lab.cx, ly: lab.cy })
  }

  // A move within one column leaves its state on the right, turns at its
  // label in the gap column, and comes back into the target's right edge.
  for (const e of side) {
    const a = st(e.from[0]), b = st(e.to), lab = e.label
    const self = e.from[0] === e.to ? 8 : 0
    const p = [a.cx + a.w / 2, a.cy - self], m = [lab.cx - lab.w / 2, lab.cy], q = [b.cx + b.w / 2 + 2, b.cy + self]
    edges.push({ ...e, d: `M${p[0]},${p[1]}` + curve(p, m) + curve(m, q), lx: lab.cx, ly: lab.cy })
  }

  // A move backward arcs over the top. A cubic's apex is three quarters of
  // the way to its control points.
  let over = 0
  for (const e of back) {
    const a = st(e.from[0]), b = st(e.to)
    const y0 = a.cy - a.h / 2, y3 = b.cy - b.h / 2
    const apex = top - 20 - 30 * over++
    const ctl  = (apex - 0.125 * (y0 + y3)) / 0.75
    const d = `M${a.cx},${y0} C${a.cx},${ctl} ${b.cx},${ctl} ${b.cx},${y3 - 2}`
    edges.push({ ...e, d, lx: (a.cx + b.cx) / 2, ly: apex })
  }

  const entry = st(start)
  const placed = [...items.values()]
  const xs = [...placed.map(it => it.cx - it.w / 2), entry.cx - entry.w / 2 - 34, ...edges.map(e => e.lx - e.lw / 2)]
  const xe = [...placed.map(it => it.cx + it.w / 2), ...edges.map(e => e.lx + e.lw / 2)]
  const ys = [...placed.map(it => it.cy - it.h / 2), ...edges.map(e => e.ly - LABEL_H / 2)]
  const ye = [...placed.map(it => it.cy + it.h / 2), ...edges.map(e => e.ly + LABEL_H / 2)]
  const M = 16
  return {
    dx: M - Math.min(...xs), dy: M - Math.min(...ys),
    width:  Math.max(...xe) - Math.min(...xs) + 2 * M,
    height: Math.max(...ye) - Math.min(...ys) + 2 * M,
    labelH: LABEL_H,
    entry:  { x: entry.cx - entry.w / 2, y: entry.cy },
    states: states.map(it => ({
      state: it.state, cx: it.cx, cy: it.cy, w: it.w, h: it.h,
      entry: it.state === mc.entry, final: final.has(it.state), unreached: mc.unreached.includes(it.state),
    })),
    edges,
  }
}

export function levelName(access, n) {
  const levels = access?.levels
  const hit = levels && Object.entries(levels).find(([, v]) => v === n)
  return hit ? hit[0] : (REF.TRUST[n] ?? `level ${n}`)
}
export const levelWord = (access, n) => `${levelName(access, n)} (${n})`

// What the board cannot draw, said once rather than drawn as a guess: a job or
// a notification names no move, so a link between them is a match on names.
export function machinesGap(atlas) {
  if (!atlas?.jobs && !atlas?.notifications) return ''
  const jobs  = [...(atlas.jobs?.durable ?? []), ...(atlas.jobs?.timers ?? [])].length
  const notes = (atlas.notifications?.declared ?? []).length
  if (!jobs && !notes) return ''
  return `Not on the board: ${jobs} job${jobs === 1 ? '' : 's'} and ${notes} notification${notes === 1 ? '' : 's'}. ` +
    'Neither declares the move it makes or follows, so the link would be a guess from names.'
}

export const article = (noun) => /^[aeiou]/i.test(noun) ? 'an' : 'a'

// ── the Warden ──
//
// One model at one caller level, through the layers `docs/warden.md` names.
// Pure, so the verdicts have a test; the panel only lays them out.
export const OPS = ['read', 'create', 'update', 'delete']

export function wardenAt(m, level) {
  const system = level >= 8
  const ops = Object.fromEntries(OPS.map(op => {
    const need = m.gate?.[op]
    if (need == null) return [op, { ok: true, says: 'open' }]
    if (need === 9)   return [op, { ok: false, says: 'locked' }]
    if (level < need) return [op, { ok: false, says: `needs ${need}` }]
    if (system)       return [op, { ok: true, says: 'every row' }]
    const p = m.policies?.[op]
    return p && (p.allows?.length || p.denies?.length)
      ? [op, { ok: true, filtered: true, says: op === 'create' ? 'checked' : 'some rows' }]
      : [op, { ok: true, says: 'every row' }]
  }))
  // A move's gate is a FLOOR on the update level (`FJS-D511`), and an @system
  // move is the application's alone.
  const moves = (m.transitions ?? []).map(t => {
    const need = Math.max(m.gate?.update ?? 0, t.gate ?? 0)
    const ok   = t.system ? system : level >= need
    return { name: t.name, field: t.field, ok, says: t.system ? 'app only' : `needs ${need}` }
  })
  return { system, ops, moves }
}
