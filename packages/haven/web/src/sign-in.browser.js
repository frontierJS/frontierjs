// src/sign-in.browser.js — this browser signing in, the twin of `sign-in.js`.
// `#sign-in` resolves here under the `browser` condition.
//
// The same login as a terminal's (`FJS-D981`): an Ed25519 pair made by
// WebCrypto through toolbelt's `generateSigningKeys`, and `signRequest`'s
// key-pair form over `POST /haven/login`, which `api/src/login.ts` verifies the
// same way whoever sent it. The pair is kept in IndexedDB, so this browser
// profile is one member across reloads and restarts, the way `~/.fli/haven/
// key.json` is one machine. Cleared site data is a new key, and a new key is
// a new member: the old nick stays the old key's.
//
// A page load signs one fresh login and every room it walks into reuses it;
// a door is a navigation, and signing again per door would mint a session per
// step through it.
import { generateSigningKeys, signRequest } from '@frontierjs/toolbelt/signature'

import config from '../config/sierra.config.js'
import { LOGIN_PATH } from '../../api/src/login.ts'

const DB    = 'haven'
const STORE = 'keys'
const KEY   = 'machine'

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

/** This browser's key pair, made and kept on the first visit. */
export async function machineKeys() {
  const kept = await request((await store('readonly')).get(KEY))
  if (kept?.publicKey && kept?.privateKey) return { keys: kept, made: false }
  const keys = await generateSigningKeys()
  await request((await store('readwrite')).put(keys, KEY))
  return { keys, made: true }
}

/**
 * A browser has no user name to default a nick to, so a first login takes
 * `?nick=` from the address, else one made from the key. The schema allows
 * lower-case letters, digits, `-` and `_`, which a base64url key lowered is.
 */
function defaultNick(keys) {
  const asked = new URLSearchParams(location.search).get('nick')
  return asked || `guest-${keys.publicKey.slice(0, 6).toLowerCase()}`
}

/** A signed POST /haven/login, answered `{ token, member }`. */
export async function signIn(api, { keys, nick = defaultNick(keys) }) {
  const body = JSON.stringify({ publicKey: keys.publicKey, nick })
  const headers = await signRequest({
    privateKey: keys.privateKey, method: 'POST', path: LOGIN_PATH, body,
    timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
  })
  let res
  try {
    res = await fetch(new URL(LOGIN_PATH, api), { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } })
  } catch (e) {
    throw new Error(`No haven answers at ${api} (${e.message})`)
  }
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.message ?? `${api} answered the login ${res.status}.`)
  return { token: json.token, member: json.member }
}

let signedIn = null

/** The session this page walks in with: signed once per page load. */
export function sessionToken() {
  signedIn ??= machineKeys()
    .then(({ keys }) => signIn(config.junction.url, { keys }))
    .then((r) => r.token)
  // A failed login is not kept, so the next room asked for tries again.
  signedIn.catch(() => { signedIn = null })
  return signedIn
}
