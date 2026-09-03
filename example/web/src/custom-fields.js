// web/src/custom-fields.js — what a shop's own fields look like to a form.
//
// The UI half of `api/src/domain/shop/custom-fields.ts`, and the only place in
// the browser that knows a `CustomField` row can become a control.
//
// ─── Why a wrapper and not a change to <Form> ─────────────────────────────
//
// A generated form reads `buildFieldRules(jsonSchema)`, and that schema is
// compiled from `db/schema.lite` at build time — so a `CustomField` row is
// invisible to it, and no amount of declaring makes a runtime field appear on a
// generated form by itself.
//
// It does not have to. <Form> asks `resource.formFields({ only, except })` and
// `$context.form` reads `resource.fields`, both duck-typed, so handing <Form> a
// resource whose two answers are MERGED is the whole of the integration. The
// kit and sierra are untouched, and `{ type, required, nullable }` is the whole
// shape `controlFor` needs to pick a control.

/** One synthesised field rule per declared field, keyed the way a payload is. */
function rulesFor(defs) {
  const out = {}
  for (const d of defs ?? []) {
    out[fieldKey(d)] = {
      // `controlFor`'s table reads `type` and nothing else here decides the
      // control: text gets an input, number gets a numeric one.
      type:     d.type === 'number' ? 'number' : 'string',
      // Never required. A field declared today cannot be required of the rows
      // written yesterday, and a form that refused to save until every custom
      // field was filled would be unusable the moment a shop declared one.
      required: false,
      nullable: true,
      label:    d.label || d.key,
    }
  }
  return out
}

/**
 * The payload key a declared field travels under.
 *
 * `fields.loyalty_tier` rather than `loyalty_tier`, because the value belongs
 * inside the `fields` blob and a flat key would be refused by the Data boundary
 * as a column `Customer` does not have.
 */
export const fieldKey = def => `fields.${def.key}`

/**
 * A resource that answers for the schema's columns AND this shop's own fields.
 *
 * Everything not named here delegates to the real resource, so `save`, `load`,
 * `record`, the version tracking and the write pipeline are all unchanged —
 * this adds two answers and takes none away.
 */
export function withCustomFields(resource, defs) {
  const extra = rulesFor(defs)
  if (!Object.keys(extra).length) return resource

  return Object.create(resource, {
    fields: {
      get: () => ({ ...(resource.fields ?? {}), ...extra }),
    },
    formFields: {
      value: (opts = {}) => [
        ...(resource.formFields?.(opts) ?? []),
        ...Object.entries(extra)
          .filter(([name]) => !opts.except?.includes(name))
          .filter(([name]) => !opts.only?.length || opts.only.includes(name))
          .map(([name, rule]) => ({
            name,
            rule,
            control: rule.type === 'number' ? 'input' : 'input',
            type:    rule.type === 'number' ? 'number' : 'text',
            label:   rule.label,
          })),
      ],
    },
  })
}
