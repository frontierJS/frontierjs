// tiers.js — how faithful was the reading, graded.
//
// Every converter in this package produces a `.lite` file that is NOT the whole
// answer: `import` reads a foreign schema, `introspect` reads a live SQLite
// database, and neither source carries everything `.lite` can say. What each
// one could not express is recorded with its model, its field, what the source
// said and what was emitted instead — so the person holding the result is told
// what it cost, rather than finding out from a migration months later.
//
// The grading below is what makes that list readable at all: seven real schemas
// produced 2,178 records, and reading them undifferentiated is the same as not
// reading them.
//
//   changed  the output says something the SOURCE DOES NOT. Reading it will
//            mislead you — an invented primary key, an exact number turned into
//            a float, a NOT VALID foreign key emitted as an enforced one.
//   lost     the source says something the output does not. Thinner, never
//            wrong — a predicate, a default, a view, an index.
//   noted    nothing lost and nothing changed: a decision only the author can
//            make, or a translation that is exact.
//
// `--strict` fails on `changed` alone. A gate that also failed on `lost` would
// fail on every real import — 251 partial indexes in one of the seven — and a
// check that always fires is one nobody reads.
//
// An UNKNOWN kind grades `changed`, which is fail-closed on purpose: a reader
// that learns a new refusal must not have it filed under *ignore me* by default.
// `test/import.test.ts` reads every `gap('…')` literal out of every producer —
// the four readers and `tools/introspect.js` — and fails on one this table does
// not name, so the default is a backstop rather than the mechanism. It fails the
// other way too: a kind graded here that nothing emits is a row describing a
// refusal that no longer exists.

// ─── grading ─────────────────────────────────────────────────────────────────

// changed — the emitted schema means something the source does not.
const CHANGED = [
  'no-primary-key',           // a surrogate id invented; the real key is whatever @@unique names
  'composite-primary-key',    // same, and it admits a second identity for the same tuple (FJS-561)
  'scale-over-9',             // an exact number became a Float — the money bug, silent
  'decimal-no-precision',     // the same, with no scale to have carried
  'bigint',                   // → Int. The COLUMN holds 64 bits and the boundary does not:
                              // past 2^53 the value read back is not the one written (FJS-583).
                              // A generated key and a foreign key are exempt — see wide-int.js
  'unknown-column-type',      // → String, and the values are unknown
  'search-vector-column',     // tsvector → String; the .lite answer is @@fts, which is not a column
  'vector-column',            // → String, and no index that would make one useful
  'versioned-id-generator',   // uuid(7) → uuid(): the time ordering is gone, the column looks fine
  'partitioned-table',        // N physical tables became one
  'unvalidated-foreign-key',  // Postgres NOT VALID emitted as enforced — existing rows may violate it
  'unknown-fieldtype',        // → String, and the values are unknown
  'ignored-model',            // Prisma's @@ignore keeps its table OUT of the client; .lite has no opt-out,
                              // so the model below is one the source deliberately did not expose
]

// lost — the source says something the output does not. Weaker, never wrong.
const LOST = [
  'partial-index',            // the predicate; a UNIQUE one is dropped whole rather than strengthened
  'index-expression',
  'index-modifier',
  'index-collapsed',
  'index-name',
  'array-default',            // .lite refuses every array default, the empty one included (FJS-564)
  'dbgenerated-default',
  'view',
  'native-type',
  'check-unresolved-identifier',
  'non-public-schema',        // the qualifier; two schemas' same-named tables collide as one model NAME,
                              // which is a parse error rather than a silent merge
  'field-name-collision',     // a column dropped
  'unparsed-line',            // a line the reader could not read — the output is thinner by it
  'link-to-unknown-doctype',  // a Link to something outside this app: the relation becomes a bare String
  'select-not-an-enum',       // the option list is a constraint the output does not carry
  'composite-type',           // a Prisma `type` block — the embedded document is gone, and any field
                              // typed by it is left naming nothing, which is a parse error rather than a guess
  'unsupported-column',
  'ignored-field',            // Prisma's @ignore hides a column from the client; the COLUMN is real
  'mongo-auto-default',
  'multi-schema',             // the @@schema qualifier, same class as non-public-schema
  'unknown-model-attribute',
  'ambiguous-one-to-one',     // left unlabelled — the output does not parse, which is the loud kind of loss
  'table-name-collision',     // a whole table skipped: .lite has no schema qualifier to tell the two apart
  'name-collision',           // the same, for two doctypes reducing to one model name
  'inline-constraint',
  'check-postgres-cast',      // the CHECK dropped — a :: cast is not SQLite
  'dynamic-link-unresolved',  // the polymorphic pair could not be read, so the relation is a bare String
  'dynamic-default',

  // introspect — a live database says less than the schema that built it.
  'generated-expression',     // a GENERATED column whose SQL holds a double quote: @generated takes a
                              // string, so the expression is handed over as a comment rather than mangled
  'foreign-key-action',       // ON DELETE SET DEFAULT — SQLite has it and .lite has no word for it
]

// noted — a decision for the author, or an exact translation worth saying out loud.
const NOTED = [
  'polymorphic-candidate',        // @@arc or the (type, id) pair — no schema can say which
  'sti-candidate',
  'declared-polymorphic-open',
  'declared-polymorphic-closed',
  'composite-unique-over-nullable',  // handled: nullsDistinct: true (FJS-D130)
  'check-is-an-arc',                 // handled: an exclusive arc read out of SQL and emitted as @@arc
  'json-object-default',             // a Json default is a string in .lite — exact
  'composite-foreign-key',           // emitted as written
  'child-table-field',               // Frappe keeps the rows on the child table, which is its own model
  'frappe-child-parent',
  'submit-workflow',
  'enum-name-collision',      // the derived enum name was a doctype; the SET is intact and the name is the reader's
  'fulltext',                 // @@fulltext → @@fts: a different search engine, the same declaration
  'arc-member-required',      // an exclusive arc emitted as a plain @@check — SQLite enforces it either way
  'unlabelled-one-to-one',    // an explicit @relation name on both sides; identical in meaning (FJS-563)

  // introspect — SQLite has five storage classes, so a column's TYPE is a
  // decision the author makes and the database cannot hold. Reported only where
  // there is real evidence (a now() default, a 0/1 default), because one row per
  // TEXT column is one row per column and nobody reads that.
  'application-attributes',   // @@gate, @@allow, @secret, @@log, @@fts, @@transitions, @@label and every
                              // validator. Not LOST: a SQLite file never held one, so nothing was
                              // dropped in the reading — it is the half only the author can supply
  'datetime-as-text',         // TEXT with a now() default: DateTime is stored as exactly this
  'boolean-as-int',           // INTEGER defaulting 0 or 1: Boolean is stored as exactly this
]

const TIER = Object.fromEntries([
  ...CHANGED.map(k => [k, 'changed']),
  ...LOST.map(k    => [k, 'lost']),
  ...NOTED.map(k   => [k, 'noted']),
])

export const TIERS = ['changed', 'lost', 'noted']
export const tierOf   = (kind) => TIER[kind] ?? 'changed'
export const gradedKinds = () => Object.keys(TIER)

export function summarise(gaps) {
  const counts = { changed: 0, lost: 0, noted: 0 }
  const byKind = new Map()
  for (const g of gaps) {
    const tier = tierOf(g.kind)
    counts[tier]++
    const row = byKind.get(g.kind) ?? { kind: g.kind, tier, count: 0, first: g }
    row.count++
    byKind.set(g.kind, row)
  }
  return {
    ...counts,
    total: gaps.length,
    worst: counts.changed ? 'changed' : counts.lost ? 'lost' : counts.noted ? 'noted' : null,
    byKind: [...byKind.values()].sort((a, b) =>
      TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || b.count - a.count),
  }
}
