/*
 * aria.js — what a css VOCAB term OWES the accessibility tree, in one table.
 *
 * Accessibility in the UI realm was held by discipline: `vocabulary.js` wrote
 * `role="tab"` into an ANATOMY block, `Tab.mesa` wrote it again with the
 * `aria-selected` beside it, and nothing failed when one forgot the other. A
 * fact with N writers and no origin (`IDEAS/accessibility.md`, ruled
 * `FJS-D837`). This file is the origin. The css anatomy grades its markup
 * against it and the ui drive asserts a rendered component against it, so a
 * role stated in two places is now a role READ from one.
 *
 * An entry holds only what no platform element and no context supplies
 * (`FJS-D806`). A `<dialog>` is a dialog and modal by itself, so Dialog carries
 * no role; `<Form>` names every control, so Field and Switch require no label.
 * What is left is three things, and the shape is WAI-ARIA's own:
 *
 *   role      the role the term's element carries, where the element does not
 *   requires  the relationships that must exist — `label` is an accessible
 *             name, `controls` an `aria-controls` — whoever satisfies them. A
 *             component that derives one from a prop still owes it when the
 *             prop is empty, which is the Modal measurement (accessibility.md
 *             § 1.2)
 *   tracks    state → the attribute that reports it: `{ selected: 'aria-selected' }`
 *
 * A term whose role or state sits on a child carries it under `parts`, keyed
 * by the anatomy class the css package already names (`.tab`, `.step`), each
 * part the same shape. Only `Tabs` and `Drawer` have a part with a ROLE; the rest track a
 * state on a child the term lays out. A state on a child that carries NO
 * class — a breadcrumb's current page is styled by `[aria-current]` alone —
 * sits on the term's own row: `tracks` means reported on or within the
 * carrier, and a part key that names a class nothing renders is a part the
 * ui drive can never find.
 *
 * Nothing here reads a DOM. `owes(term)` is the table flattened to rows a
 * drive can walk; the drive brings the element.
 */

/** Which attributes satisfy a relationship, in the order a reader should try. */
export const RELATIONSHIPS = Object.freeze({
  label:    ['aria-labelledby', 'aria-label'],
  controls: ['aria-controls'],
})

/** A tracked attribute the element reports by itself once the native attribute
 *  is set — HTML-AAM maps `<button disabled>` to disabled, so a drive accepts
 *  either spelling for that state and the table stays per term, not per element. */
export const NATIVE = Object.freeze({
  'aria-disabled': 'disabled',
})

export const ARIA = Object.freeze({
  // Page — a section is a landmark only once it is named
  Pane:       { requires: ['label'] },
  View:       { role: 'tabpanel', requires: ['label'] },
  Tabs:       { parts: {
    tablist:  { role: 'tablist', requires: ['label'] },
    tab:      { role: 'tab', requires: ['controls'], tracks: { selected: 'aria-selected' } },
  } },

  // Region
  Toolbar:    { role: 'toolbar' },
  Breadcrumb: { requires: ['label'], tracks: { current: 'aria-current' } },
  Pagination: { requires: ['label'], parts: {
    'pagination-link': { tracks: { current: 'aria-current', disabled: 'aria-disabled' } },
  } },
  Nav:        { parts: { navlink: { tracks: { current: 'aria-current' } } } },
  Aside:      { requires: ['label'], parts: { 'aside-toggle': { tracks: { open: 'aria-expanded' } } } },

  // Block
  Lane:       { requires: ['label'] },
  Steps:      { parts: { step: { tracks: { current: 'aria-current' } } } },

  // Inline — the input is a checkbox; the role is the one thing it is not by itself
  Switch:     { role: 'switch' },

  // Overlay — role and modality are the <dialog> element's (accessibility.md § 1.2)
  Dialog:     { requires: ['label'] },
  Drawer:     { requires: ['label'], parts: { 'drawer-handle': { role: 'separator', requires: ['label'] } } },
  Tooltip:    { role: 'tooltip' },

  // Frame
  Shell:      { parts: { 'sidebar-toggle': { tracks: { open: 'aria-expanded' } } } },
})

function row(term, part, entry) {
  return {
    term,
    part:     part ?? null,
    role:     entry.role ?? null,
    requires: entry.requires ?? [],
    tracks:   entry.tracks ?? {},
  }
}

/**
 * The table flattened for one term: the term's own row first, then one per
 * part. `[]` for a term the table does not hold — a term with no entry owes
 * nothing, which is a different answer from a term that does not exist and the
 * drive asks the vocabulary about that.
 */
export function owes(term) {
  const entry = ARIA[term]
  if (!entry) return []
  const rows = []
  if (entry.role || entry.requires || entry.tracks) rows.push(row(term, null, entry))
  for (const [part, sub] of Object.entries(entry.parts ?? {})) rows.push(row(term, part, sub))
  return rows
}

/** The role a term, or one of its parts, must carry; `null` where the element's own role is the answer. */
export function roleOf(term, part) {
  const entry = part ? ARIA[term]?.parts?.[part] : ARIA[term]
  return entry?.role ?? null
}

/** Every `role` the table names, each with the term and part that carries it — what the anatomy grade walks. */
export function roles() {
  const out = []
  for (const term of Object.keys(ARIA)) {
    for (const r of owes(term)) if (r.role) out.push({ term, part: r.part, role: r.role })
  }
  return out
}
