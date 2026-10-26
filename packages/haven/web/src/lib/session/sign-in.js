// src/sign-in.js — this machine signing in, before a route mounts.
//
// A member is their Frontier chain (`IDEAS/frontier-network.md` 3.1): `fli
// haven` hands this machine's key, its links and the post's row here, and a
// key in no chain is refused (3.2). Each run signs a fresh login rather than
// keeping the session it was answered: the key mints the next one, so no
// bearer sits on disk beside it. `fli haven` runs this and hands the token to
// the shell as HAVEN_TOKEN, which `sessionToken()` reads for `walk-in.js`. A browser resolves `#sign-in`
// to `sign-in.browser.js` instead, which is handed a session and holds no key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { generateSigningKeys, signRequest } from '@frontierjs/toolbelt/signature'

import { LOGIN_PATH } from '../../../../api/src/login.ts'

/** The key pair at `file`, made and written 0600 on the first run. */
export async function machineKeys(file) {
  if (existsSync(file)) {
    const keys = JSON.parse(readFileSync(file, 'utf8'))
    if (keys?.publicKey && keys?.privateKey) return { keys, made: false }
    throw new Error(`${file} holds no key pair. Move it aside and a new one is made, which walks in as a new member.`)
  }
  const keys = await generateSigningKeys()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
  return { keys, made: true }
}

/** A signed POST /haven/login with the member's chain `links` and the post's `row`, answered `{ token, member }`; the row is the nick. */
export async function signIn(api, { keys, links, row }) {
  const body = JSON.stringify({ publicKey: keys.publicKey, links, row })
  const headers = await signRequest({
    privateKey: keys.privateKey, method: 'POST', path: LOGIN_PATH, body,
    timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
  })
  let res
  try {
    res = await fetch(new URL(LOGIN_PATH, api), { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } })
  } catch (e) {
    throw new Error(`No haven answers at ${api} (${e.code ?? e.cause?.code ?? e.message})`)
  }
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.message ?? `${api} answered the login ${res.status}.`)
  return { token: json.token, member: json.member }
}

/**
 * The session this terminal walks in with. The shell signs nothing itself:
 * `fli haven` signed this machine in before starting it and handed the token
 * over as HAVEN_TOKEN, since a terminal has no storage a client could restore
 * one from. `sign-in.browser.js` answers the same question by signing in.
 */
export async function sessionToken() {
  const token = globalThis.process?.env?.HAVEN_TOKEN
  if (!token) throw new Error('Nobody walked in: this terminal was handed no HAVEN_TOKEN.')
  return token
}
