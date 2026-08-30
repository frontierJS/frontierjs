// wide-int.js — what a 64-bit source integer becomes, and which ones are worth
// saying out loud.
//
// A `bigint` column becomes `Int`, and the COLUMN is fine: SQLite's INTEGER is
// 64-bit too. What is not fine is the boundary — the value crosses a JS
// `number` at both ends, so past 2^53 the rounded double is stored and a
// different number is read back with nothing raised (`FJS-583`). The source
// says a range the schema cannot round-trip, which is `changed`, not `noted`;
// this file exists because the sentence has to be the same in all three
// readers and it was previously a claim that measurement contradicted.
//
// **Keys and foreign keys are exempt, and the exemption is structural.** A
// generated key counts from 1 and will not reach 9,007,199,254,740,991 in any
// system that exists; a foreign key holds the values of one. Exempting them is
// what makes the report readable rather than true-and-ignored — measured, the
// corpus holds 458 bigint columns in discourse and reports 124, and 67 in lago
// and reports 64. The difference is the whole point: lago declares its keys as
// `uuid` and its VALUES as bigint, so almost every one is a real finding, and
// what is left across the corpus is the set worth a decision — lago's 61
// `*_amount_cents`, mastodon's counters and `bigint[]` id arrays, trigger.dev's
// nanosecond timestamps.
//
// **Where the source declares relations, the exemption is only structural.** A
// Prisma schema always names the scalar a relation owns, so a `BigInt` that no
// relation names is supplied — `appInstallationId` is a GitHub id, exactly the
// shape that overflows, and a rule keyed on the `Id` suffix would skip the one
// case it most needs to report.
//
// **A SQL dump is the other case, and it needs one fallback.** Rails apps
// commonly declare no FOREIGN KEY constraints at all, so `ai_agent_id bigint`
// carries nothing structural to read: measured on discourse, 185 of 221 reports
// were that shape, and a pass that is 84% conventional keys is one nobody
// finishes. `namesATable` is the fallback — an unconstrained `*_id` whose prefix
// IS a table in this dump — which keeps it a statement about the schema rather
// than about the spelling. A plural `*_ids` is untouched, because an array of
// ids is a value column and one of the shapes most likely to be wide.

export const BIGINT_EMITTED =
  'Int — the column holds 64 bits, but the value crosses a JS number at both ends, ' +
  'so past 9,007,199,254,740,991 what is read back is not what was written (FJS-583). ' +
  'Store it as String, or satisfy yourself the values stay inside that range.'

// An unconstrained `*_id` that names a table present in the same source. Used
// only by the readers whose sources may declare no foreign keys at all; a
// Prisma schema always declares its relations and never asks.
export function namesATable(column, tableExists, singularize) {
  const m = /^(.+)_id$/.exec(column)
  if (!m) return false
  const base = m[1]
  return tableExists(base) || tableExists(singularize(base)) || tableExists(`${base}s`)
}
