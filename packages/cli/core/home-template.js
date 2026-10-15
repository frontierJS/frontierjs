// core/home-template.js — the page `fli make:home` writes at web/src/routes/index.mesa.
//
// `fli new` lands a person on the tour of the language, and nothing replaced
// it: an app with seven models and a nav to each still opened on "Mesa in a
// minute". The home of a built app is what the app is FOR — what it does, where
// its work stands, and the way into each part of it.
//
// What is fixed at generate time is only what the file system answers: which
// models have a Resource and a list page, in the order the schema declares
// them. Everything about a model — its state machine, its states and their
// labels, which columns name a row — is asked of the Resource when the page
// runs, the way the list pages ask `columns()`. A state added to an enum, or a
// `@@transitions` added to a model, shows up here on the next reload without
// regenerating.

import { frontmatterValue } from './compiler.js'

const SC = '<' + '/script>'

export const labelOf = (name) => name
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]/g, ' ')
  .replace(/\b\w/g, c => c.toUpperCase())
  .trim()

// A file the tour wrote and nobody has touched is what this replaces; a home
// page somebody wrote is theirs. The marker is the tour's own section comment.
export const isStarterHome = (src) => /─── the tour ─/.test(src)

/**
 * @param {object}   o
 * @param {string}   o.title    the app's name, as a person would say it
 * @param {string}  [o.summary] one or two sentences: what the app is for
 * @param {{ model: string, service: string, href: string }[]} o.areas
 *        each model with a Resource and a list page, in schema order
 * @param {boolean} [o.register] the app has a /register/ page
 * @returns {string}
 */
export function homePage(o) {
  const imports = o.areas
    .map(a => `  import { ${a.service} } from '@/resources/${a.model}.mesa'`)
    .join('\n')

  const areas = o.areas
    .map(a => `    { resource: ${a.service}, href: '${a.href}', label: ${JSON.stringify(labelOf(a.service))}, one: ${JSON.stringify(labelOf(a.model))} },`)
    .join('\n')

  const join = o.register
    ? `\n      <Button variant="outlined" href="/register/">Create an account</Button>`
    : ''

  return `---
title: ${frontmatterValue(o.title)}
---
<script>
  // Written by \`fli make:home\`. Edit freely: it is not regenerated over, and
  // \`fli make:home --force\` is the only thing that replaces it.
  import { session } from '@frontierjs/sierra/resource'
  import Button        from '@frontierjs/ui/components/forms/Button.mesa'
  import SectionHeader from '@frontierjs/ui/components/display/SectionHeader.mesa'
  import StatCard      from '@frontierjs/ui/components/display/StatCard.mesa'
  import Table         from '@frontierjs/ui/components/display/Table.mesa'
  import Cell          from '@frontierjs/ui/components/display/Cell.mesa'
${imports}

  const title   = ${JSON.stringify(o.title)}
  const summary = ${JSON.stringify(o.summary ?? '')}

  // Every model with a list page, in the order the schema declares them — the
  // same pages the nav links.
  const areas = [
${areas}
  ]

  // A model's working states are its \`@@transitions\` column, read off the
  // Resource rather than written here: the members in the order the enum
  // declares them, each with its @label where it has one.
  const humanize = (s) => String(s).replace(/[_-]+/g, ' ').replace(/^\\w/, c => c.toUpperCase())

  function machineOf(resource) {
    for (const [field, rule] of Object.entries(resource.fields ?? {})) {
      if (!rule?.transitions) continue
      const states = rule.options ?? (rule.enum ?? []).map(value => ({ value, label: humanize(value) }))
      return { field, label: (rule.label ?? humanize(field)).toLowerCase(), states }
    }
    return null
  }

  const flows = areas
    .map(a => ({ ...a, machine: machineOf(a.resource) }))
    .filter(a => a.machine && a.machine.states.length)

  // The rows a person comes back for: the first model with a lifecycle, the
  // working row — and with none, the first model that is not the people.
  const focus = flows[0] ?? areas.find(a => a.resource.context?.model !== 'User') ?? null
  const idField = focus?.resource.context.idField ?? 'id'

  let shown   = []
  let columns = []
  let newest  = {}

  // Asked AGAIN once declaredFields() has answered: on an @@extensible model a
  // custom field one workspace declared is in no schema, so the first ask names
  // none of them.
  function layout() {
    const read = focus ? focus.resource.columns() : { columns: [], omitted: [] }
    shown   = read.columns.slice(0, 4)
    columns = [...shown, { name: '_open', label: 'Open', hideLabel: true }]
    // Newest first where the model stamps its rows. \`fields\` is the write
    // schema and holds no createdAt; the read schema columns() ranked does, in
    // what it showed or in what it left out.
    const stamped = [...read.columns, ...read.omitted].some(c => c.name === 'createdAt')
    newest = stamped ? { orderBy: '-createdAt' } : {}
  }

  layout()
  if (focus) focus.resource.declaredFields().then(layout, () => {})

  // A declared custom field is named for a PATH into its Json column
  // (fields.severity), which no flat record[name] reaches.
  const cellOf = (record, name) => name.split('.').reduce((v, k) => v?.[k], record)

  const stateHref = (f, s) => f.href + '?' + f.machine.field + '=' + encodeURIComponent(s.value)

  let totals  = {}
  let recent  = []
  let loading = true

  // A count is \`find\` with one row asked for, answering { data, total } —
  // the same row policy as the list it links to, so a tile never promises a
  // row the page behind it will not show.
  const count = (resource, query) =>
    resource.service.find(query, { limit: 1 }).then(r => r?.total ?? null, () => null)

  async function refresh() {
    if (!session.user) return
    const next = {}
    await Promise.all([
      ...areas.map(async a => { next[a.href] = await count(a.resource, {}) }),
      ...flows.flatMap(f => f.machine.states.map(async s => {
        next[stateHref(f, s)] = await count(f.resource, { [f.machine.field]: s.value })
      })),
      focus && focus.resource.service.find({}, { limit: 5, ...newest })
        .then(r => { recent = r?.data ?? [] }, () => { recent = [] }),
    ])
    totals  = next
    loading = false
  }

  // session settles after mount on a cold load, so the first refresh may find
  // nobody; the second line is the one that runs when it does.
  $: (session.user, session.checked, session.level)
  $.onMount(refresh)
  $: session.user, () => refresh()
${SC}

<div class="stack">
  <header class="stack">
    <h1>{title}</h1>
    {#if summary}<p class="text-muted">{summary}</p>{/if}
  </header>

  {#if !session.checked}
    <p class="text-muted">…</p>
  {:else if !session.user}
    <div class="cluster">
      <Button href="/login/">Sign in</Button>${join}
    </div>
  {:else}
    {#each flows as f (f.href)}
      <section class="stack">
        <SectionHeader title={f.label + ' by ' + f.machine.label} level={2}>
          {#snippet action()}
            <Button variant="link" href={f.href}>All {f.label.toLowerCase()}</Button>
          {/snippet}
        </SectionHeader>
        <div class="tiles">
          {#each f.machine.states as s (s.value)}
            <StatCard label={s.label} value={totals[stateHref(f, s)] ?? '—'} {loading} href={stateHref(f, s)} />
          {/each}
        </div>
      </section>
    {/each}

    {#if focus}
      <section class="stack">
        <SectionHeader title={'Latest ' + focus.label.toLowerCase()} level={2}>
          {#snippet action()}
            <Button href={focus.href + 'create/'} disabled={!focus.resource.can('create', session.level)}>New {focus.one.toLowerCase()}</Button>
          {/snippet}
        </SectionHeader>
        <Table {columns} rows={recent} loading={loading && !recent.length} hover emptyText="Nothing here yet.">
          {#snippet row(record)}
            <tr>
              {#each shown as c (c.name)}<td><Cell value={cellOf(record, c.name)} column={c} {record} /></td>{/each}
              <td><Button variant="link" href={focus.href + record[idField] + '/'}>Open</Button></td>
            </tr>
          {/snippet}
        </Table>
      </section>
    {/if}

    <section class="stack">
      <SectionHeader title={'Everything in ' + title} level={2} />
      <div class="tiles">
        {#each areas as a (a.href)}
          <StatCard label={a.label} value={totals[a.href] ?? '—'} {loading} href={a.href} />
        {/each}
      </div>
    </section>
  {/if}
</div>
`
}
