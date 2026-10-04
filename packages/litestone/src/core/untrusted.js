// untrusted.js — a schema the app did not write, held to one file (FJS-1633).
//
// `createClient({ schema: text, db, untrusted: true })` is for schema text that
// arrives as DATA: a Source row in the transit stressor, a tenant-authored
// model. Built as an ordinary client, such text names whatever it likes — a
// `database side { path "/abs/app.db" }` and a model `@@db(side)` opened and
// wrote the app's own file, measured — so whoever writes the row writes there.
//
// An allow-list, never a deny-list: the language grows, and a word added next
// month must be refused here until somebody decides it is safe in a row.
//
//   allowed   models, views, enums, types, traits, valuesets, scopes, and bare
//             claims (`claim customerId`) — what grades and shapes rows in the
//             one file the caller handed in
//   refused   import (reads a file), database (names one), tenancy, function,
//             extends, a claim read off a model, and on a model or view
//             @@auth, @@external, @@db, @@log and @@tenant — each reaches a
//             principal, another database or a file
//
// Every offense is reported at once, by name and line where the parse kept one,
// so a person fixing a row fixes it in one pass.

const MODEL_ATTRS_REFUSED = {
  auth:     'makes this model the principal, which only the app may declare',
  external: 'declares a table some other database owns',
  db:       'places the model in a named database, and only the one file handed in is reachable',
  log:      'writes an audit trail to a database of its own',
  tenant:   'joins the app\'s tenancy, which a row cannot declare',
}

const TOP_LEVEL_REFUSED = {
  imports:      ['import', 'reads another file'],
  databases:    ['database', 'names a file to open and write'],
  tenancy:      ['tenancy', 'is the app\'s, not a row\'s'],
  functions:    ['function', 'is not allowed in a schema held as data'],
  extends:      ['extend', 'changes a model declared elsewhere'],
  claimSources: ['claim … from', 'reads a claim off a model; declare it bare (`claim x`) and let the app resolve it'],
}

/** Every reason this schema may not be built from untrusted text, or []. */
export function untrustedSchemaOffenses(schema) {
  const out = []
  const refuse = (key, name) => {
    const [word, why] = TOP_LEVEL_REFUSED[key]
    out.push(`\`${word}${name ? ` ${name}` : ''}\` ${why}`)
  }
  for (const i of schema.imports ?? [])   refuse('imports', JSON.stringify(i.path))
  for (const d of schema.databases ?? []) refuse('databases', d.name)
  for (const f of schema.functions ?? []) refuse('functions', f.name)
  for (const e of schema.extends ?? [])   refuse('extends', e.name ?? e.model)
  for (const c of Object.keys(schema.claimSources ?? {})) refuse('claimSources', c)
  if (schema.tenancy) refuse('tenancy', '')
  for (const m of [...(schema.models ?? []), ...(schema.views ?? [])]) {
    for (const a of m.attributes ?? []) {
      if (a.kind in MODEL_ATTRS_REFUSED) out.push(`${m.name}: \`@@${a.kind}\` ${MODEL_ATTRS_REFUSED[a.kind]}`)
    }
    if (m.db && m.db !== 'main') out.push(`${m.name}: \`@@db(${m.db})\` ${MODEL_ATTRS_REFUSED.db}`)
  }
  return out
}

export function refuseUntrustedSchema(schema) {
  const offenses = untrustedSchemaOffenses(schema)
  if (offenses.length)
    throw new Error(
      `createClient({ untrusted: true }): this schema reaches outside the one database it is given — ` +
      `${offenses.length} declaration${offenses.length === 1 ? '' : 's'} refused:\n  ` + offenses.join('\n  '))
}
