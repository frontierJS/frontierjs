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

import { frontmatterValue } from './compiler.js'

const SC = '<' + '/script>'

const KIT = {
  alert:   `import Alert         from '@frontierjs/ui/components/feedback/Alert.mesa'`,
  button:  `import Button        from '@frontierjs/ui/components/forms/Button.mesa'`,
  header:  `import SectionHeader from '@frontierjs/ui/components/display/SectionHeader.mesa'`,
  spinner: `import Spinner       from '@frontierjs/ui/components/feedback/Spinner.mesa'`,
  table:   `import Table         from '@frontierjs/ui/components/display/Table.mesa'`,
  cell:    `import Cell          from '@frontierjs/ui/components/display/Cell.mesa'`,
  filters: `import FilterBar     from '@frontierjs/ui/components/display/FilterBar.mesa'`,
}

// The id column is asked for rather than assumed: `@id` may be on any column,
// and a model keyed by anything else is the case where a hardcoded `id` creates
// a duplicate row instead of editing one (`FJS-316`).
const idFieldLine = (res) => `  const idField = ${res}.context.idField`

// A page with moves needs a level to grade them against. The admin hands over
// its own session module; a scaffold has none, and sierra's session is what a
// sign-in fills -- 0 for a stranger, null where the server publishes no level,
// which `transitions()` reads as permissive.
const SIERRA_SESSION = `import { session } from '@frontierjs/sierra/resource'`
const sessionLine = (o) => `  ${o.sessionImport ?? SIERRA_SESSION}\n`

// The moves a row may make, one button each, read off `@@transitions` when the
// page RUNS -- this file names no machine, no state and no move. A model with
// none draws nothing. A @system move is the application's, so no caller gets a
// button for it; a gated move this level cannot make is drawn disabled, and the
// server grades every one regardless (Invariant 6).
//
// mutate() rather than a bare invoke: a custom method's answer is not written
// into the row's node, so over HTTP with no socket a bare invoke leaves every
// view of the row in its old state. mutate() shows the new state at once,
// settles it with the row the move answers, and a refusal puts it back.
function moveScript(o, error) {
  return `
  // The moves this row's state allows, as the schema's @@transitions declares
  // them -- a model with no machine answers none and draws nothing.
  const movesOf = (rec) => ${o.res}.transitions(rec, session.level).filter(t => !t.system)

  let moving = null

  async function move(rec, t) {
    const key = rec[idField]
    ${error} = null
    moving = key
    try { await ${o.res}.mutate(key, { [t.field]: t.to }, () => ${o.res}.service.invoke(t.name, key)) }
    catch (e) { ${error} = e.message }
    finally { moving = null }
  }
`
}

const moveButtons = (indent, row, busy) => `{#each movesOf(${row}) as t (t.name)}
${indent}  <Button
${indent}    variant="outlined"
${indent}    size="sm"
${indent}    data-move={t.name}
${indent}    disabled={!t.allowed || ${busy}}
${indent}    title={t.allowed ? undefined : 'Needs gate level ' + t.gate}
${indent}    onclick={() => move(${row}, t)}
${indent}  >{t.label}</Button>
${indent}{/each}`

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
 * @param {string[]} [o.only]      pin the column set instead of ranking it
 * @param {boolean}  [o.rowDelete]     a delete button per row
 * @param {boolean}  [o.gate]          grade the buttons against the session
 * @param {string}   [o.sessionImport] required when `gate` is set
 */
export function listPage(o) {
  // WHICH COLUMNS is asked of the resource, which is the one place that can
  // answer it: `columns()` ranks the read schema — the column that NAMES the
  // row, then the business key the seed declares as `x-identify`, then a bound
  // enum, then money and time — and reports everything it left out.
  //
  // This used to be two branches and both were a judgement made in the wrong
  // place. One took `Object.keys(fields).slice(0, 5)`, described in this file
  // as the one choice in it that is not a consequence of the schema — and under
  // row tenancy it led every table with the tenant column, which holds the same
  // value in every row on screen. The other named the columns at generate time,
  // which froze them at the moment the file was written.
  const only = Array.isArray(o.only) && o.only.length
    ? `{ only: ${JSON.stringify(o.only)} }`
    : ''

  const session = sessionLine(o)

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
title: ${frontmatterValue(o.title)}
---
<script>
${o.imports.map(l => '  ' + l).join('\n')}
${session}
  ${KIT.alert}
  ${KIT.button}
  ${KIT.header}
  ${KIT.table}
  ${KIT.cell}
  ${KIT.filters}

${idFieldLine(o.res)}

  // Ranked from the schema, with the header text taken from each column's
  // declared label where it has one. To pin the set instead, name them:
  // columns({ only: ['a', 'b'] }).
  //
  // omitted is every column this table does NOT show, each with the reason, so
  // a column added to the schema that does not appear here is answerable
  // without reading this file.
  const { columns: cols, omitted } = ${o.res}.columns(${only})

  // A header is sortable where the SCHEMA says the column can be ordered by —
  // x-sortable is emitted only as an exception, so absent means yes and a
  // string says why not. Offering one the Data boundary refuses is a header
  // that throws on click, which is the one thing a generated table must not do.
  const columns = [
    ...cols,
    { name: '_actions', label: 'Actions', hideLabel: true },
  ]

  // Which columns a bar may offer, with which question, and whether the model
  // answers a search at all -- a search box is drawn only where the schema
  // declares the full-text index, since below one the Data boundary refuses.
  // Same ranking as the table, so the filters are over the columns you can see.
  const { filters, search } = ${o.res}.filters()

  // ── The list ─────────────────────────────────────────────────────────────
  //
  // list() owns what this page used to wire by hand: the store, the load, its
  // re-run when the filters change, and the window. The URL is the state -- a
  // filtered list is a LINK, copied, bookmarked and survived by the back button
  // -- so apply() and sort() navigate and the change comes back through the
  // router. The resource file's listQuery is what it starts on, and a page
  // wanting a different default passes directives: { orderBy: '...' } here.
  //
  // The bar is handed BOTH halves, because it hands back the whole query it
  // holds: given the filters alone, the first keystroke in a filter box would
  // drop the sort a header just set. The table is handed the same orderBy the
  // load sends, or it is sorted with no arrow and its header never reverses.
  const list = ${o.res}.list()

  let error = null

  $: session.level
${moveScript(o, 'error')}${gateState}${removeFn}${SC}

<div class="stack">
<SectionHeader title="${o.heading}" level={1}>
  {#snippet action()}
    ${newButton}
  {/snippet}
</SectionHeader>

{#if error}<Alert tone="danger">{error}</Alert>{/if}
{#if list.error}<Alert tone="danger">{list.error.message}</Alert>{/if}

<FilterBar {filters} {search} value={list.query} directives={list.directives} onchange={list.apply} />

<Table {columns} rows={list.rows} orderBy={list.directives.orderBy} loading={list.loading && !list.rows.length}
       striped hover emptyText="Nothing here yet." onsort={list.sort}>
  {#snippet row(record)}
    <tr>
      {#each cols as c}<td><Cell value={record[c.name]} column={c} {record} /></td>{/each}
      <td class="cluster">
        <Button variant="link" href={'${o.basePath}' + record[idField] + '/'}>Open</Button>
        ${moveButtons('        ', 'record', 'moving === record[idField]')}${rowDelete}
      </td>
    </tr>
  {/snippet}
</Table>

<!-- A keyset window: rows written while somebody reads are neither skipped
     nor served twice, which an offset cannot promise. -->
{#if list.hasMore}
  <Button variant="ghost" onclick={list.more}>Load more</Button>
{/if}

{#if omitted.length}
  <p class="text-sm text-muted">
    Not shown: {omitted.map(o => o.name).join(', ')} — each with a reason, so a
    column added to the schema that does not appear here is answerable without
    reading this page.
  </p>
{/if}
${gateFootnote}
</div>
`
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
title: ${frontmatterValue(o.title)}
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

<div class="stack">
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
</div>
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
  const session = sessionLine(o)
  const watch   = '\n  $: session.level\n'

  // A child link needs the ROUTE its model landed on, and that is the one thing
  // this page cannot derive: a child knows its model and its foreign key, and
  // only the command writing the folders knows where they went. So the caller
  // hands over an import of the map it wrote — one module, imported by every
  // detail page, because thirty-two inlined copies of one map is the same
  // written-twice failure this file exists to end. No import, no children
  // section: a scaffold writes one model and has nowhere to link.
  const kids = o.childRoutesImport
    ? {
        imp: `  ${o.childRoutesImport}\n`,
        script: `
  // The child collections, each a link into that model's own list filtered by
  // this row. A nested table is the richer answer and it is a judgement per
  // screen; a link is the one that is right without knowing the model, it costs
  // no second query on a page nobody asked one of, and because the list reads
  // its query off the URL the link IS the filter — copied, bookmarked, and
  // survived by the back button.
  //
  // A child whose model this admin did not write has no route to point at and
  // is left out rather than linked into a 404.
  const children = ${o.res}.children()
    .filter(c => c.foreignKey && childRoutes[c.model])
    .map(c => ({ ...c, href: childRoutes[c.model] + '?' + c.foreignKey + '=' + id }))
`,
        markup: `{#if record && children.length}
  <p class="cluster">
    {#each children as c}
      <Button variant="link" href={c.href}>{c.field}</Button>
    {/each}
  </p>
{/if}

`,
      }
    : { imp: '', script: '', markup: '' }

  return `---
title: ${frontmatterValue(o.title)}
---
<script>
${o.imports.map(l => '  ' + l).join('\n')}
  import { page, goto } from '@frontierjs/sierra/router'
${session}
  ${KIT.alert}
  ${KIT.button}
  ${KIT.header}
  ${KIT.spinner}
  ${KIT.cell}
${kids.imp}

${idFieldLine(o.res)}${watch}

  // Read once at setup: navigating to a different id remounts the component.
  const id = page.params.id

  // null until it arrives, and <Form> is not rendered before then — it seeds
  // its baseline from the record it is given, so handing it a blank now and the
  // row later would make every field look edited.
  let record   = null
  let failed   = null
  let deleting = false

  // The read FINISHED, whatever it found. Without it the spinner is drawn from
  // record == null, which cannot tell "still loading" from "the read came back
  // with nothing" — so a row that does not exist, and one this caller may not
  // read, both spin forever with nothing said.
  let loaded   = false

  // WATCHED, not fetched once. service.get() is the raw proxy and answers a
  // plain object, so a write from another tab, a job or a webhook reaches the
  // store and never this screen — which looks correct the whole time, because a
  // screen re-reads after its OWN actions and never after anyone else's
  // (FJS-533). record() subscribes to the same node the list is a view over.
  //
  // Where this service's get() answers MORE than the row — an include, a count
  // assembled per call — declare it: record(id, { composed: true }), or the
  // first announcement drops the children.
  // The handle is a let ASSIGNED rather than a const initialized, and that is
  // the whole difference between this screen working and a spinner forever: a
  // const whose initializer CALLS a local binding is a lazy derivation
  // (FJS-D212), nothing reads unwatch until $.onDestroy, so the subscribe
  // never ran and record stayed null with nothing reporting a problem.
  // Every hand-written detail screen in this repo writes it this way.
  let unwatch   = null
  const row     = ${o.res}.record(id)
  unwatch = row.subscribe(v => { record = v })

  // ready RESOLVES with null for a refusal and for a row that is not there —
  // record() swallows the response so a .catch alone never fires. row.error()
  // holds the reason: 404 is a row that is not there, 403 a refusal, 0 no answer.
  row.ready
    .then(v => {
      if (v != null || failed) return
      const why = row.error()?.status
      failed = why === 404 ? id + ' was not found.'
        : why === 403 || why === 401 ? 'You do not have access to ' + id + '.'
        : 'Could not load ' + id + '.'
    })
    .catch(e => { failed = e.message })
    .finally(() => { loaded = true })

  $.onDestroy(() => { unwatch?.(); row.release?.() })

  // What the FORM cannot show, which is most of what a person opens a record
  // to read: a computed total, a generated name, a system timestamp, the
  // version. A form shows what is WRITABLE, so all of that is missing from one
  // by rule — this is the surface controlFor names when it refuses a value for
  // being the server's.
  const { columns: facts } = ${o.res}.summary()
${moveScript(o, 'failed')}${kids.script}
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

<div class="stack">
<SectionHeader title={'${o.heading} ' + id} level={1}>
  {#snippet action()}
    <Button variant="ghost" href="${o.basePath}">${o.backLabel}</Button>
  {/snippet}
</SectionHeader>

{#if failed}<Alert tone="danger">{failed}</Alert>{/if}

${o.gate ? gateNotice(o.res, 'patch') : ''}{#if record && facts.length}
  <dl class="facts">
    {#each facts as c}
      <div>
        <dt>{c.label}</dt>
        <dd><Cell value={record[c.name]} column={c} {record} /></dd>
      </div>
    {/each}
  </dl>
{/if}

{#if record && movesOf(record).length}
  <p class="cluster">
    ${moveButtons('    ', 'record', 'moving != null')}
  </p>
{/if}

${kids.markup}{#if record}
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
{:else if !loaded}
  <Spinner label="Loading" />
{/if}
</div>
`
}

// ─── one page, from a route path ──────────────────────────────────────────────

/**
 * The URL segment Sierra serves a route directory at. Its scanner lowercases a
 * static segment, so a link naming `searchIndexes/` as written lands on the 404
 * for every two-word model (`FJS-1821`). Every generated link to a generated
 * directory goes through this.
 */
export const routeSegment = (dir) => dir.toLowerCase()

/**
 * The layout with a link to a generated list page in its main nav, the layout
 * unchanged where the nav already links it, or null where it has no
 * `<nav aria-label="Main">` to put one in. make:scaffold used to end on *Add a
 * nav link to your layout* and nothing added one, so in 0 of 21 generated apps
 * did the page after sign-up reach a model's list (`FJS-1808`).
 *
 * A layout that signs people in draws the link under `{#if session.user}`, as
 * `fli new` draws its Users link: a nav offering a stranger a page that answers
 * *Authentication required* reads as a broken app.
 *
 * The href and the label are the list page's own, so the link and the heading
 * it opens on say the same thing.
 *
 * @param {string} layout   the `_module.mesa` text
 * @param {string} service  the list's route directory, `searchIndexes`
 * @returns {string|null}
 */
export function withNavLink(layout, service) {
  const href  = `/${routeSegment(service)}/`
  const label = labelOf(service)
  const open = /<nav\b[^>]*\baria-label="Main"[^>]*>/.exec(layout)
  const close = open ? layout.indexOf('</nav>', open.index) : -1
  if (close < 0) return null
  if (layout.slice(open.index, close).includes(`href="${href}"`)) return layout

  const lineStart = layout.lastIndexOf('\n', close) + 1
  const outer = layout.slice(lineStart, close)
  if (outer.trim()) return null
  const inner = outer + '  '
  // `aria-current` only where the layout already reads the route, since a
  // reference to an import it does not hold would stop it compiling.
  const current = layout.includes('isActive(') && layout.includes('page.route')
    ? ` aria-current={(page.route, isActive('${href}')) ? 'page' : null}` : ''
  const a = `<a class="navlink" href="${href}"${current}>${label}</a>`
  const lines = layout.includes('session.user')
    ? [`${inner}{#if session.user}`, `${inner}  ${a}`, `${inner}{/if}`]
    : [`${inner}${a}`]
  return layout.slice(0, lineStart) + lines.join('\n') + '\n' + layout.slice(lineStart)
}

const labelOf = (name) => name
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]/g, ' ')
  .replace(/\b\w/g, c => c.toUpperCase())
  .trim()

/**
 * The page `fli make:route <path> --resource <Model>` writes. The path's last
 * segment says which of the three pages `make:scaffold` lays out it is: `[id]`
 * the detail page, `create` the create page, anything else the list. One page
 * written for all three rendered a list under a detail route's heading and no
 * form on a create route (`FJS-1261`).
 *
 * The list is written as `<path>/index.mesa`, never `<path>.mesa`: the detail
 * and create routes that follow it live in `<path>/`, and a file and a
 * directory of one name are a route conflict the build refuses.
 *
 * @param {object} o
 * @param {string} o.path     route path under src/routes/, no extension
 * @param {string} o.model    PascalCase model name — the resource file
 * @param {string} o.service  the resource's export
 * @returns {{ file: string, kind: 'list'|'create'|'detail', content: string } | { error: string }}
 *          `file` is relative to src/routes/
 */
export function resourceRoutePage({ path, model, service }) {
  const segs = path.split('/')
  const last = segs[segs.length - 1]

  const kind = last === '[id]'  ? 'detail'
             : last === 'create' ? 'create'
             : /^\[.+\]$/.test(last) ? null
             : 'list'
  // editPage reads page.params.id, so a detail route keyed by any other name
  // would render every page with an undefined id.
  if (!kind) return { error: `a detail page is keyed [id] — ${last} is not a param it reads` }

  const listDir = kind === 'list'
    ? (last === 'index' ? segs.slice(0, -1) : segs)
    : segs.slice(0, -1)
  const file = kind === 'list' ? [...listDir, 'index.mesa'].join('/') : path + '.mesa'

  const up       = '../'.repeat(file.split('/').length)
  const imports  = [
    `import ${model} from '${up}resources/${model}.mesa'`,
    `import { ${service} } from '${up}resources/${model}.mesa'`,
  ]
  const basePath = '/' + listDir.map(s => routeSegment(s) + '/').join('')
  const one      = labelOf(model)
  const many     = labelOf(service)
  const shared   = { basePath, imports, res: service, form: model }

  const content = kind === 'list'
    ? listPage({ ...shared, title: many, heading: many, newLabel: `New ${one}` })
    : kind === 'create'
    ? createPage({ ...shared, title: `New ${one}`, heading: `New ${one}`,
        submitLabel: `Create ${one}`, backLabel: 'Back to list' })
    : editPage({ ...shared, title: one, heading: one, submitLabel: 'Save',
        backLabel: `All ${many.toLowerCase()}`, deleteLabel: 'Delete' })

  return { file, kind, content }
}
