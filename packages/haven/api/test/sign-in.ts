// api/test/sign-in.ts
// A test's member walking in: a Frontier member of one machine, staked at a
// post every test haven pins (`postKey: POST_KEY`), a signed POST
// /haven/login, the member and the token it answers.
// `web/src/lib/session/sign-in.js` is the real machine's; this one keeps the
// request's parts, for a test that tampers with them, and stakes a HOME for a
// drive whose `fli haven` must walk in as somebody.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateSigningKeys, signRequest } from '@frontierjs/toolbelt/signature'
import { generateSealingKeys } from '@frontierjs/toolbelt/seal'
import { linkHash, rootLink, signRow } from '@frontierjs/toolbelt/frontier'

import { LOGIN_PATH } from '../src/login.ts'

type Keys = { publicKey: string, privateKey: string }

/** The post's key pair: its public half is the haven's `postKey`, its private half signs every row here. */
export const POST = await generateSigningKeys()
export const POST_KEY = POST.publicKey

/** One machine's member: its signing key, its chain, and the post's row naming it. */
export interface Member { keys: Keys, links: any[], row: Record<string, unknown> }

export interface Walker { id: number, nick: string, role: string | null, token: string, member: Member }

const now = () => Math.floor(Date.now() / 1000)
let numbers = 0
let nonces = 0

/** A member staked as `nick`, the row signed at `signed` (seconds) — older than a day and the haven refuses it. */
export async function member (nick: string, signed = now()): Promise<Member> {
  const keys = { ...await generateSigningKeys(), sealing: await generateSealingKeys() }
  const link = await rootLink(keys)
  const hash = await linkHash(link)
  const row = await signRow(POST.privateKey, { number: ++numbers, nick, root: hash, head: hash, joined: signed, invitedBy: null, fliVersion: null, signed })
  return { keys: { publicKey: keys.publicKey, privateKey: keys.privateKey }, links: [link], row }
}

/**
 * A new HOME whose fli is the member `nick`, as `fli frontier:stake` leaves
 * one: its row is fresh, so a walk never asks the post for another.
 */
export async function stakedHome (prefix: string, nick: string): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), prefix))
  const m = await member(nick)
  const dir = join(home, '.fli/frontier')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'key.json'), JSON.stringify(m.keys))
  writeFileSync(join(dir, 'chain.json'), JSON.stringify(m.links))
  writeFileSync(join(dir, 'member.json'), JSON.stringify(m.row))
  writeFileSync(join(home, '.fli/config.json'), JSON.stringify({ frontier: { nick, postKey: POST_KEY } }))
  return home
}

/** The login body `m` sends, signed with its own machine key. */
export const chainOf = (m: Member) => ({ links: m.links, row: m.row })

/** The signed request, unsent — a test that tampers with it needs the parts. */
export async function signedLogin (keys: Keys, body: Record<string, unknown>, at = now()) {
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

/** `nick` walking in: a new member, unless `m` is one already made. */
export async function signIn (port: number, nick: string, m?: Member): Promise<Walker> {
  const mem = m ?? await member(nick)
  const { status, json } = await postLogin(port, await signedLogin(mem.keys, chainOf(mem)))
  if (status !== 200) throw new Error(`login as ${nick}: ${status} ${JSON.stringify(json)}`)
  return { id: json.member.id, nick: json.member.nick, role: json.member.role, token: json.token, member: mem }
}
