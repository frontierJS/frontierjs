// What a GENERATED CRUD page looks like, for every command that writes one.
//
// Two commands emit these pages — `fli make:scaffold` writes a vertical slice
// for one model, `fli admin:generate` writes a gate-aware admin over every
// model — and until this module existed they carried the same ~180 lines of
// form twice. They had already drifted: one filtered `id` by name, the other
// asked the resource for its idField.
//
// The pages are short because neither of them contains a form. `<Model />` IS
// the form — the markup half of the Resource, written by
// `core/resource-template.js` — so the create page and the edit page render the
// same fields and neither of them names one. That is Invariant 18, and it is
// also the second half of this module's own argument: a form written on two
// pages is a form written twice, which is exactly the drift that put these
// templates here. It shipped that way regardless, because the resource template
// grew the markup half after the pages were already writing their own `<Form>`.
//
// Under the resource, `<Form>` with no children is every writable column in
// schema order, each with the control its type implies, the picker rows for a
// foreign key fetched from the related service, the coerce/validate/blank-strip
// pass before the request, and a rejection mapped back under the field that
// caused it. What the generated file used to spell out — an `Object.entries`
// loop over `resource.fields` deciding control-per-type, a `pickers` block
// resolving a related service by guessing an English plural, an `errors` array
// and a `saving` flag — is all of it in the kit or in the resource, stated
// once. A column added to `schema.lite` still appears without regenerating.
//
// Nothing here names a field, a type or an enum member. That is the test for
// whether something belongs in this file at all.

// ─── shared pieces ────────────────────────────────────────────────────────────

const SC = '<' + '/script>'

const KIT = {
  alert:   `import Alert         from '@frontierjs/ui/components/feedback/Alert.mesa'`,
  button:  `import Button        from '@frontierjs/ui/components/forms/Button.mesa'`,
  header:  `import SectionHeader from '@frontierjs/ui/components/display/SectionHeader.mesa'`,
  spinner: `import Spinner       from '@frontierjs/ui/components/feedback/Spinner.mesa'`,
  table:   `import Table         from '@frontierjs/ui/components/display/Table.mesa'`,
}

// The id column is asked for rather than assumed: `@id` may be on any column,
// and a model keyed by anything else is the case where a hardcoded `id` creates
// a duplicate row instead of editing one (`FJS-316`).
const idFieldLine = (res) => `  const idField = ${res}.context.idField`

/** The gate notice — admin pages only. A refusal belongs to the server, so the
 *  button is NOT disabled; this says what will come back and why. */
function gateNotice(res, op) {
  return `{#if !${res}.can('${op}', session.level)}
  <Alert tone="warning">
    <code>@@gate</code> wants level {${res}.gate?.${op}} and this session reports
    {session.level}, so this will come back 401. The button is deliberately not
    disabled — the server is the thing that decides.
  </Alert>
{/if}

`
}

// ─── list ────────────────────────────────────────────────────────────────────

/**
 * @param {object}   o
 * @param {string}   o.title           frontmatter title
 * @param {string}   o.heading         <h1> text
 * @param {string}   o.newLabel        label on the create button
 * @param {string}   o.basePath        '/users/' — where this model's pages live
 * @param {string[]} o.imports         lines that bring the resource into scope
 * @param {string}   o.res             the resource expression in that scope
 * @param {{key:string,label:string}[]} [o.columns]  named at generate time
 * @param {boolean}  [o.deriveColumns] take the first few off the schema instead
 * @param {boolean}  [o.rowDelete]     a delete button per row
 * @param {boolean}  [o.gate]          grade the buttons against the session
 * @param {string}   [o.sessionImport] required when `gate` is set
 */
export function listPage(o) {
  // Two ways to answer "which columns", and both are a judgement being made
  // somewhere: named here, in a file a person edits, or taken off the schema in
  // order for an admin that has to cover every model without being written per
  // model. Everything after this point is the same page.
  const fields = o.deriveColumns
    ? `  // The one choice in this file that is not a consequence of the schema:
  // how many columns fit. Reorder or extend — the names come from the schema
  // either way.
  const fields = [
    { key: idField, label: idField },
    ...Object.keys(${o.res}.fields)
      .filter(f => f !== idField)
      .slice(0, 5)
      .map(f => ({ key: f, label: f })),
  ]`
    : `  // Which of a model's columns belong in a table is a judgement, and this is
  // the file to make it in — the form pages derive their fields, this one does
  // not. \`label\` is what the header shows; \`key\` is read off the record.
  const fields = [
${(o.columns ?? []).map(c => `    { key: '${c.key}', label: '${c.label}' },`).join('\n')}
  ]`

  const session = o.sessionImport ? `  ${o.sessionImport}\n` : ''

  const gateState = o.gate
    ? `
  // A @@gate answer is a UI affordance and never a boundary — the server
  // refuses regardless of what this says.
  $: canCreate = ${o.res}.can('create', session.level)
  $: canDelete = ${o.res}.can('delete', session.level)
`
    : ''

  const removeFn = o.rowDelete
    ? `
  let busy = null

  async function remove(id) {
    if (!confirm('Delete ' + id + '?')) return
    error = null
    busy  = id
    try { await ${o.res}.service.remove(id) }
    catch (e) { error = e.message }
    finally { busy = null }
  }
`
    : ''

  const newButton = o.gate
    ? `<Button href="${o.basePath}create/" disabled={!canCreate}>${o.newLabel}</Button>`
    : `<Button href="${o.basePath}create/">${o.newLabel}</Button>`

  const rowDelete = o.rowDelete
    ? `
        <Button
          variant="ghost"
          tone="danger"
          size="sm"
          disabled={${o.gate ? '!canDelete || ' : ''}busy === record[idField]}
          onclick={() => remove(record[idField])}
        >Delete</Button>`
    : ''

  const gateFootnote = o.gate
    ? `
{#if !canDelete}
  <p class="text-sm text-muted">
    Delete needs gate level {${o.res}.gate?.delete} and this session reports
    {session.level}.
  </p>
{/if}
`
    : ''

  return `---
title: ${o.title}
---
<script>
${o.imports.map(l => '  ' + l).join('\n')}
  import { useStore } from '@frontierjs/sierra/junction'
${session}
  ${KIT.alert}
  ${KIT.button}
  ${KIT.header}
  ${KIT.table}

${idFieldLine(o.res)}

  const { get: rows, unsubscribe } = useStore(${o.res}.store)
  $.onDestroy(unsubscribe)

${fields}

  const columns = [...fields, { key: '_actions', label: '' }]

  let error = null

  ${o.res}.load().catch(e => { error = e.message })
${gateState}${removeFn}
  // A cell is rendered rather than interpolated: \`null\` reads as an empty box,
  // a boolean as \`true\`, and a Json column as \`[object Object]\`.
  function cell(record, name) {
    const v = record[name]
    if (v === null || v === undefined) return '—'
    if (typeof v === 'boolean') return v ? 'yes' : 'no'
    if (typeof v === 'object')  return JSON.stringify(v)
    return String(v)
  }
${SC}

<SectionHeader title="${o.heading}" level={1}>
  {#snippet action()}
    ${newButton}
  {/snippet}
</SectionHeader>

{#if error}<Alert tone="danger">{error}</Alert>{/if}

<Table {columns} rows={rows()} striped hover emptyText="Nothing here yet.">
  {#snippet row(record)}
    <tr>
      {#each fields as c}<td>{cell(record, c.key)}</td>{/each}
      <td class="cluster">
        <Button variant="link" href={'${o.basePath}' + record[idField] + '/'}>Open</Button>${rowDelete}
      </td>
    </tr>
  {/snippet}
</Table>
${gateFootnote}`
}

// ─── create ───────────────────────────────────────────────────────────────────

/**
 * @param {object}  o                  as listPage, plus:
 * @param {string}  o.form             the Resource component's tag — the default
 *                                     form, imported by o.imports
 * @param {string}  o.submitLabel      label on the submit button
 * @param {string}  o.backLabel        label on the "back to list" button
 * @param {boolean} [o.gate]           render the gate notice
 */
export function createPage(o) {
  const session = o.sessionImport ? `  ${o.sessionImport}\n` : ''
  const watch   = o.gate ? '\n  $: session.level\n' : ''

  return `---
title: ${o.title}
---
<script>
  // There is no form in this file, and no field name, type, enum value,
  // required flag or control choice either. <${o.form} /> IS the form — the
  // markup half of the Resource — so a create page and an edit page render the
  // same fields and neither of them says what the fields are (Invariant 18).
  //
  // What a page decides is what a page knows: the wording on the button, where
  // Cancel leads, and where a save goes afterwards.
${o.imports.map(l => '  ' + l).join('\n')}
  import { goto } from '@frontierjs/sierra/router'
${session}
${o.gate ? '  ' + KIT.alert + '\n' : ''}  ${KIT.button}
  ${KIT.header}

${idFieldLine(o.res)}${watch}
${SC}

<SectionHeader title="${o.heading}" level={1}>
  {#snippet action()}
    <Button variant="ghost" href="${o.basePath}">${o.backLabel}</Button>
  {/snippet}
</SectionHeader>

${o.gate ? gateNotice(o.res, 'create') : ''}<${o.form}
  class="card"
  style="max-width: 32rem"
  method="create"
  submitLabel="${o.submitLabel}"
  cancelHref="${o.basePath}"
  ondone={(created) => goto('${o.basePath}' + created[idField] + '/')}
/>
`
}

// ─── edit ─────────────────────────────────────────────────────────────────────

/**
 * Detail and edit are one page: a form over a loaded record IS the detail view.
 *
 * @param {object} o   as createPage, plus:
 * @param {string} o.deleteLabel
 */
export function editPage(o) {
  const session = o.sessionImport ? `  ${o.sessionImport}\n` : ''
  const watch   = o.gate ? '\n  $: session.level\n' : ''

  return `---
title: ${o.title}
---
<script>
${o.imports.map(l => '  ' + l).join('\n')}
  import { page, goto } from '@frontierjs/sierra/router'
${session}
  ${KIT.alert}
  ${KIT.button}
  ${KIT.header}
  ${KIT.spinner}

${idFieldLine(o.res)}${watch}

  // Read once at setup: navigating to a different id remounts the component.
  const id = page.params.id

  // \`null\` until it arrives, and <Form> is not rendered before then — it seeds
  // its baseline from the record it is given, so handing it a blank now and the
  // row later would make every field look edited.
  let record   = null
  let failed   = null
  let deleting = false

  ${o.res}.service.get(id)
    .then(row => { record = row })
    .catch(e => { failed = e.message })

  async function remove() {
    if (!confirm('Delete ' + id + '?')) return
    failed   = null
    deleting = true
    try {
      await ${o.res}.service.remove(id)
      goto('${o.basePath}')
    } catch (e) {
      failed   = e.message
      deleting = false
    }
  }
${SC}

<SectionHeader title={'${o.heading} ' + id} level={1}>
  {#snippet action()}
    <Button variant="ghost" href="${o.basePath}">${o.backLabel}</Button>
  {/snippet}
</SectionHeader>

{#if failed}<Alert tone="danger">{failed}</Alert>{/if}

${o.gate ? gateNotice(o.res, 'patch') : ''}{#if record}
  <!-- The same <${o.form} /> the create page renders, and that is the point:
       the fields are the model's, so they are written down once. \`method\` is
       left at 'auto' — the record carries an id, so this saves as a patch, and
       an absent field means "leave it alone" rather than "clear it".

       This row is not the default one (Save + Cancel), so it is passed as an
       \`actions\` snippet, which <Form> takes over its own slot. Delete carries
       its own \`loading\`; submit does not need one, because a type="submit"
       button inside <Form> reads the form's in-flight state from context. -->
  <${o.form} bind:record class="card" style="max-width: 32rem">
    {#snippet actions()}
      <Button type="submit">${o.submitLabel}</Button>
      <Button
        tone="danger"
        variant="outlined"
        loading={deleting}
        onclick={remove}
      >${o.deleteLabel}</Button>
    {/snippet}
  </${o.form}>
{:else if !failed}
  <Spinner label="Loading" />
{/if}
`
}
