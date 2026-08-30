// frappe.js — Frappe/ERPNext DocType JSON, read into .lite.
//
// Here for one construct the other three readers cannot supply: **polymorphism
// that the schema DECLARES**. A Frappe `Dynamic Link` field names the field
// holding its target doctype, so the pair is a fact in the file rather than a
// guess off a column name — and the controlling field says whether the target
// set is CLOSED or OPEN:
//
//   controlling field is a Select with N options  → a closed set of N  → @@arc
//   controlling field is a Link to DocType        → open               → the pair
//
// That is the question `references/Tag.lite` leaves to the author, and the only
// place any input answers it.
//
// Same contract as its siblings: the refusal list is the artifact, and it never
// repairs and never guesses.

import { detectPolymorphic } from './polymorphic.js'

const LAYOUT = new Set(['Section Break', 'Column Break', 'Tab Break', 'HTML', 'Button', 'Heading', 'Fold', 'Image'])

const TYPES = {
  Data: 'String', 'Small Text': 'String', 'Long Text': 'String', Text: 'String',
  'Text Editor': 'String', 'HTML Editor': 'String', 'Markdown Editor': 'String',
  Code: 'String', Password: 'String', 'Read Only': 'String', Barcode: 'String',
  Color: 'String', Signature: 'String', Autocomplete: 'String', Phone: 'String',
  Attach: 'String', 'Attach Image': 'String', Icon: 'String',
  Int: 'Int', Check: 'Boolean', Duration: 'Int', Rating: 'Float',
  Currency: 'Float', Float: 'Float', Percent: 'Float',
  Date: 'DateTime', Datetime: 'DateTime', Time: 'DateTime',
  JSON: 'Json', Geolocation: 'Json',
}

const pascal = (s) => String(s).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/)
  .map(p => p[0].toUpperCase() + p.slice(1)).join('')
const camel = (s) => { const p = pascal(s); return p[0].toLowerCase() + p.slice(1) }

export function convert(docs, label = 'schema') {
  const gaps = []
  const gap = (kind, model, field, detail, emitted) =>
    gaps.push({ source: label, kind, model, field, detail, emitted })

  const byName = new Map()
  for (const d of docs) if (d && d.doctype === 'DocType' && d.name) byName.set(d.name, d)

  const models = new Map()
  for (const d of byName.values()) {
    const model = pascal(d.name)
    if (models.has(model)) {
      gap('name-collision', model, null, `two doctypes give the model name ${model}`, 'the second is skipped')
      continue
    }
    models.set(model, d)
  }

  const enums = new Map()
  const out = []
  for (const [model, doc] of models) out.push(...emitDoc(model, doc, byName, models, enums, gap))

  const head = []
  // A member that is not a bare identifier is quoted — the stored value is the
  // string either way, and a legal identifier stays bare so the output reads
  // like something a person wrote.
  const member = (v) => /^[A-Za-z_]\w*$/.test(v) ? v : `"${v.replace(/(["\\])/g, '\\$1')}"`
  for (const [name, values] of enums) head.push(`enum ${name} {`, ...values.map(v => '  ' + member(v)), '}', '')

  const lite = head.concat(out).join('\n')
  detectPolymorphic(lite, gap)
  return { lite, gaps, models: [...models.keys()] }
}

function emitDoc(model, doc, byName, models, enums, gap) {
  const fields = (doc.fields || []).filter(f => f && f.fieldname && !LAYOUT.has(f.fieldtype))
  const byField = new Map(fields.map(f => [f.fieldname, f]))
  const lines = []
  const taken = new Set(['id'])

  // Every Frappe row is keyed by a varchar called `name`.
  lines.push('  id String @id @map("name")')

  for (const f of fields) {
    const emitted = emitField(model, f, byField, byName, models, enums, gap, taken)
    if (emitted) lines.push(...emitted)
  }

  // The columns the framework puts on every table, and the three more it puts
  // on a child table. `parenttype` + `parent` is a second declared polymorphic
  // pair, on 252 of these — recorded separately so it does not drown the
  // Dynamic Link count, which is the one that carries information.
  for (const [n, t] of [['owner', 'String'], ['creation', 'DateTime'], ['modified', 'DateTime'],
                        ['modifiedBy', 'String'], ['docstatus', 'Int'], ['idx', 'Int']])
    if (!taken.has(n)) { lines.push(`  ${n} ${t}?${n === 'modifiedBy' ? ' @map("modified_by")' : ''}`); taken.add(n) }

  if (doc.istable) {
    for (const [n, t] of [['parent', 'String'], ['parenttype', 'String'], ['parentfield', 'String']])
      if (!taken.has(n)) { lines.push(`  ${n} ${t}?`); taken.add(n) }
    gap('frappe-child-parent', model, 'parent + parenttype', 'a child table, addressed by (parenttype, parent)',
        'emitted as plain columns — the framework\'s own open polymorphic pair, on every child table')
  }

  if (doc.is_submittable)
    gap('submit-workflow', model, 'docstatus',
        'is_submittable — docstatus 0 draft / 1 submitted / 2 cancelled',
        'emitted as a plain Int; the moves are real and @@transitions could carry them, but the states are a framework convention rather than a declaration in this file')

  return [`model ${model} {`, ...lines, '}', '']
}

function emitField(model, f, byField, byName, models, enums, gap, taken) {
  const name = camel(f.fieldname)
  if (taken.has(name)) {
    gap('field-name-collision', model, f.fieldname, `${f.fieldname} collides with ${name}`, 'dropped')
    return null
  }

  const optional = !f.reqd
  const extra = []
  if (f.fieldname !== name) extra.push(`@map("${f.fieldname}")`)
  if (f.unique) extra.push('@unique')

  // ── the reason this front-end exists ──────────────────────────────────────
  if (f.fieldtype === 'Dynamic Link') {
    const control = byField.get(f.options)
    if (!control) {
      gap('dynamic-link-unresolved', model, f.fieldname, `options: ${f.options} names no field on this doctype`,
          'String — the pair cannot be read')
    } else if (control.fieldtype === 'Select') {
      const set = String(control.options || '').split('\n').map(s => s.trim()).filter(Boolean)
      gap('declared-polymorphic-closed', model, `${f.fieldname} via ${f.options}`,
          `a CLOSED set of ${set.length}: ${set.slice(0, 6).join(', ')}${set.length > 6 ? ' …' : ''}`,
          set.length <= 6
            ? `@@arc([…]) is the shape — ${set.length} members, inside the ceiling — but it needs one nullable FK per target, which this row does not have`
            : `too wide for @@arc (${set.length} members); the pair is the honest shape and a sweep job is owed`)
    } else {
      gap('declared-polymorphic-open', model, `${f.fieldname} via ${f.options}`,
          `the controlling field is a ${control.fieldtype}${control.options ? ` to ${control.options}` : ''} — the target set is OPEN`,
          'the (type, id) pair is the shape; @@arc cannot serve an open set, and a sweep job is owed (references/Tag.lite)')
    }
    return [`  ${name} String${optional ? '?' : ''}${extra.length ? ' ' + extra.join(' ') : ''}`]
  }

  if (f.fieldtype === 'Link') {
    const target = f.options && models.has(pascal(f.options)) ? pascal(f.options) : null
    if (!target) {
      // `Link` to DocType holds a doctype NAME — it is the controlling half of a
      // dynamic link rather than a foreign key.
      if (f.options !== 'DocType')
        gap('link-to-unknown-doctype', model, f.fieldname, `Link → ${f.options}`, 'String — the target doctype is not in this app')
      return [`  ${name} String${optional ? '?' : ''}${extra.length ? ' ' + extra.join(' ') : ''}`]
    }
    taken.add(name)
    const rel = `${name}Ref`
    return [
      `  ${name} String${optional ? '?' : ''}${extra.length ? ' ' + extra.join(' ') : ''}`,
      `  ${rel} ${target}${optional ? '?' : ''} @relation(fields: [${name}], references: [id])`,
    ]
  }

  if (f.fieldtype === 'Table' || f.fieldtype === 'Table MultiSelect') {
    gap('child-table-field', model, f.fieldname, `${f.fieldtype} → ${f.options}`,
        'not a column — Frappe stores the rows on the child table, addressed by (parenttype, parent)')
    return null
  }

  if (f.fieldtype === 'Select') {
    const values = String(f.options || '').split('\n').map(s => s.trim()).filter(Boolean)
    // A member may be a quoted string now, so an option list only has to be a
    // SET — two or more distinct values. It used to have to be identifiers,
    // which lost 283 declared sets across ERPNext to a bare `String`, and
    // almost every one was blocked by a space and nothing else: `On Hold`,
    // `To Receive and Bill`, `Grand Total`.
    //
    // One option is still not a set. Frappe's `naming_series` is the shape —
    // `PUR-RFQ-.YYYY.-`, a format string wearing a Select — and an enum of one
    // member says the column is a constant, which it is not.
    const safe = values.length >= 2
    if (safe) {
      // `<Model><Field>` is the derived name, and ERPNext has a doctype called
      // `Supplier Scorecard Period` as well as a `Supplier Scorecard.period`,
      // so the two land on one declaration name and the schema does not parse.
      // Widening which Selects become enums is what made the collision reachable.
      let enumName = `${model}${pascal(f.fieldname)}`
      while (models.has(enumName) || enums.has(enumName)) {
        const alt = `${enumName}Enum`
        gap('enum-name-collision', model, f.fieldname,
            `${enumName} is already ${models.has(enumName) ? 'a doctype' : 'an enum'}`,
            `named ${alt} instead — the set is intact and the NAME is this reader's`)
        enumName = alt
      }
      enums.set(enumName, [...new Set(values)])
      return [`  ${name} ${enumName}${optional ? '?' : ''}${extra.length ? ' ' + extra.join(' ') : ''}`]
    }
    if (values.length)
      gap('select-not-an-enum', model, f.fieldname, `${values.length} option, ${values[0].slice(0, 40)}`,
          'String — one option is not a set. A naming series is a format string rather than a closed set of values')
    return [`  ${name} String${optional ? '?' : ''}${extra.length ? ' ' + extra.join(' ') : ''}`]
  }

  const type = TYPES[f.fieldtype]
  if (!type) {
    gap('unknown-fieldtype', model, f.fieldname, f.fieldtype, 'String — no .lite equivalent')
    return [`  ${name} String${optional ? '?' : ''}${extra.length ? ' ' + extra.join(' ') : ''}`]
  }

  if (f.default !== undefined && f.default !== null && f.default !== '') {
    const d = String(f.default)
    if (/^(Today|Now|now|:user|__user)$/i.test(d)) {
      if (type === 'DateTime') extra.push('@default(now())')
      else gap('dynamic-default', model, f.fieldname, `default: ${d}`, 'dropped — a session or clock value with no .lite spelling')
    } else if (type === 'Boolean') extra.push(`@default(${d === '1' || d === 'true' ? 'true' : 'false'})`)
    else if (type === 'Int' || type === 'Float') { if (/^-?\d+(\.\d+)?$/.test(d)) extra.push(`@default(${d})`) }
    else if (type === 'String') extra.push(`@default(${JSON.stringify(d)})`)
  }

  return [`  ${name} ${type}${optional ? '?' : ''}${extra.length ? ' ' + extra.join(' ') : ''}`]
}
