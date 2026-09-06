/**
 * islands/loader.js — find Mesa island markers in a prerendered page and mount them.
 *
 * This is the client half of Mesa's SSR_SPEC W3. Mesa's renderer, compiled with
 * `{ islands: true }`, wraps every `client:*` component in comment markers:
 *
 *   <!--mesa-island {"component":"Counter","directive":"load","props":{"start":3}}-->
 *   <button>3</button>
 *   <!--/mesa-island-->
 *
 * A prerendered Sierra page is otherwise inert — `target: 'static'` emits HTML
 * and CSS and no script at all — so this is the whole interactivity story for
 * that target, not an optimization on top of a working one.
 *
 * ── Replace, not adopt ────────────────────────────────────────────────────
 * Mounting REPLACES the prerendered markup: the nodes between the markers are
 * removed and the component is mounted in their place. It does not adopt them.
 * That is deliberate and matches the runtime — hydration does not exist in Mesa
 * (`render.js` says so directly), so there is nothing to adopt with. The
 * user-visible cost is a swap for anything whose initial client render differs
 * from the prerendered one; the markup is identical for equal props, so in the
 * normal case nothing moves.
 *
 * ── Two traps this file exists to not fall into ───────────────────────────
 * `mount()`, never `Comp(anchor, props, null)`. A direct call renders the right
 * markup and registers no delegation root, so the island comes back looking
 * perfect and responding to nothing — the same failure that left all 59 Mesa
 * REPL examples inert. `mount` takes the OPEN marker: it inserts its own anchor
 * immediately after the node it is given and the component renders before that,
 * i.e. exactly into the range the prerendered markup vacated.
 *
 * The DOM walk is a manual recursion, not `createTreeWalker(root,
 * NodeFilter.SHOW_COMMENT)`. The TreeWalker is the better implementation and
 * works in every browser — but happy-dom 14.12.3 filters SHOW_COMMENT to
 * nothing, so the obvious version silently finds zero islands under any test
 * that runs against happy-dom, including Sierra's and Mesa's own suites.
 *
 * ── Nested islands ────────────────────────────────────────────────────────
 * A `client:*` component can contain another one, and the server render nests
 * the markers accordingly. On the client there is no nesting to honor: Mesa's
 * `island()` short-circuits when `_isClient`, so an outer island's client
 * render calls the inner component DIRECTLY — live, inside the outer's
 * delegation root. An inner island is therefore already mounted, by its parent,
 * before its own directive ever fires.
 *
 * That makes an ancestor's mount authoritative, and this file defers to it in
 * three places rather than racing it:
 *
 *   1. A scheduled callback checks `open.parentNode` before resolving its
 *      component. A subsumed island returns immediately — no chunk fetched, and
 *      no `mount()` throw for a detached anchor to be logged as a load failure.
 *   2. `mountIsland` removes the nodes CURRENTLY between the markers, not the
 *      list captured at scan time. A descendant that mounted first replaced its
 *      own range, so the captured list is stale and removing it would strand
 *      the descendant's live nodes beside the outer's fresh render.
 *   3. Mounting disposes any live island inside the range it is about to
 *      remove, so a descendant that got there first releases its delegation
 *      root instead of leaking it.
 *
 * The one thing that cannot be honored is `client:static` under a live
 * ancestor: "no JS even if reactive" loses to the parent rendering its own
 * children. That is warned about rather than silently reinterpreted.
 */

import { mount } from '@frontierjs/mesa/runtime.js'

const OPEN   = 'mesa-island '
const CLOSE  = '/mesa-island'

/** The nodes currently between two markers, in document order. */
function nodesBetween(open, close) {
  const nodes = []
  for (let n = open.nextSibling; n && n !== close; n = n.nextSibling) nodes.push(n)
  return nodes
}

/**
 * Every island in `root`, innermost-first (a marker closes before its parent).
 *
 * `parent` is the enclosing island, or null at the top level — the client's only
 * view of nesting, since a marker records a component and not its position in a
 * tree. `nodes` is the prerendered range as it was at scan time; anything that
 * mounts works from the live range instead (see the header).
 *
 * @returns {Array<{ meta: object, open: Comment, close: Comment, nodes: Node[], parent: object|null }>}
 */
export function findIslands(root = document.body) {
  const comments = []
  ;(function walk(node) {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 8) comments.push(n)
      else if (n.nodeType === 1) walk(n)
    }
  })(root)

  const found = []
  const open  = []
  // An open marker's parent is whatever is still on the stack when it is
  // pushed; the island object for that parent does not exist until it closes,
  // which is always later, so the links are resolved in a second pass.
  const links = []
  for (const c of comments) {
    if (c.data.startsWith(OPEN)) {
      let meta
      try {
        meta = JSON.parse(c.data.slice(OPEN.length))
      } catch (err) {
        // A marker we cannot read is a bug in the renderer or a mangled
        // document, not a reason to abandon the other islands on the page.
        console.error('[Sierra islands] unreadable island marker — skipping:', err.message, c.data)
        continue
      }
      open.push({ meta, node: c, parent: open[open.length - 1] ?? null, island: null })
    } else if (c.data === CLOSE) {
      const o = open.pop()
      if (!o) {
        console.error('[Sierra islands] island close marker with no open marker — skipping')
        continue
      }
      o.island = { meta: o.meta, open: o.node, close: c, nodes: nodesBetween(o.node, c), parent: null }
      found.push(o.island)
      links.push([o.island, o.parent])
    }
  }
  for (const [island, parent] of links) island.parent = parent?.island ?? null
  if (open.length) {
    console.error(`[Sierra islands] ${open.length} island marker(s) never closed — those islands stay inert`)
  }
  return found
}

/**
 * The nearest ancestor island that will mount, or null.
 *
 * `client:static` is the only directive that never mounts, so it is the only
 * one that leaves its descendants to mount themselves.
 */
function liveAncestor(island) {
  for (let p = island.parent; p; p = p.parent) {
    if (p.meta.directive !== 'static') return p
  }
  return null
}

/**
 * Islands mounted by this module, so an ancestor mounting over one can dispose
 * it. Module-level rather than threaded through `hydrateIslands`, because
 * `mountIsland` is exported and has to be correct when called on its own.
 *
 * `handle.destroy()` removes the mount anchor, releases the delegation root and
 * disposes the component's reactive root, so an island mounted over stops
 * running rather than merely losing its nodes.
 */
const _mounted = new Set()

/** Dispose every live island whose marker sits inside `range`. */
function disposeWithin(range) {
  for (const entry of [..._mounted]) {
    const marker = entry.open
    if (!marker.isConnected) { _mounted.delete(entry); continue }
    const inside = range.some((n) => n === marker || (n.nodeType === 1 && n.contains?.(marker)))
    if (!inside) continue
    _mounted.delete(entry)
    try {
      entry.handle.destroy()
    } catch (err) {
      console.error(`[Sierra islands] <${entry.name}> failed to dispose while its parent mounted:`, err)
    }
  }
}

/**
 * Turn a registry entry into a component.
 *
 * Two shapes, told apart by **arity**, which is unambiguous here: a compiled
 * Mesa component is always `(anchor, props, block)` — length 3 — and an import
 * thunk is `() => import(…)` — length 0.
 *
 *   Counter: Counter                    // the component itself
 *   Counter: () => import('./Counter')  // a lazy chunk (what the build emits)
 *
 * Calling a component by mistake would render it into nowhere and return
 * undefined, so this cannot guess: only a zero-argument function is invoked.
 */
export async function resolveComponent(entry) {
  if (typeof entry !== 'function') return entry
  if (entry.length > 0) return entry                 // the component itself
  const loaded = await entry()
  return loaded?.default ?? loaded
}

/**
 * Mount one island now, replacing whatever currently stands in its range.
 * Exported so a caller can drive mounting itself (tests do).
 *
 * Returns null — rather than throwing out of `mount` — when the markers are no
 * longer in the document. That means an ancestor island mounted over this one
 * and rendered the component live itself, which is success, not failure.
 */
export function mountIsland(island, Component) {
  // `isConnected`, not `parentNode`. Removing an ancestor detaches this marker
  // from the DOCUMENT but leaves its parentNode pointing at the removed node,
  // so a parentNode check reads as "still there" and mounts the component into
  // a subtree nobody will ever see — mounted, correct-looking, invisible.
  if (!island.open.isConnected) return null

  // The LIVE range, not `island.nodes`: a descendant island that mounted first
  // replaced its own prerendered nodes, so the scan-time list no longer
  // describes what is on the page.
  const range = nodesBetween(island.open, island.close)
  disposeWithin(range)
  for (const node of range) node.remove()
  island.nodes.length = 0

  // The open marker is the anchor; see the header on why this is `mount`.
  const handle = mount(island.open, Component, { props: island.meta.props ?? {} })
  _mounted.add({ open: island.open, handle, name: island.meta.component })
  return handle
}

/**
 * Schedule `fn` according to a `client:*` directive.
 *
 * Returns a teardown for the ones that wait on something, so a caller can
 * cancel. `static` never runs: it means "no JS even if the component is
 * reactive" (VISION §18.5), so the prerendered markup is the final answer and
 * mounting would be the opposite of what was asked for.
 */
export function schedule(directive, media, target, fn) {
  switch (directive) {
    case 'static':
      return () => {}

    case 'load':
      fn()
      return () => {}

    case 'idle': {
      if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(fn)
        return () => cancelIdleCallback(id)
      }
      // Safari <17 has no requestIdleCallback. A timeout is the standard
      // stand-in — later than idle would be, never never.
      const id = setTimeout(fn, 1)
      return () => clearTimeout(id)
    }

    case 'visible': {
      if (typeof IntersectionObserver !== 'function') { fn(); return () => {} }
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) { io.disconnect(); fn(); return }
        }
      })
      // Observe the marker's next element sibling — a comment cannot be
      // observed. With nothing to observe there is nothing to become visible,
      // so mount rather than strand the island forever.
      const el = nextElement(target)
      if (!el) { fn(); return () => {} }
      io.observe(el)
      return () => io.disconnect()
    }

    case 'media': {
      if (!media || typeof matchMedia !== 'function') { fn(); return () => {} }
      const mq = matchMedia(media)
      if (mq.matches) { fn(); return () => {} }
      const onChange = (e) => { if (e.matches) { mq.removeEventListener('change', onChange); fn() } }
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }

    default:
      console.warn(`[Sierra islands] unknown client:${directive} — mounting immediately`)
      fn()
      return () => {}
  }
}

function nextElement(node) {
  for (let n = node.nextSibling; n; n = n.nextSibling) if (n.nodeType === 1) return n
  return null
}

/**
 * Mount every island on the page from a name → component registry.
 *
 * The registry is generated at build time by Sierra's island entry — component
 * NAME to component factory — because the marker carries a name and a bundle
 * carries modules, and only the build knows the mapping. Mesa records the
 * import specifier on each `ctx.islands` entry so the build does not have to
 * re-parse source to work it out.
 *
 * @param {Record<string, Function>} registry
 * @param {object} [options]
 * @param {Node}   [options.root=document.body]
 * @returns {Array<{ component: string, directive: string }>} what was scheduled
 */
export function hydrateIslands(registry, { root = document.body } = {}) {
  const islands = findIslands(root)
  const scheduled = []

  for (const island of islands) {
    const name = island.meta.component
    const entry = registry[name]
    if (!entry) {
      // Loud on purpose. The island stays as prerendered markup, which LOOKS
      // right and is dead — exactly the failure mode that is impossible to
      // spot by looking at the page.
      console.error(
        `[Sierra islands] no component registered for "${name}" — it stays inert. ` +
        `The island entry is generated from the prerender's island list; a name ` +
        `missing here means the component was not in it.`
      )
      continue
    }
    if (island.meta.directive === 'static') {
      const live = liveAncestor(island)
      if (live) {
        // The parent renders its own children when it mounts, so there is no
        // way to keep this one as markup short of not mounting the parent.
        console.warn(
          `[Sierra islands] <${name}> is client:static inside <${live.meta.component}> ` +
          `client:${live.meta.directive} — a live parent renders its children, so ` +
          `"no JS" cannot be honored here. Move it outside the parent island, or ` +
          `make the parent client:static too.`
        )
      }
    }
    // The fetch happens inside the scheduled callback, not before it, so a
    // client:visible island downloads nothing until it scrolls into view.
    schedule(island.meta.directive, island.meta.media, island.open, async () => {
      // An ancestor mounted between scheduling and now: it rendered this
      // component live as part of its own render, so there is nothing to mount
      // and nothing worth downloading to mount it with.
      if (!island.open.isConnected) return
      try {
        const Component = await resolveComponent(entry)
        if (typeof Component !== 'function') {
          console.error(
            `[Sierra islands] "${name}" resolved to ${typeof Component}, not a component. ` +
            `A registry entry is either a component, or a zero-argument thunk returning ` +
            `one (or a module with it as the default export).`
          )
          return
        }
        mountIsland(island, Component)
      } catch (err) {
        console.error(`[Sierra islands] <${name}> failed to load or mount — it stays inert:`, err)
      }
    })
    scheduled.push({ component: name, directive: island.meta.directive })
  }

  return scheduled
}
