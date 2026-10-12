// src/block-look.js — the classes a Block puts on the page, for both ways an
// author writes one: `layout: Block` (src/layouts/Block.mesa) and a `====`
// divider in a page (config/dividers.js). Two spellings of one thing, so one
// owner of what each look key is allowed to say and where its class lands.
//
// The allowed values are @frontierjs/css's own (FJS-D621, FJS-D823), read from
// its vocabulary, so a word css stops shipping stops building here too.

import vocabulary from '@frontierjs/css/vocabulary.json' with { type: 'json' }

// Every Layout helper but Container, which the Band already holds.
export const AXES = {
  template:  vocabulary.terms.filter((t) => t.tier === 'Layout' && t.class !== 'container').map((t) => t.class),
  tone:      vocabulary.notATerm.tone,
  treatment: vocabulary.notATerm.treatment,
  density:   vocabulary.notATerm.density,
  align:     ['start', 'center', 'end'],
}

/**
 * The axis a class word belongs to, with the value it states: `split` is
 * `['template', 'split']`, `align-center` is `['align', 'center']`. Null for a
 * word css does not name as an axis, which is the site's own class.
 */
export function axisOf(word) {
  const align = /^align-(.+)$/.exec(word)
  if (align && AXES.align.includes(align[1])) return ['align', align[1]]
  for (const key of ['template', 'tone', 'treatment', 'density']) {
    if (AXES[key].includes(word)) return [key, word]
  }
  return null
}

/** The first look value css does not ship, as `{ key, value, allowed }`, or null. */
export function badLook(look) {
  for (const [key, value] of Object.entries(look)) {
    if (value === undefined || value === null || value === '') continue
    if (!AXES[key]?.includes(value)) return { key, value, allowed: AXES[key] ?? [] }
  }
  return null
}

/**
 * A Band's two class lists: the `<section>`'s and its `.container`'s. The
 * template arranges the band's children, so it sits on the container that
 * holds them; the rest skin the whole stripe.
 */
export function bandClasses({ kind, template, tone, treatment, density, align, extra = [] }) {
  return {
    outer: ['band', kind, tone, treatment, density, align && `align-${align}`, ...extra].filter(Boolean).join(' '),
    inner: ['container', template].filter(Boolean).join(' '),
  }
}

/** A nested Block's one class list: no container, so its template is its own. */
export function cellClasses({ kind, template, tone, treatment, density, align, extra = [] }) {
  return [kind, template, tone, treatment, density, align && `align-${align}`, ...extra].filter(Boolean).join(' ')
}
