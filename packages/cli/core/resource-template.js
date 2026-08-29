// What a GENERATED Resource file IS, for every command that writes one.
//
// Three commands write one — `fli make:resource`, `fli web:resource` and
// `fli make:scaffold` — and until this module existed they each carried their
// own copy of it. They had already drifted in their comments, which is the
// harmless half of the drift that ends with two of them emitting a different
// FILE (Invariant 4: one owner per translation).
//
// A Resource is the model's whole client-side surface (`FJS-D114`): the data
// half in `<script module>`, which runs once at import and is what every other
// module imports, and the markup half — the model's default form (`FJS-D112`).
//
// Nothing here names a field, a type or an enum member. That is the test for
// whether a generator is generating or transcribing: everything a form needs is
// read back off the schema at runtime as `fields`, `relations` and `gate`, so a
// column added to `schema.lite` appears with no edit to the generated file.

/**
 * The whole file.
 *
 * @param {string} model    PascalCase, singular — the model name AND the filename
 * @param {string} service  the service the resource calls, usually the plural
 */
export function resourceFile(model, service) {
  return `<script module>
// src/resources/${model}.mesa — the Resource layer.
//
// A Resource is a UI-realm noun, so it is a .mesa file (repo invariant 18).
// The data half lives in <script module>, which runs once at import and whose
// named exports any other module can import. The markup below it is this
// model's default form, which is why a create page can be <${model} /> and
// nothing else.
//
// Read this next to db/schema.lite. Nothing here restates anything there: no
// field list, no types, no enum values, no required list, no relations. A
// resource names a service and turns three flags on; everything a form needs is
// read back off it at runtime as \`fields\`, \`relations\` and \`gate\`.

import { createResource } from '@frontierjs/sierra/junction'

export const ${service} = createResource('${service}', {
  // Stated rather than inferred, so an irregular plural cannot quietly resolve
  // to nothing.
  model: '${model}',

  // Every DOM control hands back a string — \`<input type="number">\` and
  // \`<select>\` included. The schema is the only thing that knows the column is
  // an Int, so it does the casting. Without this a form bound to make() sends
  // "42" for a Float and is told it is not a number.
  coerce: true,

  // An empty text box submits '', which SQLite does not agree is NULL: a
  // \`String? @unique\` column takes any number of NULLs and rejects the second
  // ''. Rewrite blanks on nullable fields on the way out.
  blankToNull: true,

  // Check the record against the schema before the request rather than
  // round-tripping to be told the same thing. The server validates regardless —
  // this only moves the first "no" closer to the user.
  validate: true,

  // The reads this model answers for its own callers, declared once here rather
  // than at every call site. Both take { query, directives }.
  //
  //   detailQuery:  { directives: { populate: ['customer'] } },   // get(id)
  //   optionsQuery: { directives: { orderBy: 'name', limit: 500 } },  // a picker
})
</script>

<script>
  // The instance half — this model's default form, and the reason a create page
  // and an edit page can be one tag with a different \`method\`.
  //
  // It names no field. <Form> reads the writable columns off the schema in
  // declaration order and gives each the control its type implies, so a column
  // added to schema.lite appears here with no edit to this file. Saving goes
  // through the resource's own save(), which creates when the record has no id
  // and patches when it has one — addressed by the model's OWN id field.
  //
  // The button row is here rather than on the pages because a form with no
  // submit is not a form. What a PAGE knows is the wording and where Cancel
  // goes, so those are props; a page needing an entirely different row — an
  // edit page with a Delete beside Save — passes an \`actions\` snippet, which
  // <Form> takes over its own slot.
  import Form   from '@frontierjs/ui/components/forms/Form.mesa'
  import Button from '@frontierjs/ui/components/forms/Button.mesa'

  export let record      = undefined   // absent → a create form seeded from the schema
  export let method      = undefined   // <Form>'s auto | create | patch
  export let submitLabel = 'Save'
  export let cancelHref  = null        // Cancel navigates…
  export let oncancel    = null        // …or calls back, for a drawer
  export let submitId    = undefined   // when something has to find the button
  export let actions     = null        // snippet — replaces the whole button row

  // Everything else — class, style, ondone, onerror, showError — rides
  // $attributes onto <Form>, which is where those props are declared.
</script>

<Form resource={${service}} bind:record={record} {method} {actions} {...$attributes}>
  <Button slot="actions" type="submit" id={submitId}>{submitLabel}</Button>
  <Button slot="actions" variant="ghost" href={cancelHref} onclick={oncancel}>Cancel</Button>
</Form>
`
}

/**
 * Model → service name. Regular English plurals only — the same three rules
 * Sierra's schema registry applies in the other direction. Irregulars are not
 * guessed anywhere in this framework; the commands take a --service flag.
 */
export function servicePlural(model) {
  const a = model.charAt(0).toLowerCase() + model.slice(1)
  if (/[^aeiou]y$/.test(a))     return a.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/.test(a)) return a + 'es'
  return a + 's'
}
