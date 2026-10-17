// src/seen.browser.js — `#seen` in a browser, the twin of `seen.js`: a scene
// is a record in IndexedDB, so this browser profile has one map the way
// `~/.fli/haven/seen/` is one machine's (`FJS-D991`). Cleared site data is a
// map nobody has walked.
//
// Its own database rather than a store in `sign-in.browser.js`'s `haven`: a
// new store there needs a version bump, and a profile holding the old version
// is the member's key.
const DB    = 'haven-seen'
const STORE = 'scenes'

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror   = () => reject(req.error)
})

async function store(mode) {
  const open = indexedDB.open(DB, 1)
  open.onupgradeneeded = () => open.result.createObjectStore(STORE)
  const db = await request(open)
  return db.transaction(STORE, mode).objectStore(STORE)
}

/** Keep `snap` as its scene's record, replacing the last. */
export async function write(snap) {
  const slug = String(snap?.slug ?? '')
  if (!slug) return
  await request((await store('readwrite')).put(snap, slug))
}

/** Every scene record; a browser that refuses IndexedDB has seen nothing. */
export async function read() {
  try { return await request((await store('readonly')).getAll()) } catch { return [] }
}
