// core/ids.js — who assigns an `@id`, and the generators that fill one
//
// **The generators themselves are `@frontierjs/toolbelt/ids` and are re-exported
// here.** They moved when a third filler appeared: the SQLite client fills an
// omitted `@id` at insert time, the jsonl driver does the same when it builds a
// record, and a browser writing offline has to state the id before anything has
// been inserted anywhere, because the children of that row must name it. A
// browser cannot import this package, and three fillers cannot each own the
// answer.
//
// What stays is the question only a SCHEMA can answer — `isServerAssignedId`
// and `isServerFilled` — which read a field and belong nowhere near a pure
// generator.

export { generateUlid, generateCuid, generateNanoid, ID_GENERATORS, GENERATED_DEFAULTS, mintId }
  from '@frontierjs/toolbelt/ids'

// ─── who assigns the key ──────────────────────────────────────────────────────

/**
 * Does the SERVER fill this `@id`, or must the caller supply it?
 *
 * Two readers ask, and for as long as they each answered it themselves they
 * disagreed (`FJS-608`). `jsonschema.js` excluded every `@id` from create mode
 * as *server-assigned*, so a key the caller must supply was not merely
 * un-required but ABSENT — and with `additionalProperties: false` beside it,
 * junction's `autoValidate` then refused a create that carried the key it could
 * not have known to ask for, and a generated form offered no box to type it in.
 * `client.js`'s required pre-flight answered a narrower version of the same
 * question and got the composite case wrong in the other direction.
 *
 * Three shapes and only the first two are the server's:
 *
 *   `@default(…)`      — filled here for uuid()/ulid()/cuid()/nanoid(), and by
 *                        SQLite for autoincrement() or a literal.
 *   a lone `Int @id`   — SQLite's rowid alias, which auto-assigns with no
 *                        default declared.
 *   anything else      — a slug, a stock keeping unit, an external system's
 *                        identifier, or any member of a composite key. Nobody
 *                        but the caller can produce it.
 *
 * **A composite key is never a rowid alias.** `PRIMARY KEY (a, b)` is an
 * ordinary index whatever the column types, so an `Int` member of one is a
 * column the caller must supply — where a lone `Int @id` is not. The pre-flight
 * tested the type and not the key, so a missing member reached SQLite and came
 * back as a raw `NOT NULL constraint failed` naming a physical table, which is
 * the error shape every other required field exists to avoid.
 */
export function isServerAssignedId(field, model) {
  if (!field.attributes?.some(a => a.kind === 'id')) return false
  if (field.attributes.some(a => a.kind === 'default')) return true
  if (field.type?.name !== 'Int') return false
  const keyWidth = (model?.fields ?? []).filter(f => f.attributes?.some(a => a.kind === 'id')).length
  return keyWidth === 1
}

// ─── who fills the column ─────────────────────────────────────────────────────

const SERVER_FILLED = new Set([
  'default', 'updatedAt', 'sequence', 'computed', 'generated', 'funcCall',
  'from',    'edge',      'derived',
])

/**
 * Is this column filled by the Data boundary when a create omits it?
 *
 * Asked by the create-mode JSON Schema's `required` list and by `client.js`'s
 * required pre-flight. They each kept a list, and the schema's was shorter: a
 * `@sequence` column was required by the schema and exempt in the client, so
 * the browser refused every create of a model that numbers its rows with
 * *number is required* before a request was sent (`FJS-1296`). A caller may
 * still STATE one of these — an explicit `@sequence` value is honored — so the
 * answer is *not required*, never *not writable*.
 */
export function isServerFilled(field) {
  // An array column is filled with no attribute at all: ddl.js gives it
  // DEFAULT '[]', the empty list being its null state. The client's pre-flight
  // skipped arrays and the schema did not, so a browser create that omitted
  // `tags` was refused by name (FJS-1956).
  if (field.type?.array && field.type.kind !== 'relation' && field.type.kind !== 'implicitM2M') return true
  return (field.attributes ?? []).some(a => SERVER_FILLED.has(a.kind))
}
