/**
 * The hydration marker protocol — the one owner of its spelling (`FJS-D2286`,
 * `IDEAS/hydration.md` Phases 1–2, Invariant 4). `runtime-server.js` writes
 * through these and `runtime.js` reads through `parseMarker`, so a marker the
 * server writes is a marker the client finds: a second spelling is a lookup
 * that misses and a block re-rendered (`FJS-D2260`).
 *
 *   <!--i ID SCOPE-->        an instance starts: its structural id and scope id
 *   <!--m ID KEY-->          after a live node; `empty` follows KEY when a text
 *                            binding rendered nothing and so left no Text node
 *   <!--[ ID KEY STATE-->    a block opens: an `{#if}` branch index (-1 for none),
 *                            `then` or `catch` for an `{#await}`, nothing for `{#each}`
 *   <!--r ID-->              an `{#each}` row starts; ID is the row's own id
 *   <!--] ID KEY-->          the block closes
 */

export const INSTANCE = 'i'
export const MARK = 'm'
export const OPEN = '['
export const ROW = 'r'
export const CLOSE = ']'
export const EMPTY = 'empty'

// A row key is data inside a comment, where `-->` ends it and a space would
// split the fields.
const commentSafe = (s) => encodeURIComponent(String(s)).replace(/-/g, '%2D')

/** An `{#each}` row's id: its block owner's id and its key. */
export const rowId = (parent, key) => parent + '[' + commentSafe(key) + ']'

const KINDS = new Set([INSTANCE, MARK, OPEN, ROW, CLOSE])

/**
 * A comment's data as a marker, or null for any other comment. Fields are
 * space-separated and none carries a space: a row key is percent-encoded.
 * @param {string} data
 * @returns {{ kind: string, id: string, key?: string, state?: string } | null}
 */
export function parseMarker(data) {
  if (data.length < 3 || data[1] !== ' ' || !KINDS.has(data[0])) return null
  const [kind, id, key, state] = data.split(' ')
  return { kind, id, key, state }
}
