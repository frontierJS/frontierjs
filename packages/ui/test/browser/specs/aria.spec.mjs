/*
 * aria.spec.mjs — what the kit says each term owes, asked of the component
 * that renders it.
 *
 * `@frontierjs/toolbelt/aria` is the one origin for a role, a required
 * relationship and a tracked state (`FJS-D837`). The css anatomy grades its
 * MARKUP STRINGS against it; nothing until here graded a component that
 * actually rendered, which is where `Tab.mesa` and `vocabulary.js` came to
 * disagree. Every spec in this directory already mounts the components the
 * kit names, so this one mounts the same fixtures and walks `owes(term)` over
 * the rendered tree — the fixture is borrowed, the assertion is the kit's.
 *
 * A term the kit holds but no component in this package renders — Pane,
 * Toolbar, Aside, Lane are markup an app writes — is listed as absent, by
 * name, so a term added to the kit fails HERE until someone says where it
 * renders or that nothing does.
 *
 * `tracks` is graded as presence on or within the carrier, in a fixture where
 * the state HOLDS: an attribute reporting a state that is false everywhere is
 * indistinguishable from one never written. A `<button disabled>` reports
 * disabled by itself, so the kit's `NATIVE` lets that spelling satisfy an
 * `aria-disabled` — stated once, beside `RELATIONSHIPS`, where the css grader
 * will read it the day it grades `tracks`.
 */
import { ARIA, NATIVE, RELATIONSHIPS, owes } from '@frontierjs/toolbelt/aria'

export const name = 'ARIA kit'
export const covers = []

/* Where each kit term renders: the fixture, the props that make every tracked
   state hold, and the selector of the term's own element. `null` is the
   explicit answer for a term nothing in this package renders. */
const WHERE = {
  Pane:       null,
  View:       { fixture: 'tabs', at: '#t-main [id$="-panel-general"]' },
  Tabs:       { fixture: 'tabs', at: '#t-main' },
  Toolbar:    null,
  Breadcrumb: { fixture: 'tail', at: '.breadcrumb' },
  Pagination: { fixture: 'datatable', at: '.pagination' },
  Nav:        { fixture: 'shell', props: { user: { email: 'a@b.c' } }, at: 'nav.sidebar' },
  Aside:      null,
  Lane:       null,
  Steps:      { fixture: 'display', at: '.steps' },
  Switch:     { fixture: 'form-changed', at: '.switch' },
  Dialog:     { fixture: 'modal', props: { open: true }, at: '.dialog' },
  Drawer:     { fixture: 'drawer', props: { open: true }, at: '.drawer' },
  Tooltip:    { fixture: 'tooltip', at: '.tooltip' },
  Shell:      { fixture: 'shell', props: { user: { email: 'a@b.c' } }, at: '.shell' },
}

export async function run(t) {
  const unplaced = Object.keys(ARIA).filter((term) => !(term in WHERE))
  t.is(unplaced.join(', '), '', 'every kit term is placed here, or named as rendered by nothing')

  const placed = Object.entries(WHERE).filter(([, w]) => w)
  // One mount per fixture, not per term — Tabs and View share a mount, as do Nav and Shell.
  const byFixture = new Map()
  for (const [term, w] of placed) {
    const key = w.fixture + JSON.stringify(w.props ?? {})
    if (!byFixture.has(key)) byFixture.set(key, { fixture: w.fixture, props: w.props ?? {}, terms: [] })
    byFixture.get(key).terms.push(term)
  }

  for (const { fixture, props, terms } of byFixture.values()) {
    await t.mount(fixture, props)
    for (const term of terms) {
      const findings = await t.evaluate(`
        return (${grade.toString()})(
          ${JSON.stringify(term)}, ${JSON.stringify(WHERE[term].at)},
          ${JSON.stringify(owes(term))}, ${JSON.stringify(RELATIONSHIPS)}, ${JSON.stringify(NATIVE)}
        );
      `)
      t.is(findings.join('\n        '), '', `${term} renders what the kit says it owes (${fixture})`)
    }
  }
}

/* Runs in the page. Returns one line per disagreement, each naming the term,
   the part and the rule, so a red row says what to change without a rerun. */
function grade(term, at, rows, relationships, native) {
  const out = []
  const root = document.querySelector(at)
  if (!root) return [`${term}: nothing on screen matches ${at}`]

  for (const row of rows) {
    const who = row.part ? `${term} .${row.part}` : term
    const els = row.part ? [...root.querySelectorAll('.' + row.part)] : [root]
    if (!els.length) { out.push(`${who}: the kit names the part, the component never renders the class`); continue }

    if (row.role) {
      for (const el of els) {
        const got = el.getAttribute('role')
        if (got !== row.role) out.push(`${who}: kit says role="${row.role}", <${el.tagName.toLowerCase()}> carries ${JSON.stringify(got)}`)
      }
    }

    for (const rel of row.requires) {
      const attrs = relationships[rel]
      for (const el of els) {
        const attr = attrs.find((a) => (el.getAttribute(a) || '').trim())
        if (!attr) { out.push(`${who}: requires ${rel}, none of ${attrs.join('/')} is written`); continue }
        if (attr === 'aria-label') continue
        for (const id of el.getAttribute(attr).trim().split(/\s+/)) {
          if (!document.getElementById(id)) out.push(`${who}: ${attr}="${id}" names no element`)
        }
      }
    }

    for (const [state, attr] of Object.entries(row.tracks)) {
      const reports = (el) => el.hasAttribute(attr) || (native[attr] && el.hasAttribute(native[attr]))
      const some = els.some((el) => reports(el) || [...el.querySelectorAll('*')].some(reports))
      if (!some) out.push(`${who}: tracks ${state} as ${attr}, and nothing on or within it reports it`)
    }
  }
  return out
}
