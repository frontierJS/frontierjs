// api/test/sign-in.ts
// A test's machine walking in: a key pair, a signed POST /haven/login, the
// member and the token it answers. `web/src/sign-in.js` is the real machine's;
// this one keeps the request's parts, for a test that tampers with them.

import { generateSigningKeys, signRequest } from '@frontierjs/toolbelt/signature'

import { LOGIN_PATH } from '../src/login.ts'

export interface Walker { id: number, nick: string, token: string, keys: { publicKey: string, privateKey: string } }

let nonces = 0

/** The signed request, unsent — a test that tampers with it needs the parts. */
export async function signedLogin (keys: { publicKey: string, privateKey: string }, body: Record<string, unknown>, at = Math.floor(Date.now() / 1000)) {
  const text = JSON.stringify({ publicKey: keys.publicKey, ...body })
  const headers = await signRequest({
    privateKey: keys.privateKey, method: 'POST', path: LOGIN_PATH, body: text,
    timestamp: at, nonce: `n-${++nonces}-${Math.random()}`,
  })
  return { body: text, headers: { 'content-type': 'application/json', ...headers } }
}

export async function postLogin (port: number, req: { body: string, headers: Record<string, string> }): Promise<{ status: number, json: any }> {
  const res = await fetch(`http://localhost:${port}${LOGIN_PATH}`, { method: 'POST', ...req })
  return { status: res.status, json: await res.json().catch(() => null) }
}

export async function signIn (port: number, nick: string, keys?: Walker['keys']): Promise<Walker> {
  const k = keys ?? await generateSigningKeys()
  const { status, json } = await postLogin(port, await signedLogin(k, { nick }))
  if (status !== 200) throw new Error(`login as ${nick}: ${status} ${JSON.stringify(json)}`)
  return { id: json.member.id, nick: json.member.nick, token: json.token, keys: k }
}
