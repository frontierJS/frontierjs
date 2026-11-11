// src/types.ts — Airtable's shapes, for the calls this connector makes. A record
// is keyed by FIELD ID (`returnFieldsByFieldId`, `FJS-D2053`), never by name.

/** One record as Airtable answers it. A cell Airtable holds empty is absent from `fields`; `fillRecord` puts it back. */
export interface AirtableRecord {
  id:          string
  createdTime: string
  fields:      Record<string, unknown>
}

/** A refusal's body: `{ error: { type, message } }`, or `{ error: "<TYPE>" }`, or the 429's PLURAL `{ errors: [{ error, message }] }` (measured 2026-11-10). */
export interface AirtableErrorBody {
  error?:   { type?: string; message?: string } | string
  errors?:  { error?: string; message?: string }[]
  /** On a 2xx: `partialSuccess` or `cellsRedactedDueToLimitedPermissions`. */
  details?: { message?: string; reasons?: string[] }
}

export interface AirtableBase { id: string; name: string; permissionLevel: string }

/** Every field type this connector reads; one it has not measured is still a string and passes through untouched. */
export type FieldType =
  | 'singleLineText' | 'multilineText' | 'email' | 'phoneNumber' | 'url'
  | 'multipleRecordLinks' | 'singleSelect' | 'date' | 'currency' | 'count' | 'singleCollaborator' | 'number'
  | 'checkbox' | 'dateTime' | 'multipleAttachments' | 'multipleSelects' | 'multipleCollaborators'
  | 'formula' | 'rollup' | 'multipleLookupValues' | 'createdTime' | 'lastModifiedTime' | 'autoNumber'
  | (string & {})

export interface SelectChoice { id: string; name: string; color?: string }

export interface Field {
  id:       string
  name:     string
  type:     FieldType
  /** A currency's `symbol` and `precision` (never an ISO code), a select's `choices`, a link's `linkedTableId`. */
  options?: { symbol?: string; precision?: number; choices?: SelectChoice[]; linkedTableId?: string; [k: string]: unknown }
}

/** A table with its fields keyed by id, in the schema's order. */
export interface Table {
  id:             string
  name:           string
  primaryFieldId: string
  fields:         Record<string, Field>
}

/** A collaborator cell as Airtable answers it; a write takes `{ id }` alone. */
export interface Collaborator { id: string; email?: string; name?: string }

/** An attachment cell. Its `url` EXPIRES (the docs say hours, unmeasured), so a caller that keeps the file copies it rather than the URL. */
export interface Attachment { id: string; url: string; filename: string; size?: number; type?: string }

/** A currency cell read with a caller-supplied code (C7): an integer of minor units and the code. */
export interface Money { amount: number; currency: string }
