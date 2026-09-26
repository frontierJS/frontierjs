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
 * Callbacks rather than `on:consider`: Mesa delegates `on:` to the mount root,
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
 * Not built: keyboard and screen-reader dragging, nested zones of one type,
 * grid and flex-wrap layouts (a flow list only, vertical or horizontal,
 * detected per zone from its first two children).
 */

import { createEffect } from '@frontierjs/mesa/runtime'

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

/** Insertion index for a content-space main-axis coordinate. Monotonic in `m`,
 *  which is what keeps the placeholder from flickering between two slots. */
function indexForPointer(meta, m) {
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
  cfg?.[which]?.({ items, info: { trigger, id: session.itemId, source: 'pointer' } })
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
  // The clone is reparented to <body>, where a rule keyed on an ancestor and
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
  document.body.appendChild(ghost)
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
  if (e.key === 'Escape' && session && !session.finalizing) cancelToOrigin()
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

function hitTest() {
  const px = session.pointer.clientX + window.scrollX
  const py = session.pointer.clientY + window.scrollY

  let target = null
  let cx = 0, cy = 0
  for (const meta of session.zones) {
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
  if (target.neg) m = -m

  if (target !== session.current) {
    if (session.current) leave(session.current)
    considerWithShadowAt(target, indexForPointer(target, m), TRIGGERS.DRAGGED_ENTERED)
    session.current = target
    scheduleRemeasure()
  } else {
    const idx = indexForPointer(target, m)
    if (idx !== target.placeholderIndex) considerWithShadowAt(target, idx, TRIGGERS.DRAGGED_OVER_INDEX)
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
  window.removeEventListener('touchmove', blockTouchScroll)
  try { document.body.releasePointerCapture(session.pointerId) } catch { /* already released */ }

  const target = session.current || session.zones.find((z) => z.node === session.originNode)
  const cfg    = target.config
  const animMs = skipAnimation ? 0 : cfg.dropAnimationMs

  const settle = () => {
    if (!session) return
    const finalItems = listOf(target).map((it) => (it[SHADOW_ITEM_MARKER] ? session.itemData : it))
    const trigger = session.outside ? TRIGGERS.DROPPED_OUTSIDE_OF_ANY : TRIGGERS.DROPPED_INTO_ZONE

    notify(target.node, 'onfinalize', finalItems, trigger)
    if (target.node !== session.originNode) {
      const origin = session.zones.find((z) => z.node === session.originNode)
      if (origin) notify(session.originNode, 'onfinalize', itemsWithoutShadow(origin), TRIGGERS.DROPPED_INTO_ANOTHER)
    }

    session.ghost.remove()
    for (const z of session.zones) z.node.removeAttribute(TARGET_ATTR)
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
      if (typeof d === 'number' && isFinite(d) && d >= 0) return d
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
      for (const child of node.children) {
        child.draggable = false   // the native HTML5 drag would start alongside this one
        child.style.cursor = handles ? '' : cursor
        child.style.userSelect = select
        child.style.webkitUserSelect = select
      }
      if (handles) for (const h of node.querySelectorAll(handles)) h.style.cursor = cursor

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
            el.style.visibility = 'hidden'
            el.style.cursor = ''
            config.transformDraggedElement?.(session.ghost, session.itemData, shadowIdx)
          }
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
          measureZone(meta)
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
      disarm()
      zoneRegistry.delete(node)
      typeIndex.get(config.type)?.delete(node)
      if (typeIndex.get(config.type)?.size === 0) typeIndex.delete(config.type)
      if (session && !session.finalizing) {
        if (session.current?.node === node || session.originNode === node) finishDrag(true)
        else session.zones = session.zones.filter((z) => z.node !== node)
      }
    }
  }
}
