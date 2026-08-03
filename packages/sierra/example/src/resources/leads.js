// src/resources/leads.js — the Resource layer.
//
// Read this file next to db/schema.lite. Nothing here restates anything there:
// no field list, no types, no enum values, no required list, no relations.
// A resource names a model and turns three flags on.

import { createResource } from '@frontierjs/sierra/junction'

export const leads = createResource('leads', {
  // Every DOM control hands back a string — `<input type="number">` and
  // `<select>` included. The schema is the only thing that knows `value` is a
  // Float and `accountId` an Int, so it does the casting.
  coerce: true,

  // Check the record against the schema before the request, and throw
  // ResourceValidationError instead of round-tripping to be told the same
  // thing. The server still validates — this only moves the first `no` closer
  // to the user.
  validate: true,

  // An empty text box submits '', which is not the same value as NULL to
  // SQLite: `slug String? @unique` accepts any number of NULLs but rejects a
  // second ''. Rewrite blanks on nullable fields on the way out.
  blankToNull: true,
})

// `accounts` exists to populate the picker for Lead.accountId. Which resource
// that is was not written here either — see how NewLead.mesa derives it from
// leads.relations.account.model.
export const accounts = createResource('accounts')
export const tags     = createResource('tags')
