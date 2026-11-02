// web/src/lib/town.js
// The Autopilot town as geometry and replay: where each building stands, which
// road a dot takes between two of them, and what the day looked like at a
// moment. Pure, so the screen only draws it. IDEAS/autopilot.md § The town.

/** A dot takes this long, at 1x, to cross town; at a replay speed it is this times the rate in day-ms. */
export const TRAVEL_REAL = 1100

export const LANE_Y = [50, 174, 298, 422, 546]

// Roads are a node graph; a building's door is a spur to one node.
const N = {
  w230: [260, 230], w485: [260, 485], w625: [260, 625],
  c495: [495, 230], e230: [720, 230], f820: [820, 230], p1000: [1000, 230], x1080: [1080, 230],
  s495: [495, 485], e485: [720, 485], pl910: [910, 485], gate: [1072, 485],
  rv370: [370, 625], sw590: [590, 625], e625: [720, 625], po350: [720, 350],
}
LANE_Y.forEach((y, i) => { N['l' + (i + 1)] = [260, y + 50] })

export const ROADS = [
  ['l1', 'l2', 'w230', 'l3', 'l4', 'w485', 'l5', 'w625'],
  ['w230', 'c495', 'e230', 'f820', 'p1000', 'x1080'],
  ['w485', 's495', 'e485', 'pl910', 'gate'],
  ['w625', 'rv370', 'sw590', 'e625'],
  ['e230', 'po350', 'e485', 'e625'],
]
export const nodeAt = (k) => N[k]

const ADJ = {}
for (const r of ROADS) for (let i = 1; i < r.length; i++) {
  const a = r[i - 1], b = r[i], d = Math.hypot(N[a][0] - N[b][0], N[a][1] - N[b][1])
  ;(ADJ[a] ||= []).push([b, d]); (ADJ[b] ||= []).push([a, d])
}

function shortest(a, b) {
  const dist = { [a]: 0 }, prev = {}, todo = new Set(Object.keys(N))
  while (todo.size) {
    let u = null
    for (const k of todo) if (dist[k] != null && (u == null || dist[k] < dist[u])) u = k
    if (u == null) break
    todo.delete(u)
    if (u === b) break
    for (const [v, d] of ADJ[u] || []) if (dist[u] + d < (dist[v] ?? Infinity)) { dist[v] = dist[u] + d; prev[v] = u }
  }
  const path = [b]
  while (path[0] !== a) { const p = prev[path[0]]; if (!p) break; path.unshift(p) }
  return { path, d: dist[b] ?? Infinity }
}

/** Every building: its box and the doors (x, y, road node) its spurs leave by. */
export const B = {
  registry: { name: 'Registry', x: 290, y: 258, w: 410, h: 200, doors: [[495, 258, 'c495'], [495, 458, 's495']],
    stands: 'ISSUES.md. Crates on three tables: ready, blocked, busy. A crate closed today leaves by the door.', reads: 'ISSUES.md, the lane locks' },
  council: { name: 'Council', x: 290, y: 40, w: 410, h: 162, doors: [[495, 202, 'c495']],
    stands: 'DECISIONS.md and every paper\'s open questions: open in the hall, decidable at the bench, ruled on the wall.', reads: 'DECISIONS.md, IDEAS/' },
  framing: { name: 'Framing desk', x: 740, y: 40, w: 160, h: 112, doors: [[820, 152, 'f820']],
    stands: 'frame-loop at work on one paper.', reads: '~/.fli/frame-loop.jsonl' },
  post: { name: 'Post', x: 920, y: 40, w: 160, h: 112, doors: [[1000, 152, 'p1000']], later: true,
    stands: 'Rulings asked of the owner, and answers back (Phase 4; IDEAS/phone-ping.md).', reads: 'the ntfy topic' },
  plans: { name: 'Plan office', x: 740, y: 250, w: 340, h: 208, doors: [[740, 350, 'po350'], [910, 458, 'pl910']],
    stands: 'The stressors as sites under construction, then the IDEAS/ papers nearest completion.', reads: 'fli plan <paper>' },
  proving: { name: 'Proving ground', x: 740, y: 515, w: 300, h: 140, doors: [[910, 515, 'pl910']],
    stands: 'Drives and stressor checks running; CI\'s last run as the gate at the edge of town.', reads: '.cache/ci-last.txt' },
  dock: { name: 'Dock', x: 330, y: 515, w: 330, h: 88, doors: [[495, 515, 's495']],
    stands: 'Harvested fixes waiting to land: a patch per closed row on the patch path.', reads: '~/.fli/lanes/patches' },
  review: { name: 'Review', x: 290, y: 645, w: 170, h: 70, doors: [[370, 645, 'rv370']],
    stands: 'loop-review\'s last report: what repeated.', reads: '~/.fli/fix-loop-review.md' },
  switch: { name: 'Switch', x: 490, y: 645, w: 210, h: 70, doors: [[590, 645, 'sw590']],
    stands: 'Turn On / Off, the schedule table, today\'s spend against the cap.', reads: '~/.fli/autopilot.json' },
}
LANE_Y.forEach((y, i) => {
  const n = i + 1
  B['lane.' + n] = { name: 'Lane ' + n, lane: n, x: 30, y, w: 190, h: 100, doors: [[220, y + 50, 'l' + n]],
    stands: 'One fix-loop lane: the row on the bench, the model and effort, cost and turns ticking.', reads: '~/.fli/lanes, ~/.fli/fix-loop.jsonl' }
})

// Where an event's endpoint stands: a room inside a building, or its middle.
const ANCHOR = {
  'registry.ready': ['registry', 360, 370], 'registry.blocked': ['registry', 495, 370], 'registry.busy': ['registry', 630, 370],
  'council.open': ['council', 358, 130], 'council.bench': ['council', 495, 130], 'council.wall': ['council', 632, 130],
}
for (const id in B) if (!ANCHOR[id]) ANCHOR[id] = [id, B[id].x + B[id].w / 2, B[id].y + B[id].h / 2 + (id.startsWith('lane') ? 12 : 0)]

/** The building an event endpoint belongs to; a name the map does not know is the Registry. */
export const bOf = (id) => (ANCHOR[id] || ['registry'])[0]
export const nameOf = (id) => B[bOf(id)].name

const ROUTES = {}
function route(from, to) {
  const k = from + '>' + to
  if (ROUTES[k]) return ROUTES[k]
  const A = ANCHOR[from] || ANCHOR.registry, Z = ANCHOR[to] || ANCHOR.registry
  let pts
  if (A[0] === Z[0]) pts = [[A[1], A[2]], [Z[1], Z[2]]]
  else {
    let best = null
    for (const da of B[A[0]].doors) for (const dz of B[Z[0]].doors) {
      const s = shortest(da[2], dz[2])
      const tot = s.d + Math.hypot(da[0] - N[da[2]][0], da[1] - N[da[2]][1]) + Math.hypot(dz[0] - N[dz[2]][0], dz[1] - N[dz[2]][1])
      if (!best || tot < best.tot) best = { tot, da, dz, path: s.path }
    }
    pts = [[A[1], A[2]], [best.da[0], best.da[1]], ...best.path.map(p => N[p]), [best.dz[0], best.dz[1]], [Z[1], Z[2]]]
  }
  const seg = []
  let L = 0
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); L += d }
  return ROUTES[k] = { pts, seg, L }
}

function along(r, f) {
  let d = f * r.L
  for (let i = 0; i < r.seg.length; i++) {
    if (d <= r.seg[i] || i === r.seg.length - 1) {
      const g = r.seg[i] ? Math.min(1, d / r.seg[i]) : 1, a = r.pts[i], b = r.pts[i + 1]
      return [a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g]
    }
    d -= r.seg[i]
  }
  return r.pts.at(-1)
}

/** The log's events with an index and a millisecond time, in order. */
export const withTime = (events) => (events ?? []).map((e, i) => ({ ...e, i, ms: Date.parse(e.t) }))

/** Dots in flight at `t`: an event is a dot for `TRAVEL_REAL * rate` of day-time after it happened. */
export function dotsAt(events, t, rate) {
  const travel = TRAVEL_REAL * rate
  const out = []
  for (const e of events) {
    if (e.ms > t) break
    if (t - e.ms > travel) continue
    const [x, y] = along(route(e.from, e.to), Math.min(1, (t - e.ms) / travel))
    out.push({ i: e.i, kind: e.kind, x: +x.toFixed(1), y: +y.toFixed(1), e })
  }
  return out
}

/** What the day had come to by `t`: each lane's bench, the Dock's harvests, spend, the door's count. */
export function stateAt(events, t) {
  const past = events.filter(e => e.ms <= t)
  const lanes = {}
  for (let n = 1; n <= 5; n++) {
    const id = 'lane.' + n
    const starts = past.filter(e => e.to === id && e.label.startsWith('started'))
    const last = starts.at(-1)
    let cur = null
    if (last) {
      const term = events.find(e => e.ms >= last.ms && e.i > last.i && e.from === id && e.id === last.id && !e.label.startsWith('harvest'))
      if (!term || term.ms > t) {
        const frac = term ? (t - last.ms) / Math.max(1, term.ms - last.ms) : 0
        cur = { row: last.id, sev: last.sev, model: last.model, effort: last.effort, min: (t - last.ms) / 6e4,
                cost: term?.cost != null ? term.cost * frac : null, turns: term?.turns != null ? Math.round(term.turns * frac) : null }
      }
    }
    const done = past.filter(e => e.from === id && e.cost != null)
    lanes[n] = { cur, spend: done.reduce((s, e) => s + e.cost, 0), attempts: starts.length, closed: done.filter(e => e.label === 'closed').length, last: done.at(-1) }
  }
  const harvests = past.filter(e => e.label.startsWith('harvest'))
  return {
    lanes, harvests, past,
    files: harvests.reduce((s, e) => s + (+(/(\d+) file/.exec(e.label) || [0, 0])[1]), 0),
    closed: past.filter(e => e.label === 'closed').length,
    filed: past.filter(e => e.kind === 'question' && e.to === 'council.open').length,
    spend: past.filter(e => e.cost != null).reduce((s, e) => s + e.cost, 0) + Object.values(lanes).reduce((s, l) => s + (l.cur?.cost || 0), 0),
  }
}

/** Bars for the scrubber: how many events fell in each of `bins` slices of the window, as 0..1 heights. */
export function histogram(events, t0, t1, bins = 96) {
  const cnt = Array(bins).fill(0)
  for (const e of events) cnt[Math.max(0, Math.min(bins - 1, Math.floor((e.ms - t0) / Math.max(1, t1 - t0) * bins)))]++
  const max = Math.max(1, ...cnt)
  return cnt.map((c, i) => ({ i, h: c / max })).filter(b => b.h > 0)
}

export const SITES = 8

/**
 * What the Plan office draws: every stressor first, then the papers nearest
 * completion (a paper with no box done is not under construction), eight in
 * all. `rest` is what the place card lists instead.
 */
export function officeSites(plans) {
  const ratio = p => p.done / Math.max(1, p.steps)
  const stressors = (plans?.stressors ?? []).map(p => ({ ...p, stressor: true }))
  const papers = (plans?.papers ?? []).filter(p => p.done >= 1).sort((a, b) => ratio(b) - ratio(a) || b.done - a.done)
  const all = [...stressors, ...papers]
  return { sites: all.slice(0, SITES), rest: all.slice(SITES), total: (plans?.papers?.length ?? 0) + stressors.length }
}
