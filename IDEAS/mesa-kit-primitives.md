---
id: mesa-kit-primitives
status: proposed
dated: 2026-09-30
---

# Proposal — the primitives the Mesa kit keeps re-writing

**Status: PROPOSAL. Nothing here is built.** A first pass over
`packages/ui/components/` for code that is copied rather than owned. Read in
part: sizes for every component, the field and popup code in a handful. The
full audit is the first step below.

## The field block, copied into ~20 controls

21 files under `forms/` declare the same props — `name`, `label`, `hint`,
`error`, `errors`, `badge`, `help`, `disabled`, `required` — and resolve them
against `$context.form` by hand (`NumberInput.mesa` § Field integration):
`stated(disabled, lockedBy(form, name))`, `resolveRule`, `resolveError`,
`stated(required, rule?.required)`. About 30 lines per file, with the
`label = undefined` rationale comment repeated in each.

A new rule for how a control reads the form lands in 20 places, and the one it
misses is silently wrong — the shape of `EmptyState` dropping its children.

**Candidate:** one `fieldFrom(props)` returning
`{ disabled, required, rule, error, id }`, and one shared set of field props.
Each control keeps only what differs.

## Popups each re-implement dismissal and positioning

`Popover`, `DropdownMenu`, `MultiSelect`, `ConfirmPanel`, `ConfirmProvider`
and `DatePicker` each add their own capture-phase
`document.addEventListener('click', …)`, handle Escape, clean up, and position
with `getBoundingClientRect`. The copies differ: cleanup happens in `close` in
some and in `onDestroy` in others, and only `DropdownMenu` returns focus. All
are document-level, so two open popups both react to one click — against
Invariant 11.

**Candidate:** `dismissable(el, { onClose })` owning outside click, Escape and
focus return, plus one positioning helper. Weigh first the native `popover`
attribute with CSS anchor positioning, which would delete most of this code.

## Three listbox keyboard models

`MultiSelect` (687 lines), `Combobox` (413) and `CommandPalette` (624) each
carry their own arrow-key and active-index logic.

**Candidate:** a `listbox` helper owning the active index,
`aria-activedescendant`, and Arrow/Home/End/Enter. The components keep only
rendering and filtering.

## Not yet read

`DatePicker` (1386 lines) and `Json` (1307) are four to ten times the rest of
the kit. A file that size usually hides a primitive or should be split.

## Next

1. Finish the audit: every component read, each pattern with line refs.
2. Show `fieldFrom` as a real diff over `NumberInput` and `Input` before
   ruling (show code before design approval).
3. Run `decision-rules`: each candidate is a new noun.
