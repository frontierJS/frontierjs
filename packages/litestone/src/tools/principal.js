// tools/principal.js
// Who `--as <who>` names, for every tool that boots as somebody.
//
// `litestone repl`, `litestone export`, Studio's user picker and junction's
// `call` all turn a word a person typed into a row. Two lookups would grade
// the same `--as` as two different people the day one of them learns a column
// the other does not.

import { modelToAccessor } from '../core/ddl.js'

/** The @@auth model, or the one every app calls User. Studio picks it the same way. */
export function authModelOf(schema) {
  return schema.models.find(m => m.attributes?.some(a => a.kind === 'auth'))
      ?? schema.models.find(m => m.name === 'User' || m.name === 'users')
      ?? null
}

// `--as alice@example.com` over the @@auth model, or `--as Customer:alice@…`
// where the schema never said. Four columns tried in order, because an app names
// its people whatever it names them and asking a person to know which column is
// asking them to read the schema first. An all-digit argument is an id LAST, not
// first: an email is never all digits and a username can be.
//
// It returns what it tried as well as what it found — "no row matches" and
// "there is no such model" send a person to two different places, and a console
// that conflates them sends them to the wrong one.
export async function findPrincipal(sys, schema, spec) {
  const colon  = spec.indexOf(':')
  const named  = colon > 0 ? spec.slice(0, colon) : null
  const needle = colon > 0 ? spec.slice(colon + 1) : spec

  const model = named
    ? schema.models.find(m => m.name === named || modelToAccessor(m.name) === named)
    : authModelOf(schema)

  if (!model) return { row: null, model: null, needle, tried: [] }

  const accessor = modelToAccessor(model.name)
  const declared = new Set((model.fields ?? []).map(f => f.name))
  const tried    = ['email', 'username', 'name'].filter(c => declared.has(c))

  for (const column of tried) {
    const row = await sys[accessor].findFirst({ where: { [column]: needle } }).catch(() => null)
    if (row) return { row, model: model.name, needle, tried }
  }

  if (/^\d+$/.test(needle)) {
    tried.push('id')
    const row = await sys[accessor].findFirst({ where: { id: Number(needle) } }).catch(() => null)
    if (row) return { row, model: model.name, needle, tried }
  }

  return { row: null, model: model.name, needle, tried }
}
