/*
 * nav.js — the app's navigation table, read by the shell and by ⌘K.
 *
 *   // web/src/nav.js
 *   export const groups   = [{ label: null, entries: [{ href: '/leads/', label: 'Leads' }] }]
 *   export const sections = [{ path: '/leads/', tabs: [{ href: '/leads/', label: 'Open', exact: true }] }]
 *
 *   sectionFor(sections, page.pathname)        the section the page is in, or null
 *   visible(groups, session)                   the groups and entries `show` lets through
 *   paletteItems(groups, session, goto)        CommandPalette's Navigate rows
 *
 * A section is the LONGEST `path` the page starts with, at a segment boundary,
 * and `/` holds only `/`. Taking the first match in array order instead lets a
 * section added above a shorter one silently take its pages, and two apps
 * disagreed on exactly that.
 *
 * Whether an entry is CURRENT is not decided here. That is Sierra's
 * `isActive(href, { exact })`, or the entry's own `match(path, query)` where a
 * path alone cannot say — a query-filtered list, one link for three sections.
 * This file cannot import Sierra (ui peers on mesa and css only), so the shell
 * is handed `isActive` by the `_module.mesa` that mounts it.
 *
 * `show` is an affordance, never the boundary (Invariant 6): the server refuses
 * whatever the nav offers. A predicate that throws therefore SHOWS its entry —
 * when the client cannot tell, it permits.
 *
 * The palette's rows are derived from `groups` rather than written beside
 * them, because a second list drifts: basecamp's ⌘K lost `/security/` that way
 * and nothing reported it. They pass through `visible` here rather than at the
 * caller, so ⌘K cannot offer an entry the nav hides.
 */

/**
 * @typedef {object} NavEntry
 * @property {string} href
 * @property {string} label
 * @property {string} [icon]   a name the app's own icon component takes
 * @property {boolean} [exact] current on `href` alone, not on pages beneath it
 * @property {(path: string, query: Record<string, string>) => boolean} [match]
 *   current where a path alone cannot say; overrides `href` and `exact`
 * @property {string} [sub]    the palette's second line; the nav does not draw it
 * @property {(session: any) => boolean} [show]  an affordance; throwing counts as true
 */

/**
 * @typedef {object} NavGroup
 * @property {string | null} label  `null` for an unlabeled first group
 * @property {NavEntry[]} entries
 * @property {(session: any) => boolean} [show]  an affordance; throwing counts as true
 */

/**
 * @typedef {object} NavTab
 * @property {string} href
 * @property {string} label
 * @property {boolean} [exact]
 */

/**
 * @typedef {object} NavSection
 * @property {string} path   the longest `path` the page starts with wins; `/` holds only `/`
 * @property {NavTab[]} [tabs]
 * @property {{ href: string, label: string }} [action]  one primary action for every page in it
 */

/**
 * @typedef {object} PaletteItem  CommandPalette's own item shape
 * @property {string} id
 * @property {string} group
 * @property {string} label
 * @property {string} [sub]
 * @property {() => void} action
 */

// Under `trailingSlash: 'never'` the page is `/leads` and the table says
// `/leads/`; comparing without the slash makes both spellings one path.
const bare = (p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)

/**
 * @param {NavSection[]} sections
 * @param {string} path  the page's pathname, no query
 * @returns {NavSection | null}
 */
export function sectionFor(sections, path) {
  const here = bare(path)
  let best = null
  let bestLength = -1
  for (const section of sections) {
    const at = bare(section.path)
    const inside = at === '/' ? here === '/' : here === at || here.startsWith(at + '/')
    if (inside && at.length > bestLength) {
      best = section
      bestLength = at.length
    }
  }
  return best
}

/**
 * @param {NavGroup[]} groups
 * @param {any} session  whatever the app's `show` predicates read
 * @returns {NavGroup[]}  new groups; a group left with no entries is dropped
 */
export function visible(groups, session) {
  const out = []
  for (const group of groups) {
    if (!allows(group.show, session)) continue
    const entries = group.entries.filter((e) => allows(e.show, session))
    if (entries.length) out.push({ ...group, entries })
  }
  return out
}

/**
 * @param {NavGroup[]} groups
 * @param {any} session  as `visible` takes it
 * @param {(href: string) => void} go  Sierra's `goto`
 * @returns {PaletteItem[]}
 */
export function paletteItems(groups, session, go) {
  return visible(groups, session).flatMap((group) =>
    group.entries.map((e) => ({
      id: 'nav:' + e.href,
      group: 'Navigate',
      label: e.label,
      ...(e.sub ? { sub: e.sub } : {}),
      action: () => go(e.href),
    })),
  )
}

function allows(show, session) {
  if (!show) return true
  try {
    return Boolean(show(session))
  } catch {
    return true
  }
}
