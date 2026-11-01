// The rows one resource has READ: the baseline `save()` diffs a patch against,
// the `@version` that patch hands back, and — on a model whose key the caller
// types — which ids exist. createResource builds one per resource; the identity
// epoch clears it with the rest of what a resource holds.
//
// One entry per row read: the revision, and the row AS READ, which is the one
// fact that makes *a patch of what changed* derivable rather than something a
// caller has to declare.
//
// A `find()` stamps every row of every page, so this is capped: a list screen
// paging a large table would otherwise accumulate one entry per row seen, for
// the life of the tab (`FJS-823`). **A row a view still holds is never
// evicted** (`FJS-D468`): a board of 300 rows forgot its first 100 under a
// plain insertion-ordered cap, and on a `@version` model a miss is a patch
// the server refuses, not a patch that merely carries the whole record
// (`FJS-1309`). So the cap bounds what no screen shows — a `find()` into a
// plain array — and what is on screen costs one entry per row on screen.

// How many read rows no view holds one resource keeps.
export const READ_CACHE_MAX = 200

/**
 * @param {object} o
 * @param {object} o.client            the junction client; its `entries` say which rows a view holds
 * @param {string} o.entryKey          the model, else the service: the key `entries` files rows under
 * @param {string|null} o.idField
 * @param {string|null} o.versionOf    the `@version` column, or null
 * @param {Set<string>} o.m2mKeys      the m2m fields a form draws, kept across a write's answer
 * @param {boolean} o.callerSuppliedId whether the caller types the key, so `seen` is worth keeping
 */
export function readBaseline({ client, entryKey, idField, versionOf, m2mKeys, callerSuppliedId }) {
  const rows = new Map()

  // The ids read, on a model whose key the caller types. Only then: a
  // server-assigned key answers *does this row exist* by being present at all,
  // and this set would grow one entry per row of every page for nothing. A row
  // the DEVICE answered counts: it was the server's once, and missing it sent a
  // save of a row opened offline as a create, refused at replay by a service
  // with no `create` and a duplicate on one with it (`FJS-2254`).
  const seen = new Set()

  function held(id) {
    return !!client?.entries?.peek(entryKey, id)?.held
  }

  function remember(id, row) {
    // A write answers the row without its members. Losing them from the
    // baseline would turn the next save's `set` into a `connect` that cannot
    // remove one.
    const prev = rows.get(id)
    for (const k of m2mKeys) if (prev && k in prev && !(k in row)) row = { ...row, [k]: prev[k] }
    if (rows.has(id)) rows.delete(id)
    rows.set(id, row)
    if (rows.size <= READ_CACHE_MAX) return
    for (const key of rows.keys()) {
      if (rows.size <= READ_CACHE_MAX) break
      if (!held(key)) rows.delete(key)
    }
  }

  // The first sight of a row in a held view IS its read, and never replaces
  // one (`FJS-D468`). A row that reached the screen by push was read by
  // nobody, yet it is exactly what the person saw and edited; without this its
  // patch went up with no version. The committed value, not the view's: an
  // optimistic overlay is this screen's intent, and taking it as the baseline
  // would drop it from the patch's diff and the merge's `base`.
  function sighted(id, row) {
    if (!versionOf || id == null || rows.has(id)) return
    const committed = client?.entries?.peek(entryKey, id)?.committed?.() ?? row
    if (committed && Number.isInteger(committed[versionOf])) remember(id, committed)
  }

  // The revision last READ for a row, or null.
  function version(id) {
    if (!versionOf) return null
    const v = rows.get(id)?.[versionOf]
    return Number.isInteger(v) ? v : null
  }

  function sawRows(list) {
    if (!callerSuppliedId) return
    for (const row of list) if (row?.[idField] != null) seen.add(row[idField])
  }

  function rememberRows(result) {
    if (!result) return
    const list = Array.isArray(result) ? result
      : Array.isArray(result?.data) ? result.data
      : [result]
    for (const row of list) {
      if (!row || typeof row !== 'object') continue
      const id = row[idField]
      if (id == null) continue
      if (callerSuppliedId) seen.add(id)
      remember(id, row)
    }
  }

  return { rows, seen, remember, sighted, version, sawRows, rememberRows }
}
