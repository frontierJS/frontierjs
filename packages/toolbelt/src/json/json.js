/*
 * json.js — reading and editing a JSON document nothing describes.
 *
 * Every other shape this framework renders arrives with a schema: a column has
 * a type, a rule and a control chosen for it by one table. A `Json` column is
 * the exception — the seed says `Json` and stops, so the only description of
 * what is inside is the value itself. That is why this kit exists and why it
 * lives here rather than in a component: deciding what a value IS, what an
 * edit does to it, and which rows a tree shows are pure questions, and the
 * answers are needed by a viewer, by a form control and by a test that runs in
 * plain node with no DOM.
 *
 * ── What the shape of an edit has to be ───────────────────────────────
 *
 * Editing in place is the obvious implementation and it is the one that fails.
 * A tree that mutates the caller's object cannot be undone, cannot be diffed
 * against what was loaded, and reaches a reactive runtime as a value that is
 * `===` to the one it replaced — so nothing re-renders. Worse, the two edits a
 * person makes most often are the two an in-place model gets wrong: renaming a
 * key by `delete` + set moves the field to the end of the object, and removing
 * an array item by identity (`findIndex(v => v === item)`) removes the FIRST
 * equal item, which for `["a", "b", "a"]` is not the one that was clicked.
 *
 * So every write here is a copy: `setIn`, `removeIn`, `insertIn`, `renameKey`
 * return a new document and never touch the one they were handed. Key order is
 * preserved because in a JSON document key order is the only ordering there is,
 * and a rename that reorders the form is a change nobody asked for.
 *
 * ── Paths ─────────────────────────────────────────────────────────────
 *
 * A location inside the document is an ARRAY of keys and indices —
 * `['address', 'city']`, `['tags', 0]` — and never a joined string. A joined
 * string is not injective over the values a JSON key may hold: an object with
 * the key `a.b` and an object with `a` containing `b` produce one path, and a
 * view keyed by it collapses two nodes into one. `pathKey()` is for the places
 * that need a string anyway (an expand set, an `{#each}` key) and it is JSON,
 * which is injective for exactly the reason the naive join is not.
 */

// ── What a value is ───────────────────────────────────────────────────────────

/**
 * The kind of a value, as a JSON document sees it.
 *
 * `null` is its own answer rather than 'object', which is what `typeof` says
 * and has never once been what a caller meant. A `Date` is named because a
 * document held in memory can carry one before it is serialized — a value read
 * off a Litestone row, say — and rendering it as `{}` (which is what walking
 * its own keys produces) is a value silently disappearing.
 *
 * @param {*} value
 * @returns {'null'|'boolean'|'number'|'string'|'array'|'date'|'object'|'unsupported'}
 */
export function classify(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'array'
  if (value instanceof Date) return 'date'

  switch (typeof value) {
    case 'boolean': return 'boolean'
    case 'number':  return 'number'
    case 'string':  return 'string'
    case 'object':  return 'object'
    // A function, a symbol or a bigint cannot survive JSON.stringify — the
    // first two vanish and the third throws — so a view that renders them as
    // values is describing a document that cannot be saved.
    default:        return 'unsupported'
  }
}

/** True for the two kinds that contain other values. */
export function isContainer(value) {
  const k = classify(value)
  return k === 'array' || k === 'object'
}

/**
 * What kind of array this is, which is what decides how it can be edited.
 *
 * An array of objects is a table, an array of primitives is a list, and an
 * array holding both is neither — there is no column set that describes it and
 * no single control that edits a cell of it, so a mixed array is handed back to
 * raw text rather than drawn as a shape it does not have.
 *
 * @param {*} value
 * @returns {'empty'|'objects'|'primitives'|'mixed'|'not-an-array'}
 */
export function arrayKind(value) {
  if (!Array.isArray(value)) return 'not-an-array'
  if (value.length === 0) return 'empty'

  let objects = 0
  for (const item of value) if (isContainer(item)) objects++

  if (objects === value.length) return 'objects'
  if (objects === 0) return 'primitives'
  return 'mixed'
}

/**
 * The union of every key in a list of objects, in order of first appearance.
 *
 * First appearance rather than sorted: the author's order is the only stated
 * order a JSON document has, and sorting throws it away to replace it with one
 * nobody chose. Rows that are not objects contribute nothing rather than
 * refusing — a mixed array still has columns for the half that has them.
 *
 * @param {Array} rows
 * @returns {string[]}
 */
export function mergeKeys(rows) {
  const seen = new Set()
  if (!Array.isArray(rows)) return []

  for (const row of rows) {
    if (classify(row) !== 'object') continue
    for (const key of Object.keys(row)) seen.add(key)
  }

  return [...seen]
}

/**
 * A one-line description of a container, for a collapsed row.
 *
 * @param {*} value
 * @returns {{kind: string, size: number|null, preview: string}}
 */
export function summarize(value) {
  const kind = classify(value)

  if (kind === 'array')  return { kind, size: value.length, preview: preview(value) }
  if (kind === 'object') return { kind, size: Object.keys(value).length, preview: preview(value) }

  return { kind, size: null, preview: preview(value) }
}

/** The compact form of a value, clipped. Never throws — a cycle previews as its kind. */
export function preview(value, max = 80) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = `[${classify(value)}]`
  }
  if (text === undefined) text = String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// ── Text ⇄ document ───────────────────────────────────────────────────────────

/**
 * Parse text, and say why it failed.
 *
 * Answers a result rather than a value because every caller here has to render
 * the failure: an editor that only knows the text is invalid can say so, and an
 * editor that knows `Unexpected token } in JSON at position 42` can point at
 * it. The legacy shape of this function returned `undefined` for a failure AND
 * for a valid document that happened to be `null` — and it rejected `1`,
 * `"text"` and `true` as invalid, which are three of the seven things a JSON
 * document may be.
 *
 * @param {string} text
 * @returns {{ok: true, value: *} | {ok: false, error: string, position: number|null}}
 */
export function tryParse(text) {
  if (typeof text !== 'string') {
    return { ok: false, error: 'not text', position: null }
  }

  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    const message = (e && e.message) || String(e)
    // V8 and JavaScriptCore both name a position and word it differently.
    const at = message.match(/position (\d+)/)
    return { ok: false, error: message, position: at ? Number(at[1]) : null }
  }
}

/**
 * The document as text, pretty-printed.
 *
 * A value JSON cannot express is answered as `''` rather than throwing, since
 * every caller is a view: a textarea that throws while rendering takes the
 * screen with it, and an empty one at least says *there is nothing to edit*.
 */
export function format(value, indent = 2) {
  try {
    const text = JSON.stringify(value, null, indent)
    return text === undefined ? '' : text
  } catch {
    return ''
  }
}

/**
 * Give an edited string the type the value it replaces had.
 *
 * Every control that edits a JSON leaf hands back a string, and a document that
 * takes them at face value degrades one type per edit until a number column is
 * `"42"` and a boolean is `"false"` — which is truthy. This is the same job
 * `coerceToSchema` does at the Data boundary and it cannot be that function: a
 * `Json` column has no schema to coerce against, so the only statement of what
 * this value should be is what it currently is.
 *
 * A string that no longer parses as the original type is kept as the string.
 * Refusing the edit would trap the person mid-keystroke — `-` is not a number
 * and is the first character of one.
 *
 * @param {*} original  the value being replaced
 * @param {*} next      what the control handed back
 */
export function coerceLike(original, next) {
  if (typeof next !== 'string') return next

  switch (classify(original)) {
    case 'boolean': {
      if (next === 'true')  return true
      if (next === 'false') return false
      return next
    }

    case 'number': {
      if (next.trim() === '') return next
      const n = Number(next)
      return Number.isFinite(n) ? n : next
    }

    case 'null': {
      return next === 'null' ? null : next
    }

    // A container edited as text is only committed when it parses — a partial
    // `{"a":` is what a half-typed object looks like and is not a string the
    // caller meant to store.
    case 'array':
    case 'object': {
      const parsed = tryParse(next)
      return parsed.ok ? parsed.value : next
    }

    default:
      return next
  }
}

// ── Paths ─────────────────────────────────────────────────────────────────────

/**
 * A path as a string, for the places that can only hold one.
 *
 * JSON rather than a join, because a JSON key may contain any character at all:
 * `['a.b']` and `['a', 'b']` join to one string and are two different nodes.
 * The same injectivity argument `/history` makes about an occurrence key, for
 * the same reason — a view keyed by a colliding string shows one node where
 * there are two, and an expand set keyed by it opens both at once.
 */
export function pathKey(path) {
  return JSON.stringify(Array.isArray(path) ? path : [])
}

/** The value at `path`, or `undefined` where the path does not lead anywhere. */
export function getIn(value, path) {
  if (!Array.isArray(path)) return undefined

  let cur = value
  for (const step of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[step]
  }
  return cur
}

/**
 * A copy of the document with `path` set to `next`.
 *
 * Copies only the containers ALONG the path — everything beside it is shared,
 * so setting one cell of a thousand-row document copies the depth of the tree
 * and not the tree. The parts that are copied are copied whole, so key order
 * survives.
 *
 * A path into a value that is not a container is refused by name: the
 * alternative is inventing the container, which turns a typo into a silently
 * restructured document.
 */
export function setIn(value, path, next) {
  if (!Array.isArray(path) || path.length === 0) return next

  const [head, ...rest] = path

  if (Array.isArray(value)) {
    const index = Number(head)
    if (!Number.isInteger(index) || index < 0 || index >= value.length) {
      throw new RangeError(`setIn: ${JSON.stringify(head)} is not an index of this array (length ${value.length})`)
    }
    const copy = value.slice()
    copy[index] = rest.length ? setIn(value[index], rest, next) : next
    return copy
  }

  if (value !== null && typeof value === 'object') {
    const copy = { ...value }
    copy[head] = rest.length ? setIn(value[head], rest, next) : next
    return copy
  }

  throw new TypeError(`setIn: cannot descend into a ${classify(value)} at ${JSON.stringify(head)}`)
}

/**
 * A copy of the document with `path` removed.
 *
 * An array element is spliced and an object key is deleted, which are different
 * enough that a caller cannot be asked to know which one it is doing — the
 * container decides. Removing by INDEX is the whole point: the legacy tree
 * removed by value identity, so a duplicate primitive removed the wrong one.
 */
export function removeIn(value, path) {
  if (!Array.isArray(path) || path.length === 0) return value

  const parentPath = path.slice(0, -1)
  const last       = path[path.length - 1]
  const parent     = parentPath.length ? getIn(value, parentPath) : value

  if (Array.isArray(parent)) {
    const index = Number(last)
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) return value
    const copy = parent.slice()
    copy.splice(index, 1)
    return parentPath.length ? setIn(value, parentPath, copy) : copy
  }

  if (parent !== null && typeof parent === 'object') {
    if (!Object.prototype.hasOwnProperty.call(parent, last)) return value
    const copy = {}
    for (const [k, v] of Object.entries(parent)) if (k !== last) copy[k] = v
    return parentPath.length ? setIn(value, parentPath, copy) : copy
  }

  return value
}

/** A copy of the document with `item` appended to the array at `path`. */
export function insertIn(value, path, item) {
  const target = path.length ? getIn(value, path) : value
  if (!Array.isArray(target)) {
    throw new TypeError(`insertIn: ${pathKey(path)} is a ${classify(target)}, not an array`)
  }

  const copy = [...target, item]
  return path.length ? setIn(value, path, copy) : copy
}

/**
 * A copy of the document with one key of the object at `path` renamed, IN PLACE
 * in the key order.
 *
 * Rebuilding the object rather than `delete` + set, because `delete` + set moves
 * the key to the end: correcting a typo in the first field of a form sends that
 * field to the bottom of it, every time, and there is nothing the person can do
 * to put it back. Renaming onto a key that already exists is refused — it is a
 * silent overwrite of a value that is on screen.
 */
export function renameKey(value, path, from, to) {
  const target = path.length ? getIn(value, path) : value
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError(`renameKey: ${pathKey(path)} is a ${classify(target)}, not an object`)
  }
  if (!Object.prototype.hasOwnProperty.call(target, from)) return value
  if (from === to) return value
  if (Object.prototype.hasOwnProperty.call(target, to)) {
    throw new Error(`renameKey: '${to}' already exists here — renaming onto it would discard its value`)
  }

  const copy = {}
  for (const [k, v] of Object.entries(target)) copy[k === from ? to : k] = v

  return path.length ? setIn(value, path, copy) : copy
}

// ── The tree, flattened ───────────────────────────────────────────────────────

/**
 * The document as a flat list of visible rows.
 *
 * A renderer walks this once with a single loop instead of recursing, which is
 * what makes every row individually keyable and the expand state a set the view
 * owns rather than a flag written onto the data. The depth is on the row, so
 * indentation is a style and not a nesting of elements.
 *
 * Only OPEN containers contribute their children, so the cost of a huge
 * document is the cost of what is on screen.
 *
 * A cycle is not a JSON document, but a value handed to a viewer is not
 * necessarily a parsed one — so an object already on the current branch is
 * emitted as a leaf marked `circular` rather than recursed into, because the
 * alternative is a viewer that hangs the tab.
 *
 * @param {*} value
 * @param {{expanded?: Set<string>}} [opts]  `expanded` holds pathKey()s. There is
 *   deliberately no depth option here — see `expandToDepth`.
 * @returns {Array<{key: string, path: Array, name: string|number|null, value: *,
 *                  kind: string, depth: number, open: boolean, container: boolean,
 *                  circular: boolean, size: number|null}>}
 */
export function treeRows(value, { expanded = new Set() } = {}) {
  const rows = []

  const walk = (node, path, level, name, seen) => {
    const kind      = classify(node)
    const container = isContainer(node)
    const key       = pathKey(path)
    const circular  = container && seen.has(node)
    // The set is the ONLY answer to whether a row is open. A depth option
    // beside it would be a second one, and the two disagree the moment somebody
    // closes an auto-opened row: a Set cannot hold *deliberately shut*, so the
    // row would spring back open on the next render. `expandToDepth` seeds the
    // set instead, once.
    const open = container && !circular && expanded.has(key)

    rows.push({
      key,
      path,
      name,
      value: node,
      kind,
      depth: level,
      open,
      container,
      circular,
      size: container ? (Array.isArray(node) ? node.length : Object.keys(node).length) : null,
    })

    if (!open) return

    const nextSeen = new Set(seen).add(node)
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...path, i], level + 1, i, nextSeen))
    } else {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k], level + 1, k, nextSeen)
    }
  }

  // The root is not a row — it has no name and nothing to put in a key column.
  // Its children are the top level, which is what `depth: 1` means.
  const root = value
  if (isContainer(root)) {
    const seen = new Set([root])
    if (Array.isArray(root)) {
      root.forEach((item, i) => walk(item, [i], 0, i, seen))
    } else {
      for (const [k, v] of Object.entries(root)) walk(v, [k], 0, k, seen)
    }
  } else {
    rows.push({
      key: pathKey([]), path: [], name: null, value: root, kind: classify(root),
      depth: 0, open: false, container: false, circular: false, size: null,
    })
  }

  return rows
}

/**
 * The set of paths a fresh view should have open.
 *
 * Separate from `treeRows` because opening is a decision made ONCE, when a
 * document arrives, and every toggle after it belongs to the person looking at
 * it. Folding the depth into the walk instead would make a container the person
 * closed spring back open on the next render.
 */
export function expandToDepth(value, depth = 1) {
  const open = new Set()
  if (depth <= 0) return open

  // `level` is the ROW depth of the node — the same number `treeRows` puts on
  // its rows — and the root is -1 because it is not a row. Counting from the
  // root instead makes `depth: 1` mean *nothing is open*, which is what the
  // caller would spell `depth: 0`.
  const walk = (node, path, level, seen) => {
    if (!isContainer(node) || seen.has(node)) return
    if (level >= 0) {
      if (level >= depth) return
      open.add(pathKey(path))
    }

    const nextSeen = new Set(seen).add(node)
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...path, i], level + 1, nextSeen))
    } else {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k], level + 1, nextSeen)
    }
  }

  walk(value, [], -1, new Set())
  return open
}

/*
 * ─── comparing two documents ──────────────────────────────────────────
 */

/**
 * Deep equality, for JSON values only.
 *
 * Not a general one: there is no Map, no Set, no cycle guard and no NaN case,
 * because a JSON document holds none of them. A general implementation here
 * would be a second answer to a question this kit already scopes.
 */
export function sameValue(a, b) {
  if (a === b) return true

  const ka = classify(a)
  if (ka !== classify(b)) return false

  if (ka === 'date') return a.getTime() === b.getTime()

  if (ka === 'array') {
    if (a.length !== b.length) return false
    return a.every((item, i) => sameValue(item, b[i]))
  }

  if (ka === 'object') {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every(k =>
      Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]))
  }

  return false
}

/**
 * before, after → one walkable document plus what happened at each path.
 *
 * The merged document is the point. A removed key exists in neither `after`
 * nor any tree built from it, so a viewer handed only the new document can
 * show every change except the ones that took something away — which is the
 * half people are looking for. `merged` carries a removed entry at its OLD
 * value, marked, so one walk renders all three states.
 *
 * Returns:
 *   merged    the union document, in `before`'s key order with new keys after
 *   status    pathKey → 'added' | 'removed' | 'changed'   (unchanged: absent)
 *   previous  pathKey → the value that was there, for 'removed' and 'changed'
 *   open      pathKeys of every container on the route to a difference, so a
 *             change three levels down is not folded away behind a summary
 *   count     { added, removed, changed } — LEAF level. A container is marked
 *             'changed' in `status` so a collapsed branch can say something
 *             moved, but it does not add to the count: it is a rollup of the
 *             rows under it, and counting both reports one edit twice.
 *
 * **Arrays are compared BY POSITION.** Removing the first of three items
 * therefore reads as two changes and one removal rather than one removal. That
 * is a true statement about the document and not the most useful one; the
 * alternative is a longest-common-subsequence pass, which is a different
 * feature with its own decisions (what makes two objects "the same item"?) and
 * is deliberately not guessed at here.
 *
 * A path whose two sides are containers of DIFFERENT kinds — an object where
 * an array was — is one `changed` and is not recursed into: nothing below it
 * corresponds, so every descendant would be reported twice over.
 */
export function diffDocs(before, after) {
  const status   = {}
  const previous = {}
  const open     = new Set()
  const count    = { added: 0, removed: 0, changed: 0 }

  const mark = (path, kind, prev) => {
    status[pathKey(path)] = kind
    if (kind !== 'added') previous[pathKey(path)] = prev
    count[kind]++
    // Every ANCESTOR row, not the path itself: opening a row shows its
    // children, so the row that changed does not need to be open — the ones
    // above it do. The root is not a row and is skipped.
    for (let i = 1; i < path.length; i++) open.add(pathKey(path.slice(0, i)))
  }

  const walk = (b, a, path) => {
    const kb = classify(b)
    const ka = classify(a)

    const bothObjects = kb === 'object' && ka === 'object'
    const bothArrays  = kb === 'array'  && ka === 'array'

    if (!bothObjects && !bothArrays) {
      if (!sameValue(b, a)) mark(path, 'changed', b)
      return a
    }

    let touched = false
    const merged = bothArrays ? [] : {}

    if (bothArrays) {
      const len = Math.max(b.length, a.length)
      for (let i = 0; i < len; i++) {
        const inB = i < b.length
        const inA = i < a.length
        if (!inB)      { mark([...path, i], 'added');      merged[i] = a[i]; touched = true }
        else if (!inA) { mark([...path, i], 'removed', b[i]); merged[i] = b[i]; touched = true }
        else {
          const before = count.added + count.removed + count.changed
          merged[i] = walk(b[i], a[i], [...path, i])
          if (count.added + count.removed + count.changed !== before) touched = true
        }
      }
    } else {
      for (const key of mergeKeys([b, a])) {
        const inB = Object.prototype.hasOwnProperty.call(b, key)
        const inA = Object.prototype.hasOwnProperty.call(a, key)
        if (!inB)      { mark([...path, key], 'added');         merged[key] = a[key]; touched = true }
        else if (!inA) { mark([...path, key], 'removed', b[key]); merged[key] = b[key]; touched = true }
        else {
          const before = count.added + count.removed + count.changed
          merged[key] = walk(b[key], a[key], [...path, key])
          if (count.added + count.removed + count.changed !== before) touched = true
        }
      }
    }

    // A container is 'changed' when something under it is. It is marked AFTER
    // its children so a collapsed branch still says that something moved,
    // which is the only thing a summary row can honestly report.
    if (touched && path.length) {
      status[pathKey(path)] = 'changed'
      previous[pathKey(path)] = b
      for (let i = 1; i < path.length; i++) open.add(pathKey(path.slice(0, i)))
    }

    return merged
  }

  const merged = walk(before, after, [])
  return { merged, status, previous, open: [...open], count }
}

/**
 * A value → the same value as another KIND.
 *
 * The deliberate counterpart to `coerceLike`, and the two are not in tension:
 * an ordinary edit hands back text from a text box, so the type it replaces has
 * to survive or every edit degrades one step until a boolean is the string
 * "false", which is truthy. Changing the type is a different act and says so.
 *
 * Lossless wherever a natural mapping exists, and it exists more often than it
 * looks: an object becomes an array of its values, an array becomes an object
 * keyed by index, and a STRING that parses as the kind being asked for becomes
 * the parsed value rather than an empty one — pasting a JSON object into a text
 * field and then saying *object* does what it looks like it should.
 *
 * Where no mapping exists the value is dropped: a string asked to become an
 * object has nothing to carry over, and inventing a key to put it under would
 * be worse than losing it. That is a decision the caller made on purpose, and
 * in `@frontierjs/ui`'s editor it is one press of undo away.
 */
export function convertTo(value, kind) {
  const from = classify(value)
  if (from === kind) return value

  const parsed = typeof value === 'string' ? tryParse(value) : { ok: false }

  switch (kind) {
    case 'null':
      return null

    case 'string':
      if (value === null || value === undefined) return ''
      return isContainer(value) ? JSON.stringify(value) : String(value)

    case 'number': {
      if (typeof value === 'boolean') return value ? 1 : 0
      const n = Number(typeof value === 'string' ? value.trim() : value)
      return Number.isFinite(n) ? n : 0
    }

    case 'boolean':
      // Not raw truthiness: the strings a person types to mean *no* are the
      // ones a JSON document holds, and `'false'` is truthy in JavaScript.
      if (typeof value === 'string') return !(value.trim() === '' || value.trim() === 'false' || value.trim() === '0')
      if (typeof value === 'number')  return value !== 0
      if (isContainer(value))         return (Array.isArray(value) ? value.length : Object.keys(value).length) > 0
      return Boolean(value)

    case 'object':
      if (parsed.ok && classify(parsed.value) === 'object') return parsed.value
      // Index keys, which is the only mapping an array HAS — and it round-trips
      // back through `convertTo(x, 'array')`.
      if (Array.isArray(value)) return Object.fromEntries(value.map((v, i) => [String(i), v]))
      return {}

    case 'array':
      if (parsed.ok && Array.isArray(parsed.value)) return parsed.value
      if (classify(value) === 'object') return Object.values(value)
      if (value === null || value === undefined) return []
      return [value]

    default:
      return value
  }
}

/** The kinds `convertTo` accepts — the six a JSON document can hold. */
export const JSON_KINDS = ['string', 'number', 'boolean', 'null', 'object', 'array']

/*
 * ─── finding something in a document ──────────────────────────────────
 */

/**
 * text + a term → the runs it splits into, each marked hit or not.
 *
 * Every run rather than the first: a key and a value can both hold the term
 * more than once, and a highlighter that marks one occurrence and not the next
 * is worse than none — it says *this is the one*, which is a claim it cannot
 * make. Case-insensitive, and the returned text is the ORIGINAL casing, so
 * marking a hit never rewrites what the document says.
 */
export function markRuns(text, term) {
  const source = String(text ?? '')
  const needle = String(term ?? '')
  if (!needle) return [{ i: 0, text: source, hit: false }]

  const hay = source.toLowerCase()
  const nee = needle.toLowerCase()
  const out = []
  let at = 0
  let i  = 0

  for (;;) {
    const found = hay.indexOf(nee, at)
    if (found === -1) break
    if (found > at) out.push({ i: i++, text: source.slice(at, found), hit: false })
    out.push({ i: i++, text: source.slice(found, found + nee.length), hit: true })
    at = found + nee.length
  }
  if (at < source.length) out.push({ i: i++, text: source.slice(at), hit: false })
  return out.length ? out : [{ i: 0, text: source, hit: false }]
}

/**
 * A document + a term → which rows to keep, which to open, and how many hit.
 *
 * The same shape as `diffDocs` on purpose: a caller filtering a tree and a
 * caller diffing one are answering the same question about the same walk —
 * *which of these rows matter, and what has to be open for them to be on
 * screen at all*.
 *
 *   keep   pathKeys of every row that survives the filter — a hit, an ancestor
 *          of a hit, or a descendant of a container whose NAME hit
 *   open   the ancestors, because `treeRows` only emits children of an OPEN
 *          container: a match four levels down is not a row until every
 *          container above it is open, so a filter that does not answer this
 *          finds everything and shows nothing
 *   count  rows that matched THEMSELVES, not the ancestors kept to reach them
 *
 * A container whose own key matches keeps its whole subtree, because *find me
 * `tags`* means the items as well as the word.
 *
 * Matching is case-insensitive, over the key and the value alike — a value as
 * the text a reader sees, so `null` is findable by the word and a number by its
 * digits.
 */
export function searchDoc(value, term) {
  const needle = String(term ?? '').trim().toLowerCase()
  if (!needle) return { keep: [], open: [], count: 0, active: false }

  const keep  = new Set()
  const open  = new Set()
  let   count = 0

  const has = (text) => String(text).toLowerCase().includes(needle)

  /** What a reader would see for this value, which is what they search by. */
  const asText = (v) => {
    if (v === null || v === undefined) return 'null'
    if (typeof v === 'string') return v
    if (v instanceof Date) return v.toJSON()
    return JSON.stringify(v)
  }

  const walk = (v, path, name, under) => {
    const container = isContainer(v)
    const selfHit   = (name !== null && has(name)) || (!container && has(asText(v)))
    if (selfHit) count++

    let any = selfHit
    if (container) {
      const entries = Array.isArray(v)
        ? v.map((child, i) => [i, child])
        : Object.entries(v)
      for (const [k, child] of entries) {
        if (walk(child, [...path, k], String(k), under || selfHit)) any = true
      }
    }

    if ((any || under) && path.length) {
      keep.add(pathKey(path))
      for (let i = 1; i < path.length; i++) {
        keep.add(pathKey(path.slice(0, i)))
        open.add(pathKey(path.slice(0, i)))
      }
    }
    return any
  }

  walk(value, [], null, false)
  return { keep: [...keep], open: [...open], count, active: true }
}

/*
 * ─── naming a place in a document ─────────────────────────────────────
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * A path → the JavaScript that reaches it. `['a','b',0]` → `a.b[0]`.
 *
 * What a person pastes into code, which is the commoner half of *where is
 * this?* A key that is not a valid identifier is bracketed and quoted, so a
 * document with a key like `content-type` or `0` produces something that
 * actually runs rather than something that looks right.
 */
export function accessorPath(path, root = '') {
  let out = String(root ?? '')
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`
    else if (IDENTIFIER.test(seg)) out += out ? `.${seg}` : seg
    else out += `[${JSON.stringify(seg)}]`
  }
  return out
}

/**
 * A path → its RFC 6901 JSON Pointer. `['a','b',0]` → `/a/b/0`.
 *
 * The standard spelling, and the one a JSON Schema validator uses to say which
 * member it refused — so a pointer copied out of a tree can be pasted straight
 * into a search of a validation report. `~` and `/` are escaped, which is the
 * whole reason the format needs a function rather than a join: a key
 * containing a slash is otherwise two segments.
 */
export function jsonPointer(path) {
  if (!path.length) return ''
  return path
    .map((seg) => String(seg).replaceAll('~', '~0').replaceAll('/', '~1'))
    .map((seg) => `/${seg}`)
    .join('')
}
