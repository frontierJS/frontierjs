// jsonschema-snapshot.js — the client contract as a committed file
//
// `generateJsonSchema` is the widest bridge in the repo: Junction validates
// requests against it, Sierra's `field-rules.js` re-checks the same rules in the
// browser, and `@frontierjs/ui`'s `<Form>` reads labels, constraints and
// messages off it to render a control. Three readers, one document, and the
// document is generated — so a keyword that stops being emitted does not break a
// build anywhere. It makes a form stop validating, silently.
//
// This renders that document as something a person can diff. The raw JSON is
// thousands of lines and a real change hides in it; what a reviewer needs is
// *this field gained a rule*, *this message disappeared*, *this model's gate
// moved*, one line each.
//
// Rendered by `litestone jsonschema --snapshot`, byte-compared by `--check`.
// Never imported by production code.

import { generateJsonSchema } from '../jsonschema.js'

// Standard keywords worth showing, in a fixed order — a set would render in
// insertion order and reshuffle the line when the generator's order changes.
const KEYWORDS = [
  'format', 'pattern', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'const',
  // Accounted for rather than left to the catch-all below, which names a key
  // and drops its VALUE — and here the value is the whole content: `x-sortable`
  // alone says a column cannot be sorted and not that it holds a JSON document.
  'x-sortable', 'x-filterable',
]

// Everything else on a property is either prose or already its own column.
const SHOWN_SEPARATELY = new Set([
  'type', 'title', 'description', 'default', 'readOnly', '$ref', 'items',
  'x-messages', 'enum', 'anyOf', 'oneOf',
])

// A definition STATES its kind (`x-litestone-kind`), because the three that live
// in `$defs` are structurally identical: `type === 'object' && properties` is
// true of a model, a `type` declaration and a view alike, so counting models by
// shape counted payload shapes among them — this file reported `54 models · 0
// other` over a schema declaring 43 models and 11 types (`FJS-1015`).
const kindOf  = (def) => def?.['x-litestone-kind'] ?? null
const isModel = (def) => kindOf(def) === 'model'
const isView  = (def) => kindOf(def) === 'view'
const isType  = (def) => kindOf(def) === 'type'
const isEnum  = (def) => Array.isArray(def?.enum)
// Anything shaped like a definition whose kind this reader does not know — a
// kind added later, or a schema generated before the key existed. It is a
// counted row rather than a silent drop, which is the whole point of stating
// the kind instead of inferring it.
const isObjectDef = (def) => def?.type === 'object' && !!def.properties

const refName = (ref) => typeof ref === 'string' ? ref.replace('#/$defs/', '') : null

// ─── one property → one row ───────────────────────────────────────────────────

// An optional column arrives one of two ways — `type: ["string","null"]`, or an
// `anyOf` whose second branch is `{type:"null"}` (that is what a nullable
// DateTime looks like, because the format lives on the branch). Flattened here
// so the row reads the same either way, and a keyword on the branch is still
// found by constraintsOf.
function flatten(prop) {
  const branches = prop.anyOf ?? prop.oneOf
  if (!Array.isArray(branches)) return { prop, nullable: Array.isArray(prop.type) && prop.type.includes('null') }

  const real = branches.filter(b => b.type !== 'null')
  return {
    prop:     { ...Object.fromEntries(Object.entries(prop).filter(([k]) => k !== 'anyOf' && k !== 'oneOf')), ...(real[0] ?? {}) },
    nullable: branches.length > real.length,
  }
}

function typeOf(raw) {
  const { prop, nullable } = flatten(raw)
  const mark = nullable ? '?' : ''

  if (prop.$ref)        return `\`${refName(prop.$ref)}\`${mark}`
  if (prop.items?.$ref) return `\`${refName(prop.items.$ref)}[]\`${mark}`
  if (prop.items?.type) return `\`${prop.items.type}[]\`${mark}`

  const t = prop.type
  if (Array.isArray(t)) {
    const real = t.filter(x => x !== 'null')
    return `\`${real.join('\\|') || 'null'}\`${mark}`
  }
  // A column with no `type` at all is a `Json` one — the schema says nothing
  // about its shape on purpose, and saying `any` here would be a claim the
  // document does not make.
  return t ? `\`${t}\`${mark}` : `\`json\`${mark}`
}

// The default belongs beside the type: `make()` seeds a form from it, so a
// default that moved changes what a user sees in an untouched field.
function defaultOf(raw) {
  const { prop } = flatten(raw)
  return prop.default === undefined ? '' : ` = \`${JSON.stringify(prop.default)}\``
}

function constraintsOf(raw) {
  const { prop } = flatten(raw)
  const out = []
  for (const key of KEYWORDS) {
    if (prop[key] === undefined) continue
    out.push(prop[key] === true ? `\`${key}\`` : `\`${key}: ${JSON.stringify(prop[key])}\``)
  }
  // Anything the generator emits that is not accounted for above — a new
  // keyword, or a new `x-` extension. Named rather than dropped: an extension
  // nobody notices is an extension with no reader.
  for (const key of Object.keys(prop).sort()) {
    if (SHOWN_SEPARATELY.has(key) || KEYWORDS.includes(key)) continue
    out.push(`\`${key}\``)
  }
  return out
}

// ─── renderJsonSchemaSnapshot ─────────────────────────────────────────────────

export function renderJsonSchemaSnapshot(schema, opts = {}) {
  const { source = 'schema.lite' } = opts

  const full   = generateJsonSchema(schema, { format: 'definitions', mode: 'full' })
  const create = generateJsonSchema(schema, { format: 'definitions', mode: 'create' })

  const defs   = full.$defs ?? {}
  const cDefs  = create.$defs ?? {}
  const names  = Object.keys(defs)
  // A view is counted apart from the models it is rendered beside. The two are
  // one section because a projection is described exactly as a table is — the
  // same fields, the same gate, the same closed object — and separate numbers
  // because they are not the same thing to a reader: nothing writes a view, so
  // `55 models` over a schema holding 54 was the count reading as the claim.
  const models = names.filter(n => isModel(defs[n]))
  const views  = names.filter(n => isView(defs[n]))
  const types  = names.filter(n => isType(defs[n]))
  const enums  = names.filter(n => isEnum(defs[n]))
  const others = names.filter(n => !isModel(defs[n]) && !isView(defs[n]) &&
                                   !isType(defs[n])  && !isEnum(defs[n]))

  const out = []

  out.push('# JSON Schema snapshot')
  out.push('')
  out.push(`<!-- generated by: litestone jsonschema --snapshot --schema ${source} -->`)
  out.push('')
  out.push(`Generated from \`${source}\` by \`litestone jsonschema --snapshot\`. **Do not edit.**`)
  out.push('')
  out.push('The document three packages read: Junction validates requests against it,')
  out.push('Sierra re-checks the same rules in the browser, and `<Form>` renders a control')
  out.push('from it. Nothing breaks when a keyword stops being emitted — a form just stops')
  out.push('validating — so the diff is the only place that shows up.')
  out.push('')
  out.push('Rendered from `mode: full`, with the create-mode differences called out per')
  out.push('model. Doc comments (`description`) are omitted: they are prose, they are long,')
  out.push('and no reader branches on them.')
  out.push('')
  out.push('```')
  const many = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  out.push(`${many(Object.keys(defs).length, 'definition')} · ${many(models.length, 'model')} · ` +
           (views.length ? `${many(views.length, 'view')} · ` : '') +
           (types.length ? `${many(types.length, 'type')} · ` : '') +
           `${many(enums.length, 'enum')} · ${others.length} other`)
  out.push('```')
  out.push('')

  // ── Definition table ──
  //
  // `$defs` travels whole and both sides resolve `$ref` into it — a name that
  // disappears is a `$ref` that resolves to nothing, in the browser, at runtime.
  out.push('## Definitions')
  out.push('')
  out.push('`$defs` is the whole table and travels whole. An enum field emits')
  out.push('`{"$ref": "#/$defs/Name"}` and both sides resolve it, so a name that')
  out.push('disappears from here is a reference that resolves to nothing in a browser.')
  out.push('')
  out.push('| Name | Kind |')
  out.push('| --- | --- |')
  for (const name of names) {
    // The kind a definition STATES, never one inferred from its shape. An object
    // definition carrying no kind is `unknown` rather than folded into the
    // nearest guess — a schema generated before the key existed, or a kind this
    // reader predates, and either is a thing to see rather than to mislabel.
    const kind = kindOf(defs[name])
               ?? (isEnum(defs[name]) ? 'enum'
                 : isObjectDef(defs[name]) ? 'unknown' : 'other')
    out.push(`| \`${name}\` | ${kind} |`)
  }
  out.push('')

  // ── Enums ──
  if (enums.length) {
    out.push('## Enums')
    out.push('')
    out.push('A value removed here is a row already in the database that no longer')
    out.push('validates, and a select that silently drops an option.')
    out.push('')
    for (const name of enums) {
      out.push(`- \`${name}\` — ${defs[name].enum.map(v => `\`${v}\``).join(', ')}`)
    }
    out.push('')
  }

  // ── Models ──
  out.push('## Models')
  out.push('')
  out.push('`Required` is the full-mode requirement. `Rules` are the keywords a validator')
  out.push('branches on plus any `x-` extension carried on the field; `Messages` are the')
  out.push('rule names `x-messages` answers for, which is what a failure is allowed to say.')
  out.push('')

  // Types are rendered here rather than as a line in § Other definitions, which
  // is where this file intended them and never sent them: `isModel` matched by
  // shape, so a `type` landed among the models with a full table and the
  // one-line form was dead code. The table is what a reader wants — a declared
  // `type` is what a service's `input:` validates against, so its fields and
  // rules are as consequential as a model's — and dropping to a one-liner when
  // the classification was fixed would have deleted 153 lines of documentation
  // for definitions that are still `$ref`-able.
  let section = 'model'
  for (const name of [...models, ...views, ...types]) {
    if (section === 'model' && types.includes(name)) {
      section = 'type'
      out.push('## Types')
      out.push('')
      out.push('`type T { … }` declarations. No table, no rows, no gate — a payload shape a')
      out.push('`$ref` points at, and what a service `input:` validates against.')
      out.push('')
    }
    const def      = defs[name]
    const required = new Set(def.required ?? [])
    const props    = Object.entries(def.properties ?? {})

    out.push(`### \`${name}\``)
    out.push('')

    // One bullet list, not three: model-level extensions, then the two with a
    // reader on the client that carry structure of their own.
    const bullets = []

    const meta = []
    if (def['x-gate'])        meta.push(`gate \`${Object.entries(def['x-gate']).map(([op, lvl]) => `${op}:${lvl}`).join(' ')}\``)
    if (def['x-version'])     meta.push(`version field \`${def['x-version']}\``)
    if (def['x-soft-delete']) meta.push(`soft delete \`${def['x-soft-delete']}\``)
    if (def.additionalProperties === false) meta.push('closed (`additionalProperties: false`)')
    // Said on the definition rather than left to be inferred from a gate of 9
    // on three operations: a projection is read-only because it is a
    // projection, and the locked writes are the consequence.
    if (isView(def)) meta.unshift('view — read-only')
    if (meta.length) bullets.push(`- ${meta.join(' · ')}`)

    // Relations — the ONLY place a relation exists on the client, and what
    // turns `customerId: integer` into a picker rather than a number spinner.
    // A LIST, not a map: the field name is inside each entry.
    for (const r of def['x-relations'] ?? []) {
      bullets.push(
        `- relation \`${r.field}\` — ${r.type} \`${r.model}\`` +
        (r.fields?.length ? ` via \`${r.fields.join(', ')}\`` : '') +
        (r.onDelete ? ` · on delete ${r.onDelete}` : '') +
        (r.optional ? ' · optional' : '')
      )
    }

    // Transitions live on the MODEL keyed by field, never on the enum, because
    // only a model can carry a per-transition gate. A move with no gate of its
    // own is graded by the model's `update` gate, so no level is shown for it.
    // `@system` is shown beside the level rather than instead of it: a client
    // renders no button at all for one, whatever the level says, so a move
    // gaining it changes what a screen offers and has to be a diff here.
    for (const [field, moves] of Object.entries(def['x-transitions'] ?? {})) {
      bullets.push(`- transitions on \`${field}\` — ${Object.entries(moves)
        .map(([move, m]) => `\`${move}\`: ${(m.from ?? []).join('|') || '—'} → ${m.to}` +
                            `${m.system ? ' @system' : ''}${m.gate != null ? ` @${m.gate}` : ''}`)
        .join(' · ')}`)
    }

    // The grid, beside the gate the header already carries. It is here for the
    // reason every other keyword is: three readers consume this document and a
    // keyword that stops being emitted makes an affordance stop working with
    // nothing failing. `x-capabilities` shipped without a line here, so the one
    // artefact that would have shown a client losing the names showed nothing.
    const caps = def['x-capabilities']
    if (caps) {
      // The NAMES, which is what a client compares against the set on its
      // principal — the one spelling that must never be guessed, since a wrong
      // guess is an affordance that silently never matches.
      const names = [caps.operations, caps.moves, caps.columns]
        .flatMap(g => Object.values(g ?? {}))
        .map(n => `\`${n}\``)
      bullets.push(`- capabilities — ${names.join(' · ') || 'none'}` +
                   `${caps.operations?.read ? '' : ' · read is not graded'}`)
    }

    if (bullets.length) { out.push(...bullets); out.push('') }

    out.push('| Field | Type | Required | Label | Rules | Messages |')
    out.push('| --- | --- | --- | --- | --- | --- |')
    for (const [field, prop] of props) {
      const rules    = constraintsOf(prop)
      const messages = Object.keys(prop['x-messages'] ?? {}).sort()
      out.push(
        `| \`${field}\` | ${typeOf(prop)}${defaultOf(prop)} | ${required.has(field) ? 'yes' : '—'} | ` +
        `${prop.title ? `${prop.title}` : '—'} | ${rules.join(' ') || '—'} | ` +
        `${messages.length ? messages.map(m => `\`${m}\``).join(' ') : '—'} |`
      )
    }
    out.push('')

    // ── Create mode ──
    //
    // The mode a form actually posts. A field the server fills is absent here,
    // and a required one that a caller cannot send is the shape of FJS-095:
    // validation refuses before the request, naming fields the caller was never
    // meant to provide.
    // A projection has no create mode to differ from, and every line this
    // block could write about one — "required — nothing" — reads as a fact
    // about a form that does not exist.
    const cDef      = isView(def) ? null : cDefs[name]
    if (cDef) {
      const cProps    = new Set(Object.keys(cDef.properties ?? {}))
      const cRequired = cDef.required ?? []
      const absent    = props.map(([f]) => f).filter(f => !cProps.has(f))
      // The other direction: a @transient field is accepted on create and is in
      // no read, so the table above — rendered from `full` — cannot show it at
      // all. Naming it here is what makes a change to the wire contract a diff,
      // which is the whole job of this file.
      const writeOnly = [...cProps].filter(f => cDef.properties[f]?.writeOnly)

      const notes = []
      notes.push(`required — ${cRequired.length ? cRequired.map(f => `\`${f}\``).join(', ') : 'nothing'}`)
      if (writeOnly.length) notes.push(`accepted and never stored — ${writeOnly.map(f => `\`${f}\``).join(', ')}`)
      if (absent.length) notes.push(`not accepted — ${absent.map(f => `\`${f}\``).join(', ')}`)
      out.push(`**On create**: ${notes.join(' · ')}`)
      out.push('')
    }
  }

  // ── Other definitions ──
  if (others.length) {
    out.push('## Other definitions')
    out.push('')
    out.push('Definitions stating a kind this reader does not know — a schema generated')
    out.push('before `x-litestone-kind` existed, or a kind added since. Listed rather than')
    out.push('dropped, because a definition nothing can classify is a thing to see.')
    out.push('')
    for (const name of others) {
      const def   = defs[name]
      const props = Object.keys(def.properties ?? {})
      out.push(`- \`${name}\` — ${props.length ? props.map(p => `\`${p}\``).join(', ') : `\`${def.type ?? 'unknown'}\``}`)
    }
    out.push('')
  }

  return out.join('\n').replace(/\n+$/, '\n')
}
