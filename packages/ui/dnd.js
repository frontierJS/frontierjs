/*
 * dnd.js — drag and drop between flow lists, as a Mesa attachment.
 *
 *   <ul {@attach dndzone(() => ({
 *     items: todo,
 *     type: 'task',
 *     onconsider: ({ items }) => todo = items,
 *     onfinalize: ({ items }) => { todo = items; save(items) },
 *   }))}>
 *     {#each todo as t (t.id)}<li>{t.title}</li>{/each}
 *   </ul>
 *
 * The contract, which the host keeps:
 *
 *   • every ELEMENT child of the zone is one item, in `items` order. A header
 *     row or an empty-state `<li>` inside the zone shifts every index after it
 *     and the wrong record moves. Put those outside the zone.
 *   • `items` carry an `id`, and the `{#each}` is KEYED on it. During a drag
 *     the list holds a placeholder item (`SHADOW_ITEM_MARKER` set, id
 *     `SHADOW_PLACEHOLDER_ITEM_ID`) where the dragged one will land; the host
 *     renders it like any other item and it is hidden here.
 *   • both callbacks write the list back. `onconsider` fires while the drag is
 *     in flight, `onfinalize` once on drop — the only one to persist from.
 *     A drop into another zone finalizes BOTH lists, the origin's with
 *     trigger `droppedIntoAnother`.
 *
 * The argument is a GETTER, not an options object. `{@attach}` re-runs its
 * expression whenever a value read in it changes, and re-running means tearing
 * the zone down — so `{@attach dndzone({ items })}` would finish the drag on the
 * first `onconsider` that wrote `items`. The getter is read inside this
 * module's own effect instead, and the zone lives as long as the element.
 *
 * Callbacks rather than `onconsider`: Mesa delegates `onclick` and its kin to the mount root,
 * and a CustomEvent that does not bubble never reaches it, while one that does
 * would reach every zone it is nested in.
 *
 * Styling is the app's: a zone that will take the drop carries
 * `data-dnd-target` for the length of the drag, and the ghost under the
 * pointer carries `data-dnd-ghost`. `@frontierjs/css` has no term for either.
 *
 * How it stays cheap: every zone of the dragged item's type is measured ONCE at
 * drag start into document coordinates, in "collapsed space" (the list as if
 * the dragged item were gone). Each frame then finds the insertion index by
 * arithmetic — the on-screen midpoint of collapsed item i is
 * `slots[i] + (i >= placeholderIndex ? span : 0)` — with no layout read in the
 * hot path. A zone is re-measured only when the pointer crosses into another
 * one, or when its list changed under the drag (a live update). Scrolling of
 * the window, an ancestor or the zone itself is folded in as a delta.
 *
 * Keyboard: an item is focusable (`tabindex="0"`, unless the host stated one,
 * and not at all with a `dragHandleSelector`, where the handle is the host's to
 * make focusable). Space lifts the focused item, the arrows along the zone's
 * axis move it through the same `onconsider` calls, Space drops it into
 * `onfinalize` and Escape or Tab cancels, each with `info.source` `'keyboard'`.
 * The lifted item is NOT hidden: its placeholder is what is on screen and
 * what holds focus, since a hidden element cannot. One shared live region says
 * where it is, in English. A keyboard move stays inside its own zone.
 *
 * A wrapped zone — a flex-wrap in either direction, or a grid filled along
 * one axis — is read by line and then along it, and is re-measured after each
 * move of its placeholder, because the reflow shifts everything after it by
 * more than one span.
 *
 * Not built: moving between zones by keyboard, nested zones of one type, and a
 * grid whose cells span tracks (a flow list or a wrap is detected per zone from
 * its children's rects).
 */

import { createEffect } from '@frontierjs/mesa/runtime'
import { overlayHost }  from './utils.js'

// ─── constants ────────────────────────────────────────────────────────────

export const SHADOW_ITEM_MARKER         = 'isDndShadowItem'
export const SHADOW_PLACEHOLDER_ITEM_ID = 'id:dnd-shadow-placeholder-0000'
export const TRIGGERS = {
  DRAG_STARTED:          'dragStarted',
  DRAGGED_ENTERED:       'draggedEntered',
  DRAGGED_OVER_INDEX:    'draggedOverIndex',
  DRAGGED_LEFT:          'draggedLeft',
  DRAGGED_LEFT_ALL:      'draggedLeftAll',
  DROPPED_INTO_ZONE:     'droppedIntoZone',
  DROPPED_INTO_ANOTHER:  'droppedIntoAnother',
  DROPPED_OUTSIDE_OF_ANY: 'droppedOutsideOfAny',
}

const ITEM_ID_KEY            = 'id'
const SHADOW_ATTR            = 'data-dnd-shadow'
const TARGET_ATTR            = 'data-dnd-target'
const GHOST_ATTR             = 'data-dnd-ghost'
const TAB_ATTR               = 'data-dnd-tab'
const LIVE_ATTR              = 'data-dnd-live'
const DEFAULT_TYPE           = '--any--'
const START_THRESHOLD_PX     = 3
const DEFAULT_TOUCH_DELAY_MS = 150
const SCROLL_ZONE_PX         = 36
const SCROLL_SPEED           = 0.6   // px scrolled per px of edge proximity, per frame
const DEFAULT_DROP_MS        = 150
const INTERACTIVE_SELECTOR   = "input, select, textarea, button, a[href], [contenteditable=''], [contenteditable='true']"

const DEFAULTS = {
  items:                   [],
  type:                    DEFAULT_TYPE,
  disabled:                false,
  dropFromOthersDisabled:  false,
  dropAnimationMs:         DEFAULT_DROP_MS,
  transformDraggedElement: undefined,
  centerOnCursor:          false,
  delayTouchStart:         false,
  dragHandleSelector:      undefined,
  onconsider:              undefined,
  onfinalize:              undefined,
}

// ─── registry ─────────────────────────────────────────────────────────────
//
// Module-level: one gesture and one drag at a time, page-wide.

/** @type {Map<HTMLElement, {config: Object}>} */
const zoneRegistry = new Map()
/** @type {Map<string, Set<HTMLElement>>} */
const typeIndex = new Map()

let armed   = null   // a press that has not yet moved far enough to be a drag
let session = null   // the drag in flight

// ─── geometry ─────────────────────────────────────────────────────────────

function docRect(el) {
  const r = el.getBoundingClientRect()
  const sx = window.scrollX, sy = window.scrollY
  return { left: r.left + sx, top: r.top + sy, right: r.right + sx, bottom: r.bottom + sy, width: r.width, height: r.height }
}

/**
 * The rect with the element's OWN translate removed. An app animating its list
 * (a FLIP on reorder) measured mid-animation would otherwise snapshot where the
 * item was passing through rather than where it will settle, and every index
 * computed off that snapshot would be off by the animation's remaining travel.
 */
function docRectNoTransform(el) {
  const r = docRect(el)
  const t = getComputedStyle(el).transform
  if (t && t !== 'none') {
    let dx = 0, dy = 0
    if (t.startsWith('matrix3d(')) {
      const p = t.slice(9, -1).split(',')
      dx = +p[12]; dy = +p[13]
    } else if (t.startsWith('matrix(')) {
      const p = t.slice(7, -1).split(',')
      dx = +p[4]; dy = +p[5]
    }
    r.left -= dx; r.right -= dx; r.top -= dy; r.bottom -= dy
  }
  return r
}

function pointInRect(x, y, r) {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

function getDepth(el) {
  let d = 0
  while (el.parentElement) { d++; el = el.parentElement }
  return d
}

function isScrollable(el) {
  const s = getComputedStyle(el)
  return /(auto|scroll)/.test(s.overflowY + s.overflowX)
}

function scrollAncestorsOf(el) {
  const out = []
  let p = el.parentElement
  while (p && p !== document.body && p !== document.documentElement) {
    if (isScrollable(p)) out.push(p)
    p = p.parentElement
  }
  return out
}

// ─── zone measurement ─────────────────────────────────────────────────────

/**
 * (Re)measure a zone into the session snapshot:
 *   rect             zone bounds in doc coords, for hit testing
 *   ancestors        scroll ancestors above the zone with baseline offsets —
 *                    their deltas move the zone itself
 *   selfScroll       the zone's own scroller's baseline — its delta moves only
 *                    the children
 *   slots            collapsed-space midpoints of the non-placeholder children
 *   span             main-axis size of the dragged slot (item + gap)
 *   placeholderIndex where the placeholder sits in collapsed space, or null
 *
 * The placeholder is found by the grabbed element (first measure), by the
 * shadow attribute, or by the index this module last put it at — whichever the
 * DOM currently offers, so the order of this call against the host's render
 * does not matter.
 */
function measureZone(meta) {
  const node = meta.node
  meta.rect       = docRect(node)
  meta.ancestors  = scrollAncestorsOf(node).map((el) => ({ el, x0: el.scrollLeft, y0: el.scrollTop }))
  meta.selfScroll = isScrollable(node) ? { x0: node.scrollLeft, y0: node.scrollTop } : null

  const kids     = Array.from(node.children)
  const knownIdx = meta.placeholderIndex
  let phIdx = -1
  const rects = []
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]
    if ((session && k === session.grabbedEl) || k.hasAttribute(SHADOW_ATTR)) phIdx = i
    rects.push(docRectNoTransform(k))
  }
  if (phIdx === -1 && knownIdx != null && knownIdx < kids.length) phIdx = knownIdx

  // A wrapped zone is read by line, then along it: the placeholder's real
  // neighbors are on its own line, and no one-axis midpoint says which. A row
  // wrap (or a grid, which fills row by row) has rows for lines; a column wrap
  // has columns.
  meta.lines = null
  let wrapAxis = 'x'
  let wrap = wrappedLines(rects, 'x')
  if (!wrap) { wrapAxis = 'y'; wrap = wrappedLines(rects, 'y') }
  if (wrap) {
    const first = wrap.find((l) => l.to - l.from >= 2)
    const lo = (r) => (wrapAxis === 'x' ? r.left : r.top)
    const hi = (r) => (wrapAxis === 'x' ? r.right : r.bottom)
    const neg = lo(rects[first.from + 1]) < lo(rects[first.from])
    const uMid = (r) => (neg ? -(lo(r) + hi(r)) / 2 : (lo(r) + hi(r)) / 2)
    const slots = []
    const lines = []
    for (const l of wrap) {
      const at = slots.length
      for (let i = l.from; i < l.to; i++) if (i !== phIdx) slots.push(uMid(rects[i]))
      lines.push({ from: at, to: slots.length, lo: l.lo, hi: l.hi })
    }
    meta.axis = wrapAxis
    meta.neg  = neg
    meta.span = 0
    meta.slots = slots
    meta.lines = lines
    meta.placeholderIndex = phIdx >= 0 ? phIdx : null
    return
  }

  // Axis is the dominant direction between the first two children, and `neg`
  // is DOM order running against the coordinates (an RTL row, column-reverse).
  // All slot math is in "u-space", coordinates negated when `neg`, so DOM order
  // is always ascending and one formula covers every flow direction.
  let axis = meta.axis || 'y'
  let neg  = meta.neg || false
  if (rects.length >= 2) {
    const dy = rects[1].top - rects[0].top
    const dx = rects[1].left - rects[0].left
    axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x'
    neg  = (axis === 'y' ? dy : dx) < 0
  }
  meta.axis = axis
  meta.neg  = neg
  const start  = (r) => (axis === 'y' ? r.top : r.left)
  const end    = (r) => (axis === 'y' ? r.bottom : r.right)
  const size   = (r) => (axis === 'y' ? r.height : r.width)
  const uStart = (r) => (neg ? -end(r) : start(r))
  const uEnd   = (r) => (neg ? -start(r) : end(r))

  let gap = 0
  if (rects.length >= 2) gap = Math.max(0, uStart(rects[1]) - uEnd(rects[0]))

  const dragSize = session ? (axis === 'y' ? session.dragH : session.dragW) : 0
  meta.span = (phIdx >= 0 ? size(rects[phIdx]) : dragSize) + gap

  const slots = []
  for (let i = 0; i < rects.length; i++) {
    if (i === phIdx) continue
    const mid = (uStart(rects[i]) + uEnd(rects[i])) / 2
    slots.push(phIdx >= 0 && i > phIdx ? mid - meta.span : mid)
  }
  meta.slots = slots
  meta.placeholderIndex = phIdx >= 0 ? phIdx : null
}

function ancestorDelta(meta) {
  let dx = 0, dy = 0
  for (const s of meta.ancestors) {
    dx += s.el.scrollLeft - s.x0
    dy += s.el.scrollTop - s.y0
  }
  return { dx, dy }
}

/** Group a zone's child rects, in DOM order, into the lines of a wrap running
 *  along `axis`: `{ from, to, lo, hi }` over child indexes, `lo`/`hi` the line's
 *  extent on the other axis. Null unless some line holds two children AND there
 *  is more than one line — a column has a child per line and a row has a single
 *  line, and the one-axis math covers both. */
function wrappedLines(rects, axis) {
  const across = axis === 'x'
  const lo = (r) => (across ? r.top : r.left)
  const hi = (r) => (across ? r.bottom : r.right)
  const lines = []
  let line = null
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    if (line) {
      const overlap = Math.min(line.hi, hi(r)) - Math.max(line.lo, lo(r))
      if (overlap > Math.min(line.hi - line.lo, hi(r) - lo(r)) / 2) {
        line.to = i + 1
        line.lo = Math.min(line.lo, lo(r))
        line.hi = Math.max(line.hi, hi(r))
        continue
      }
    }
    line = { from: i, to: i + 1, lo: lo(r), hi: hi(r) }
    lines.push(line)
  }
  return lines.length > 1 && lines.some((l) => l.to - l.from >= 2) ? lines : null
}

/** Insertion index for a content-space main-axis coordinate `m`; `c` is the
 *  cross-axis one, read only by a wrapped zone to pick the line. Monotonic in
 *  `m`, which is what keeps the placeholder from flickering between two slots. */
function indexForPointer(meta, m, c) {
  if (meta.lines) {
    let best = meta.lines[0]
    let bestD = Infinity
    for (const l of meta.lines) {
      const d = c < l.lo ? l.lo - c : c > l.hi ? c - l.hi : 0
      if (d < bestD) { best = l; bestD = d }
    }
    for (let i = best.from; i < best.to; i++) if (m < meta.slots[i]) return i
    return best.to
  }
  const P = meta.placeholderIndex ?? Infinity
  const { slots, span } = meta
  for (let i = 0; i < slots.length; i++) {
    if (m < slots[i] + (i >= P ? span : 0)) return i
  }
  return slots.length
}

// ─── notifying the host ───────────────────────────────────────────────────

/** Order-sensitive identity of an items list. A list whose signature differs
 *  from the last one this module handed the host was changed by something else
 *  mid-drag, and its snapshot is stale. */
function sig(items) {
  let s = ''
  for (const it of items) s += (it[SHADOW_ITEM_MARKER] ? '\u0000' : it[ITEM_ID_KEY]) + '\u0001'
  return s
}

function notify(node, which, items, trigger) {
  const meta = session.zones.find((z) => z.node === node)
  if (meta) {
    meta.expectedSig = sig(items)
    meta.handed = items
  }
  const cfg = zoneRegistry.get(node)?.config ?? meta?.config
  cfg?.[which]?.({ items, info: { trigger, id: session.itemId, source: session.keyboard ? 'keyboard' : 'pointer' } })
}

/** The zone's list as the host will hold it once it has written back the
 *  last one it was handed. `config.items` is what the host has written SO FAR,
 *  and a cancel or a drop in the same tick as a notify reads it before the
 *  host's flush — the dragged item was then missing from every list. */
function listOf(meta) {
  return meta.handed ?? meta.config.items
}

/** The zone's items minus the placeholder AND minus the dragged item, which
 *  the origin list still holds at `dragStarted`. */
function itemsWithoutShadow(meta) {
  return listOf(meta).filter((it) => !it[SHADOW_ITEM_MARKER] && !(session && it[ITEM_ID_KEY] === session.itemId))
}

function considerWithShadowAt(meta, idx, trigger) {
  const items = itemsWithoutShadow(meta)
  items.splice(idx, 0, session.shadowItem)
  meta.placeholderIndex = idx
  notify(meta.node, 'onconsider', items, trigger)
}

// ─── the ghost ────────────────────────────────────────────────────────────

const GHOST_STYLE_PREFIXES = ['background', 'padding', 'font', 'text', 'align', 'justify', 'display', 'flex', 'gap', 'border', 'grid', 'line', 'letter']
const GHOST_STYLE_EXACT    = new Set(['opacity', 'color', 'list-style-type', 'box-shadow'])

function createGhost(sourceEl, rect, pointer, centerOnCursor) {
  const ghost = sourceEl.cloneNode(true)
  // The clone is reparented to `overlayHost()`, where a rule keyed on an ancestor and
  // every inherited value stop applying — copied once from the computed style
  // so the ghost still looks like the item it was lifted from.
  const cs = getComputedStyle(sourceEl)
  for (const prop of cs) {
    if (GHOST_STYLE_EXACT.has(prop) || GHOST_STYLE_PREFIXES.some((p) => prop.startsWith(p)))
      ghost.style.setProperty(prop, cs.getPropertyValue(prop), cs.getPropertyPriority(prop))
  }
  // A clone carries every id below it, and a second `#email` in the document
  // makes `label[for]` and `getElementById` answer the ghost.
  for (const el of [ghost, ...ghost.querySelectorAll('[id]')]) el.removeAttribute('id')
  ghost.removeAttribute(SHADOW_ATTR)
  ghost.setAttribute(GHOST_ATTR, '')
  ghost.setAttribute('aria-hidden', 'true')
  ghost.inert = true
  const s = ghost.style
  s.position   = 'fixed'
  s.boxSizing  = 'border-box'
  s.margin     = '0'
  s.width      = `${rect.width}px`
  s.height     = `${rect.height}px`
  let left = rect.left - window.scrollX
  let top  = rect.top - window.scrollY
  if (centerOnCursor) {
    left = pointer.clientX - rect.width / 2
    top  = pointer.clientY - rect.height / 2
  }
  s.left          = `${left}px`
  s.top           = `${top}px`
  s.zIndex        = '9999'
  s.pointerEvents = 'none'
  s.cursor        = 'grabbing'
  s.willChange    = 'transform'
  overlayHost().appendChild(ghost)
  return { ghost, baseLeft: left, baseTop: top }
}

// ─── the drag ─────────────────────────────────────────────────────────────

function startDrag(arm, e) {
  const { zoneNode, itemEl, itemIdx, pointerId } = arm
  const entry = zoneRegistry.get(zoneNode)
  if (!entry || !itemEl.isConnected) return
  const cfg = entry.config

  const itemData = cfg.items.filter((it) => !it[SHADOW_ITEM_MARKER])[itemIdx]
  if (!itemData) return

  // Captured on <body> rather than the item: the host swaps the item's element
  // for the placeholder's on the first `onconsider`, and a capture held by a
  // removed element ends the pointer stream — on touch, the drag with it.
  try { document.body.setPointerCapture(pointerId) } catch { /* window listeners still cover a mouse */ }

  const itemRect = docRect(itemEl)

  session = {
    pointerId,
    originNode:  zoneNode,
    originIndex: itemIdx,
    itemData,
    itemId:      itemData[ITEM_ID_KEY],
    shadowItem:  { ...itemData, [ITEM_ID_KEY]: SHADOW_PLACEHOLDER_ITEM_ID, [SHADOW_ITEM_MARKER]: true },
    grabbedEl:   itemEl,
    dragW:       itemRect.width,
    dragH:       itemRect.height,
    zones:       [],
    current:     null,
    outside:     false,
    frozen:      false,   // between a cross-zone notify and the re-measure after it
    pointer:     { clientX: e.clientX, clientY: e.clientY },
    moved:       false,
    raf:         0,
    finalizing:  false,
  }

  for (const node of typeIndex.get(cfg.type) || []) {
    const zc = zoneRegistry.get(node)?.config
    if (!zc) continue
    if (zc.dropFromOthersDisabled && node !== zoneNode) continue
    const meta = { node, config: zc, depth: getDepth(node), placeholderIndex: null, expectedSig: sig(zc.items) }
    measureZone(meta)
    session.zones.push(meta)
  }
  session.zones.sort((a, b) => b.depth - a.depth)   // deepest first, for overlap
  session.grabbedEl = null                          // the shadow attribute marks the slot from here
  session.current = session.zones.find((z) => z.node === zoneNode)

  const { ghost, baseLeft, baseTop } = createGhost(itemEl, itemRect, e, cfg.centerOnCursor)
  session.ghost       = ghost
  session.ghostBase   = { left: baseLeft, top: baseTop }
  session.startClient = { x: e.clientX, y: e.clientY }
  cfg.transformDraggedElement?.(ghost, itemData, itemIdx)

  for (const z of session.zones) z.node.setAttribute(TARGET_ATTR, '')

  considerWithShadowAt(session.current, itemIdx, TRIGGERS.DRAG_STARTED)

  window.addEventListener('pointermove', onDragMove, { passive: true })
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragEnd)
  window.addEventListener('keydown', onDragKey)
  window.addEventListener('touchmove', blockTouchScroll, { passive: false })

  session.raf = requestAnimationFrame(tick)
}

function blockTouchScroll(e) {
  if (session) e.preventDefault()
}

function onDragMove(e) {
  if (!session || e.pointerId !== session.pointerId) return
  session.pointer.clientX = e.clientX
  session.pointer.clientY = e.clientY
  session.moved = true
}

function onDragKey(e) {
  if (!session || session.finalizing) return
  if (e.key === 'Escape') {
    // A pointer drag too: an unprevented Escape also closes the dialog the
    // list sits in. One a nested control already took is that control's.
    if (e.defaultPrevented) return
    e.preventDefault()
    cancelToOrigin()
  } else if (session.keyboard) {
    keyboardKey(e)
  }
}

// ─── the keyboard ─────────────────────────────────────────────────────────

let liveRegion = null

/** One region for the page, reused: a polite per-zone element would be torn
 *  down with the zone, taking the drop announcement with it. Moved into an
 *  open modal: the inert page behind one is out of the accessibility tree,
 *  and a region there announces nothing. */
function announce(message) {
  if (!liveRegion) {
    liveRegion = document.createElement('div')
    liveRegion.setAttribute(LIVE_ATTR, '')
    liveRegion.setAttribute('role', 'status')
    liveRegion.setAttribute('aria-live', 'assertive')
    liveRegion.setAttribute('aria-atomic', 'true')
    liveRegion.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap'
  }
  const host = overlayHost()
  if (liveRegion.parentNode !== host) host.appendChild(liveRegion)
  liveRegion.textContent = message
}

function where(meta) {
  return `position ${meta.placeholderIndex + 1} of ${itemsWithoutShadow(meta).length + 1}`
}

function labelOf(el) {
  return el.getAttribute('aria-label') || el.textContent.replace(/\s+/g, ' ').trim() || 'Item'
}

function startKeyboardDrag(zoneNode, itemEl, liftEvent) {
  const entry = zoneRegistry.get(zoneNode)
  if (!entry || !itemEl.isConnected) return
  const cfg      = entry.config
  const itemIdx  = Array.prototype.indexOf.call(zoneNode.children, itemEl)
  const itemData = cfg.items.filter((it) => !it[SHADOW_ITEM_MARKER])[itemIdx]
  if (!itemData) return

  const itemRect = docRect(itemEl)
  session = {
    keyboard:    true,
    pointerId:   null,
    originNode:  zoneNode,
    originIndex: itemIdx,
    itemData,
    itemId:      itemData[ITEM_ID_KEY],
    shadowItem:  { ...itemData, [ITEM_ID_KEY]: SHADOW_PLACEHOLDER_ITEM_ID, [SHADOW_ITEM_MARKER]: true },
    grabbedEl:   itemEl,
    label:       labelOf(itemEl),
    dragW:       itemRect.width,
    dragH:       itemRect.height,
    zones:       [],
    current:     null,
    outside:     false,
    frozen:      false,
    ghost:       null,
    keepFocus:   true,
    liftEvent,   // still bubbling to the window listener added below, which would drop it at once
    finalizing:  false,
  }
  const meta = { node: zoneNode, config: cfg, depth: getDepth(zoneNode), placeholderIndex: null, expectedSig: sig(cfg.items) }
  measureZone(meta)
  session.zones.push(meta)
  session.grabbedEl = null
  session.current   = meta
  zoneNode.setAttribute(TARGET_ATTR, '')

  considerWithShadowAt(meta, itemIdx, TRIGGERS.DRAG_STARTED)

  window.addEventListener('keydown', onDragKey)
  // A press elsewhere ends it: a lifted item that outlived the focus would
  // refuse every pointer drag after, with nothing on screen saying why.
  window.addEventListener('pointerdown', onKeyboardPointer, true)
  announce(`${session.label}, lifted, ${where(meta)}. Arrow keys move it, Space drops it, Escape cancels.`)
}

function onKeyboardPointer() {
  if (!session?.keyboard || session.finalizing) return
  session.keepFocus = false
  cancelToOrigin()
}

function keyboardKey(e) {
  if (e === session.liftEvent) return
  const meta = session.current
  if (e.key === ' ') {
    e.preventDefault()
    if (e.repeat) return
    announce(`${session.label}, dropped at ${where(meta)}.`)
    finishDrag(true)
    return
  }
  if (e.key === 'Tab') {
    session.keepFocus = false   // the Tab is moving focus on; the refocus would undo it
    cancelToOrigin()
    return
  }
  const horizontal = meta.axis === 'x'
  let step = 0
  if (e.key === (horizontal ? 'ArrowRight' : 'ArrowDown')) step = 1
  else if (e.key === (horizontal ? 'ArrowLeft' : 'ArrowUp')) step = -1
  if (!step) return
  e.preventDefault()
  if (meta.neg) step = -step
  const idx = Math.min(itemsWithoutShadow(meta).length, Math.max(0, meta.placeholderIndex + step))
  if (idx === meta.placeholderIndex) return
  considerWithShadowAt(meta, idx, TRIGGERS.DRAGGED_OVER_INDEX)
  announce(`${session.label}, ${where(meta)}.`)
}

/** A full re-measure one frame after a cross-zone notify — by then the host
 *  has rendered the lists that grew and shrank and marked the placeholder. */
function scheduleRemeasure() {
  session.frozen = true
  requestAnimationFrame(() => {
    if (!session || session.finalizing) return
    for (const z of session.zones) measureZone(z)
    session.frozen = false
  })
}

/** Per frame: one transform write for the ghost, the auto-scroll edge check,
 *  and the hit test, which is arithmetic. */
function tick() {
  if (!session || session.finalizing) return
  if (session.moved) {
    session.moved = false
    const { pointer, startClient } = session
    session.ghost.style.transform = `translate3d(${pointer.clientX - startClient.x}px, ${pointer.clientY - startClient.y}px, 0)`
  }
  autoScroll()
  if (!session.frozen) hitTest()
  session.raf = requestAnimationFrame(tick)
}

function leave(meta) {
  meta.placeholderIndex = null
  notify(meta.node, 'onconsider', itemsWithoutShadow(meta), TRIGGERS.DRAGGED_LEFT)
}

/** Whether a scroll ancestor's box hides the point from the zone. A zone's
 *  rect is its layout box, which stays put when an `overflow: auto` ancestor
 *  clips it; the pointer over the clipped pixels is over something else. */
function clippedAt(meta, clientX, clientY) {
  for (const { el } of meta.ancestors) {
    const r = el.getBoundingClientRect()
    const left = r.left + el.clientLeft
    const top  = r.top + el.clientTop
    if (!pointInRect(clientX, clientY, { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight })) return true
  }
  return false
}

function hitTest() {
  const px = session.pointer.clientX + window.scrollX
  const py = session.pointer.clientY + window.scrollY

  let target = null
  let cx = 0, cy = 0
  for (const meta of session.zones) {
    if (clippedAt(meta, session.pointer.clientX, session.pointer.clientY)) continue
    const { dx, dy } = ancestorDelta(meta)
    // An ancestor's scroll moves the zone on screen; moving the pointer by the
    // same delta and testing the old snapshot is the same question.
    if (pointInRect(px + dx, py + dy, meta.rect)) {
      target = meta
      cx = px + dx
      cy = py + dy
      break
    }
  }

  if (!target) {
    if (!session.outside) {
      const origin = session.zones.find((z) => z.node === session.originNode)
      if (session.current && session.current !== origin) leave(session.current)
      considerWithShadowAt(origin, session.originIndex, TRIGGERS.DRAGGED_LEFT_ALL)
      session.current = origin
      session.outside = true
      scheduleRemeasure()
    }
    return
  }
  session.outside = false

  // The zone's own scroll moves only its children — folded into the pointer
  // before it is compared with collapsed-space midpoints.
  if (target.selfScroll) {
    cx += target.node.scrollLeft - target.selfScroll.x0
    cy += target.node.scrollTop - target.selfScroll.y0
  }
  let m = target.axis === 'y' ? cy : cx
  const c = target.axis === 'y' ? cx : cy
  if (target.neg) m = -m

  if (target !== session.current) {
    if (session.current) leave(session.current)
    considerWithShadowAt(target, indexForPointer(target, m, c), TRIGGERS.DRAGGED_ENTERED)
    session.current = target
    scheduleRemeasure()
  } else {
    const idx = indexForPointer(target, m, c)
    if (idx !== target.placeholderIndex) {
      considerWithShadowAt(target, idx, TRIGGERS.DRAGGED_OVER_INDEX)
      // Moving the placeholder reflows every line after it, which the snapshot
      // cannot express as one shift the way a single line's can.
      if (target.lines) scheduleRemeasure()
    }
  }
}

function autoScroll() {
  const { clientX: x, clientY: y } = session.pointer
  const se = document.scrollingElement

  const candidates = []
  if (session.current) {
    if (session.current.selfScroll) candidates.push(session.current.node)
    for (const s of session.current.ancestors) candidates.push(s.el)
  }
  if (se) candidates.push(se)

  for (const el of candidates) {
    const r = el === se
      ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      : el.getBoundingClientRect()
    if (!pointInRect(x, y, r)) continue
    let sx = 0, sy = 0
    if (el.scrollHeight > el.clientHeight) {
      if (r.bottom - y < SCROLL_ZONE_PX) sy = SCROLL_ZONE_PX - (r.bottom - y)
      else if (y - r.top < SCROLL_ZONE_PX) sy = -(SCROLL_ZONE_PX - (y - r.top))
    }
    if (el.scrollWidth > el.clientWidth) {
      if (r.right - x < SCROLL_ZONE_PX) sx = SCROLL_ZONE_PX - (r.right - x)
      else if (x - r.left < SCROLL_ZONE_PX) sx = -(SCROLL_ZONE_PX - (x - r.left))
    }
    if (sx || sy) {
      el.scrollBy(sx * SCROLL_SPEED, sy * SCROLL_SPEED)
      return   // the deepest scroller wins
    }
  }
}

// ─── drop and cancel ──────────────────────────────────────────────────────

function cancelToOrigin() {
  const origin = session.zones.find((z) => z.node === session.originNode)
  if (session.current !== origin || origin.placeholderIndex !== session.originIndex) {
    if (session.current && session.current !== origin) leave(session.current)
    considerWithShadowAt(origin, session.originIndex, TRIGGERS.DRAGGED_LEFT_ALL)
    session.current = origin
  }
  session.outside = true
  if (session.keyboard) announce(`${session.label}, cancelled, back at ${where(origin)}.`)
  finishDrag(true)
}

function onDragEnd(e) {
  if (!session || e.pointerId !== session.pointerId) return
  finishDrag(false)
}

function finishDrag(skipAnimation) {
  if (session.finalizing) return
  session.finalizing = true
  cancelAnimationFrame(session.raf)
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragEnd)
  window.removeEventListener('keydown', onDragKey)
  window.removeEventListener('pointerdown', onKeyboardPointer, true)
  window.removeEventListener('touchmove', blockTouchScroll)
  try { document.body.releasePointerCapture(session.pointerId) } catch { /* already released */ }

  const target = session.current || session.zones.find((z) => z.node === session.originNode)
  const cfg    = target.config
  const animMs = skipAnimation ? 0 : cfg.dropAnimationMs

  const settle = () => {
    if (!session) return
    const finalItems = listOf(target).map((it) => (it[SHADOW_ITEM_MARKER] ? session.itemData : it))
    // The last line of the same defense: a list replaced in the frame of the
    // drop has had no chance to take the placeholder back.
    if (!finalItems.includes(session.itemData) && !finalItems.some((it) => it[ITEM_ID_KEY] === session.itemId))
      finalItems.splice(Math.min(target.placeholderIndex ?? Infinity, finalItems.length), 0, session.itemData)
    const trigger = session.outside ? TRIGGERS.DROPPED_OUTSIDE_OF_ANY : TRIGGERS.DROPPED_INTO_ZONE

    // `quiet`: the zone the drag was in is gone, so there is no list to hand
    // a drop to and nobody released anything.
    if (!session.quiet) {
      notify(target.node, 'onfinalize', finalItems, trigger)
      if (target.node !== session.originNode) {
        const origin = session.zones.find((z) => z.node === session.originNode)
        if (origin) notify(session.originNode, 'onfinalize', itemsWithoutShadow(origin), TRIGGERS.DROPPED_INTO_ANOTHER)
      }
    }

    session.ghost?.remove()
    for (const z of session.zones) z.node.removeAttribute(TARGET_ATTR)
    // The host swaps the placeholder's element for the item's own, and the
    // swap takes focus with it.
    if (session.keyboard && session.keepFocus) {
      const at = finalItems.indexOf(session.itemData)
      const zoneNode = target.node
      requestAnimationFrame(() => zoneNode.children[at]?.focus())
    }
    session = null
  }

  if (animMs > 0) {
    const ph = target.node.querySelector(`:scope > [${SHADOW_ATTR}]`)
    if (ph) {
      const to = docRectNoTransform(ph)
      const g = session.ghost
      g.style.transition = `transform ${animMs}ms ease`
      g.style.transform = `translate3d(${to.left - window.scrollX - session.ghostBase.left}px, ${to.top - window.scrollY - session.ghostBase.top}px, 0)`
      setTimeout(settle, animMs)
      return
    }
  }
  settle()
}

// ─── the attachment ───────────────────────────────────────────────────────

/**
 * @param {() => {
 *   items: Array<{id: any}>,
 *   type?: string,
 *   disabled?: boolean,
 *   dropFromOthersDisabled?: boolean,
 *   dropAnimationMs?: number,
 *   transformDraggedElement?: (ghost: HTMLElement, item: any, index: number) => void,
 *   centerOnCursor?: boolean,
 *   delayTouchStart?: boolean | number,
 *   dragHandleSelector?: string,
 *   onconsider?: (e: {items: any[], info: {trigger: string, id: any, source: string}}) => void,
 *   onfinalize?: (e: {items: any[], info: {trigger: string, id: any, source: string}}) => void,
 * }} getOptions
 */
export function dndzone(getOptions) {
  if (typeof getOptions !== 'function')
    throw new TypeError('dndzone: pass a getter — dndzone(() => ({ items, … })) — or {@attach} rebuilds the zone on every update')

  return (node) => {
    const config = { ...DEFAULTS }
    zoneRegistry.set(node, { config })
    let lastArmEvent = null

    const touchDelayMs = () => {
      const d = config.delayTouchStart
      if (d === true) return DEFAULT_TOUCH_DELAY_MS
      if (typeof d === 'number' && Number.isFinite(d) && d >= 0) return d
      return 0
    }

    // ── arming: one delegated listener per zone, not one per item ──────────

    function onPointerDown(e) {
      if (config.disabled || session) return
      // One press bubbles through every zone it is nested in, and the
      // innermost has already armed on it. Any OTHER press finding `armed` set
      // is looking at one whose release never reached the window (let go
      // outside the browser), which would otherwise refuse every press after.
      if (armed?.event === e) return
      if (armed) armed.disarm()
      if (e.pointerType === 'mouse' && e.button !== 0) return

      let itemEl = e.target
      while (itemEl && itemEl.parentElement !== node) itemEl = itemEl.parentElement
      if (!itemEl) return

      if (config.dragHandleSelector) {
        // Only the handle drags, and a handle is exempt from the interactive
        // guard below because a handle is usually a <button>.
        const handle = e.target.closest?.(config.dragHandleSelector)
        if (!handle || !itemEl.contains(handle)) return
      } else if (e.target.closest?.(INTERACTIVE_SELECTOR)) {
        return
      }

      if (e.pointerType !== 'touch') e.preventDefault()   // no text selection, no native drag

      armed = {
        zoneNode:    node,
        itemEl,
        itemIdx:     Array.prototype.indexOf.call(node.children, itemEl),
        pointerId:   e.pointerId,
        startX:      e.clientX,
        startY:      e.clientY,
        isTouch:     e.pointerType === 'touch',
        holdElapsed: false,
        timer:       0,
        event:       e,
        disarm,
      }
      lastArmEvent = e

      const delay = armed.isTouch ? touchDelayMs() : 0
      if (delay > 0) {
        armed.timer = window.setTimeout(() => {
          if (!armed) return
          const a = armed
          a.holdElapsed = true
          disarm()
          startDrag(a, lastArmEvent)
        }, delay)
      }

      window.addEventListener('pointermove', onArmMove, { passive: true })
      window.addEventListener('pointerup', onArmEnd)
      window.addEventListener('pointercancel', onArmEnd)
      // An immediate touch drag has to own the gesture from the first move,
      // or the browser starts a pan and answers with pointercancel.
      if (armed.isTouch && delay === 0)
        window.addEventListener('touchmove', blockArmedTouchScroll, { passive: false })
    }

    function blockArmedTouchScroll(e) {
      if (armed || session) e.preventDefault()
    }

    function onArmMove(e) {
      if (!armed || e.pointerId !== armed.pointerId) return
      lastArmEvent = e
      const moved = Math.abs(e.clientX - armed.startX) >= START_THRESHOLD_PX || Math.abs(e.clientY - armed.startY) >= START_THRESHOLD_PX
      if (!moved) return
      if (armed.isTouch && touchDelayMs() > 0 && !armed.holdElapsed) {
        disarm()   // a move inside the hold is a scroll — the browser keeps it
        return
      }
      const a = armed
      disarm()
      startDrag(a, e)
    }

    function onArmEnd() { disarm() }

    // Removes THIS zone's listeners and clears `armed` only when this zone owns
    // it. Clearing another zone's arm would leave that zone's window listeners
    // attached with nothing that ever removes them.
    function disarm() {
      if (armed?.zoneNode === node) {
        clearTimeout(armed.timer)
        armed = null
      }
      window.removeEventListener('pointermove', onArmMove)
      window.removeEventListener('pointerup', onArmEnd)
      window.removeEventListener('pointercancel', onArmEnd)
      window.removeEventListener('touchmove', blockArmedTouchScroll)
    }

    node.addEventListener('pointerdown', onPointerDown)

    // ── lifting by keyboard ─────────────────────────────────────────────────

    function onKeyDown(e) {
      if (config.disabled || session || e.key !== ' ' || e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      let itemEl = e.target
      while (itemEl && itemEl.parentElement !== node) itemEl = itemEl.parentElement
      if (!itemEl) return
      if (config.dragHandleSelector) {
        const handle = e.target.closest?.(config.dragHandleSelector)
        if (!handle || !itemEl.contains(handle)) return
      } else if (e.target !== itemEl) {
        return   // Space inside a control in the item is the control's
      }
      e.preventDefault()
      startKeyboardDrag(node, itemEl, e)
    }

    node.addEventListener('keydown', onKeyDown)

    // ── configure: on mount and after every change the getter reads ────────

    function configure(opts) {
      if (!opts || !Array.isArray(opts.items)) throw new Error("dndzone: no 'items' array provided")
      for (const k in opts)
        if (!(k in DEFAULTS)) throw new Error(`dndzone: unknown option '${k}' — known: ${Object.keys(DEFAULTS).join(', ')}`)

      const prevType = config.type
      Object.assign(config, DEFAULTS, opts, {
        type:            opts.type ?? DEFAULT_TYPE,
        items:           [...opts.items],
        dropAnimationMs: opts.dropAnimationMs ?? DEFAULT_DROP_MS,
      })

      if (prevType !== config.type) {
        typeIndex.get(prevType)?.delete(node)
        if (typeIndex.get(prevType)?.size === 0) typeIndex.delete(prevType)
      }
      if (!typeIndex.has(config.type)) typeIndex.set(config.type, new Set())
      typeIndex.get(config.type).add(node)

      const cursor  = config.disabled ? '' : 'grab'
      const select  = config.disabled ? '' : 'none'
      const handles = config.dragHandleSelector
      const focusable = !config.disabled && !handles
      for (const child of node.children) {
        if (focusable && !child.hasAttribute('tabindex')) {
          child.setAttribute('tabindex', '0')
          child.setAttribute(TAB_ATTR, '')
        } else if (!focusable && child.hasAttribute(TAB_ATTR)) {
          child.removeAttribute('tabindex')
          child.removeAttribute(TAB_ATTR)
        }
        // Each write is guarded: this runs on every change to `items`, and a
        // write of the value already there is still a mutation record per row.
        if (child.draggable) child.draggable = false   // the native HTML5 drag would start alongside this one
        const rowCursor = handles ? '' : cursor
        if (child.style.cursor !== rowCursor) child.style.cursor = rowCursor
        if (child.style.userSelect !== select) child.style.userSelect = select
        if (child.style.webkitUserSelect !== select) child.style.webkitUserSelect = select
      }
      if (handles) for (const h of node.querySelectorAll(handles)) if (h.style.cursor !== cursor) h.style.cursor = cursor

      if (!session) return
      // The host has rendered the list this module last handed it — find the
      // placeholder among its children and hide it. A stale mark is cleared
      // first: the placeholder moves, and an element the keyed `{#each}` kept
      // would otherwise stay invisible after it stopped being the placeholder.
      const shadowIdx = config.items.findIndex((it) => it[SHADOW_ITEM_MARKER])
      for (let i = 0; i < node.children.length; i++) {
        const el = node.children[i]
        if (i === shadowIdx) {
          if (!el.hasAttribute(SHADOW_ATTR)) {
            el.setAttribute(SHADOW_ATTR, '')
            el.style.cursor = ''
            if (!session.keyboard) {
              el.style.visibility = 'hidden'
              config.transformDraggedElement?.(session.ghost, session.itemData, shadowIdx)
            }
          }
          // The keyed each moves the element on a reorder, and a moved element
          // drops focus.
          if (session.keyboard && !session.finalizing && document.activeElement !== el) el.focus()
        } else if (el.hasAttribute(SHADOW_ATTR)) {
          el.removeAttribute(SHADOW_ATTR)
          el.style.visibility = ''
        }
      }
      // A list that is not what this module last handed over was changed by
      // something else mid-drag — a live update, another user — so its
      // snapshot describes DOM that is gone.
      const meta = session.zones.find((z) => z.node === node)
      if (meta) {
        const s = sig(config.items)
        if (s !== meta.expectedSig) {
          meta.expectedSig = s
          meta.handed = null
          // A list pushed without the placeholder has nowhere for the drop to
          // land: the last index would name a real row as the placeholder, and
          // a drop in place finalized a list missing the dragged item in BOTH
          // zones — a host persisting from onfinalize deleted it (`FJS-2583`).
          // Put it back where it was, clamped; the next hit test corrects it.
          const was = meta.placeholderIndex
          const lost = !config.items.some((it) => it[SHADOW_ITEM_MARKER])
          if (lost) meta.placeholderIndex = null
          measureZone(meta)
          if (lost && session.current === meta && !session.finalizing) {
            considerWithShadowAt(meta, Math.min(was ?? Infinity, itemsWithoutShadow(meta).length), TRIGGERS.DRAGGED_OVER_INDEX)
            scheduleRemeasure()
          }
        }
      }
    }

    // A user effect drains after the renders in the same flush, so `configure`
    // reads the zone's children once the host's `{#each}` has rebuilt them —
    // the order the placeholder search depends on.
    const stop = createEffect(() => configure(getOptions()), { user: true })

    return () => {
      stop()
      node.removeEventListener('pointerdown', onPointerDown)
      node.removeEventListener('keydown', onKeyDown)
      disarm()
      zoneRegistry.delete(node)
      typeIndex.get(config.type)?.delete(node)
      if (typeIndex.get(config.type)?.size === 0) typeIndex.delete(config.type)
      if (session && !session.finalizing) {
        const gone = session.current?.node === node
        if (session.originNode !== node) session.zones = session.zones.filter((z) => z.node !== node)
        if (session.originNode === node) {
          // Nowhere to cancel to. A drop into another live zone stands as the
          // person saw it; otherwise nothing is released to anyone.
          if (gone || !session.current) session.quiet = true
          finishDrag(true)
        } else if (gone) {
          session.current = null
          cancelToOrigin()
        }
      }
    }
  }
}
