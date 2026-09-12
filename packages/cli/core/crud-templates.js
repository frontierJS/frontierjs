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
  cell:    `import Cell          from '@frontierjs/ui/components/display/Cell.mesa'`,
  filters: `import FilterBar     from '@frontierjs/ui/components/display/FilterBar.mesa'`,
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
  import { page, goto } from '@frontierjs/sierra/router'
  import { directiveParams } from '@frontierjs/toolbelt/directives'
${session}
  ${KIT.alert}
  ${KIT.button}
  ${KIT.header}
  ${KIT.table}
  ${KIT.cell}
  ${KIT.filters}

${idFieldLine(o.res)}

  const { get: rows, unsubscribe } = useStore(${o.res}.store)
  $.onDestroy(unsubscribe)

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
    ...cols.map(c => ({ key: c.name, label: c.label, sortable: c.sortable })),
    { key: '_actions', label: '' },
  ]

  // Which columns a bar may offer, with which question, and whether the model
  // answers a search at all -- a search box is drawn only where the schema
  // declares the full-text index, since below one the Data boundary refuses.
  // Same ranking as the table, so the filters are over the columns you can see.
  const { filters, search } = ${o.res}.filters()

  // The URL's whole query, put back together.
  //
  // splitParams takes every prefixed key OUT of page.query and into
  // page.directives under an unprefixed name (Invariant 10), so page.query
  // alone is the filters and nothing else. A bar handed that has no sort, no
  // page size and no search to show -- and, worse, hands back a query missing
  // them, so typing in a filter box silently drops the sort a header just set.
  // directiveParams is parseDirectives' inverse off the same table, so this
  // cannot go stale when a directive is added.
  // Naming them in a bare $: marks page a WATCHED import, which is what the
  // const below needs to be a derivation rather than a value read once at
  // setup. The handler form further down does it in the CURRENT compiler and
  // not in the one an installed app has (FJS-1065 is fixed in the tree and
  // unpublished), and a scaffold is graded by what npm serves: without this
  // line the filter bar merges each new filter over the query the page ARRIVED
  // with, so every filter appears to replace the last. app-config pins mesa at
  // 'latest', so this line comes out on the release that publishes the fix and
  // not before.
  $: (page.query, page.directives)

  const urlQuery = { ...page.query, ...directiveParams(page.directives) }

  // Sort and filter both live in the URL (Invariant 10), so this page writes
  // the query and lets the router bring it back — which is what makes a
  // filtered, sorted list a LINK rather than a state somebody has to recreate.
  // Two-arg goto, and the path is stripped of its own query first. Both halves
  // are load-bearing. Concatenating instead — goto(page.path + encoded) — hands
  // the router one string, and page.path ALREADY carries the search, so the
  // second filter builds /notes/?a=1?b=2 and the first one navigated to a URL
  // whose query the builder dropped on the floor (FJS-1064). Passing the query
  // as the argument makes it REPLACE rather than merge, which is what Clear
  // needs: an empty query over a bare path is a bare path.
  function apply(query) {
    goto(page.path.split('?')[0], query)
  }

  function sortBy(key, dir) {
    apply({ ...urlQuery, $orderBy: { [key]: dir } })
  }

  // The header reads back the SAME directive the load does. Without the pair
  // below, the table is sorted and nothing on it says so: no arrow, and
  // aria-sort answers none on every header. Worse, the toggle stops inverting
  // -- <Table> derives the NEXT direction from the sortKey it was handed, so a
  // column already descending in the URL is re-sent ascending on the next
  // click and the header never reverses.
  //
  // A string, an object and an array of objects are all legal orderBys and the
  // directive table deliberately does not fix one, so all three are read here.
  const ordering   = page.directives?.orderBy
  const firstOrder = Array.isArray(ordering) ? ordering[0] : ordering
  const sortKey    = typeof firstOrder === 'string'
    ? firstOrder.replace(/^-/, '')
    : Object.keys(firstOrder ?? {})[0] ?? ''
  const sortDir    = typeof firstOrder === 'string'
    ? (firstOrder.startsWith('-') ? 'desc' : 'asc')
    : Object.values(firstOrder ?? {})[0] ?? 'asc'

  let error = null

  // The filter lives in the URL (Invariant 10): page.query is the filters and
  // page.directives the $limit / $offset / $orderBy, split by the same module
  // the bridge reads a request with. So a filtered list is a LINK — copied,
  // bookmarked, and survived by the back button — and a detail screen can point
  // at its own child rows without this page knowing anything about them.
  function load() {
    ${o.res}.load(page.query, page.directives).catch(e => { error = e.message })
  }

  load()

  // The $: line is what makes the filter bar and the sort headers DO anything.
  // apply() navigates to the same route with a different query, and the router
  // does not remount for that — it moves page.query and page.directives and
  // expects the page to be watching them. Without this line the load above runs
  // once at setup and never again: the URL changes, the bar redraws from it,
  // and no request is ever made, so every filter and every sort is a no-op that
  // looks like a working control. It is also what marks page a watched import,
  // which is what makes urlQuery above a derivation rather than a value read
  // once -- move load() into a plain effect and the bar goes back to rendering
  // the query this page arrived with.
  $: page.query, page.directives, () => load()
${gateState}${removeFn}${SC}

<SectionHeader title="${o.heading}" level={1}>
  {#snippet action()}
    ${newButton}
  {/snippet}
</SectionHeader>

{#if error}<Alert tone="danger">{error}</Alert>{/if}

<FilterBar {filters} {search} value={urlQuery} onchange={apply} />

<Table {columns} rows={rows()} {sortKey} {sortDir} striped hover
       emptyText="Nothing here yet." onsort={sortBy}>
  {#snippet row(record)}
    <tr>
      {#each cols as c}<td><Cell value={record[c.name]} column={c} {record} /></td>{/each}
      <td class="cluster">
        <Button variant="link" href={'${o.basePath}' + record[idField] + '/'}>Open</Button>${rowDelete}
      </td>
    </tr>
  {/snippet}
</Table>

{#if omitted.length}
  <p class="text-sm text-muted">
    Not shown: {omitted.map(o => o.name).join(', ')} — each with a reason, so a
    column added to the schema that does not appear here is answerable without
    reading this page.
  </p>
{/if}
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
  // record() swallows the response so a .catch alone never fires. The reason is
  // gone by the time it gets here, which is why one sentence covers both.
  row.ready
    .then(v => { if (v == null && !failed) failed = 'Could not load ' + id + ' — it may not exist, or you may not have access to it.' })
    .catch(e => { failed = e.message })
    .finally(() => { loaded = true })

  $.onDestroy(() => { unwatch?.(); row.release?.() })

  // What the FORM cannot show, which is most of what a person opens a record
  // to read: a computed total, a generated name, a system timestamp, the
  // version. A form shows what is WRITABLE, so all of that is missing from one
  // by rule — this is the surface controlFor names when it refuses a value for
  // being the server's.
  const { columns: facts } = ${o.res}.summary()
${kids.script}
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
`
}
