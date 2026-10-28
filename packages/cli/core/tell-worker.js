// core/tell-worker.js — the server `fli tell` speaks to: one Cloudflare Worker
// and one Durable Object holding every member, invite and letter
// (FJS-D1392).
//
// Never imported by the cli. `fli ws:post` points a wrangler config at this
// file and wrangler bundles it, so it runs in workerd and may use nothing a
// Worker lacks. It ships because `core/` is in the package's `files`.
//
// A member is a chain of machines (@frontierjs/toolbelt/frontier,
// FJS-D1416): every route but `join` is signed by one of them (toolbelt's
// `signRequest`), named in `x-tell-key`; a key that is no member's machine is
// refused before the signature is looked at. `join` is signed by the machine
// its root names, as Haven's login is. The owner is member one, seeded from
// the OWNER_KEY and OWNER_NICK vars that `ws:post` writes, with no chain
// until its first verb publishes one — as is any member who joined before
// chains. A chain is stored only once every link verifies and it carries the
// stored one forward, so the post can neither write a link nor take one back.
//
// A member with a sealing key (FJS-D1400) is sent only sealed letters, and
// a plain one to them is refused here rather than trusted to the sender
// (FJS-D1402), so the post holds only ciphertext for them. The sealing key is
// the one the chain signed, and a member with no chain has none. A letter to
// a member with none is plaintext, as V1's were (FJS-D1393). Reading deletes
// either (FJS-D1395). A client verifies the chain and pins its root on first
// contact, and signs inside the seal (4.1), so a host serving another chain
// or writing a letter is caught there, not here.
//
// `GET /follow` is a WebSocket, signed like every other route at the upgrade.
// The object pushes the waiting letters on accept and each new one as `send`
// writes it, and deletes a letter only when the socket acks its id, so a
// client that dies before printing gets it again. Two followers of one member
// both print it; the first ack deletes it.
//
// `GET /waiting` counts a member's letters by sender and deletes nothing — the
// background check behind the notice line every `fli` command prints.
//
// Linking (4.5, FJS-D1418) is four routes over one `asks` row. A new machine
// asks (`POST /link/ask`, signed by itself, as a join is) and prints its ask
// code as eight words; a linked machine typed them reads the ask
// (`GET /link/ask?code=`) and offers a link it signed, with the member's
// sealing key sealed to the asker (`POST /link/offer`); the asker, asking
// again, is answered the offer and publishes the chain it countersigned
// (`POST /link/accept`). The post carries the pieces and can sign none.
//
// A revoke (4.6, FJS-D1419) reaches the post as a longer chain on
// `POST /chain`, with `rekeys`: the member's new sealing pair sealed to the
// box key of each machine left, which each fetches once (`GET /rekey`). The
// box keys are the machines' own signed claims (`POST /box`, `GET /boxes`);
// the post stores them and the revoking machine verifies them. A revoked
// machine is out of `machines` the moment the chain is stored, so it is
// refused on its next request, and its open socket is closed.
//
// A paper key (4.7, FJS-D1420) is one more machine in the chain, its link
// published on `POST /chain` with the sealing pair sealed to its box key in
// `rekeys`; typed on a new machine, it signs that machine's link the same way.
// The post holds its public keys and that sealed pair, nothing it can open.
//
// The member row (2.4) is the post's word on a member: number, nick, lineage
// and the chain's root and head, signed with a key the object made for itself
// and keeps in its own storage (FJS-D1467). It is signed when asked — at the
// join, and on `GET /row` — so it names the head the post holds then. A
// client pins the post's key on first sight.
//
// `GET /badge/<number>.svg` (2.7) is the one route nobody signs: a README
// embeds it, so its reader is a browser with no key. It answers what
// `GET /members` already tells any member, the number and nick (FJS-D1449),
// drawn beside the crest of the member's chain root (core/crest.js).
//
// A file (IDEAS/frontier-files.md) is an R2 object keyed by its id, and its
// size, expiry, downloads left and put-token hash are one `files` row here, so
// nothing about it is held twice (FJS-D1563, FJS-D1565). A member asks
// (`POST /file`, signed) and is answered an id and a put token; the bytes are
// ciphertext sealed on the sender's machine with the key in the link's
// fragment (FJS-D1564), so the post never holds the content or the name. The
// object's `fetch` reads every body as text, so the Worker streams the bytes
// itself and asks the object one step at a time on `/file/<id>/<step>`, a
// path the Worker never forwards. The alarm sweeps a row at its `sweepAt`:
// an ask never put, an expiry, or a last download whose stream never said it
// finished.

import { generateSigningKeys, verifyMessage, verifyRequest } from '@frontierjs/toolbelt/signature'
import { FILE_MAX, FLI_VERSION, NICK, askCode, extendsSeen, fileLimits, linkMessage, memberNumber, openFile, readChain, signRow, verifyBox } from '@frontierjs/toolbelt/frontier'
import { crestSvg } from './crest.js'

// ─── limits ────────────────────────────────────────────────────────────────

/** Seconds a signature stays fresh. A nonce is kept twice this (FJS-1833). */
const WINDOW       = 300
/** Haven's `messages.service.ts` number: five sends in ten seconds. */
const SEND_MAX     = 5
const SEND_SECONDS = 10
/** An invite is spent by its first join or expires in a day (FJS-D1394). */
const INVITE_SECONDS = 86400
/**
 * Joins a member may vouch for, live codes counted, so a low number means
 * somebody vouched for it and numbers cannot be farmed. The owner has none:
 * joining is by invite only (FJS-D1415), so the owner is the one open door.
 */
const INVITE_ALLOWANCE = 3
/**
 * Nicks a join is refused because they read as the post, the project or
 * everyone speaking (FJS-D1450). A nick is never renamed, so one staked here
 * stays staked. The owner is seeded from OWNER_NICK, never joins, and is not
 * checked against it.
 */
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'owner', 'operator',
  'mod', 'moderator', 'staff', 'team', 'official',
  'support', 'help', 'security', 'abuse', 'postmaster', 'hostmaster', 'webmaster', 'noreply', 'no-reply',
  'frontier', 'frontierjs', 'fjs', 'fli', 'post', 'network', 'haven', 'tell',
  'all', 'everyone', 'here', 'nobody', 'anonymous', 'null', 'undefined',
])
const BODY_MAX     = 4000
/** A sealed letter's length, opaque here: 4000 characters JSON-escaped, sealed, then base64url, with room. */
const SEALED_MAX   = 32768
/** `@frontierjs/toolbelt/seal`'s public key, 32 bytes of base64url. */
const SEAL_KEY     = /^[A-Za-z0-9_-]{43}$/
/** A chain as it travels, JSON: far past toolbelt/frontier's 256 links of three keys and a signature each. */
const CHAIN_MAX    = 131072
/** Machines a member's rekeys are sealed to, at most — a chain's own bound. */
const REKEYS_MAX   = 256
/** A link ask waits ten minutes for a linked machine to type its words. */
const ASK_SECONDS  = 600
/** Asks open at once: anyone may ask, so the table is bounded rather than the askers. */
const ASKS_MAX     = 64

const MiB = 1024 * 1024
/** Live bytes the post holds for everyone, asks counted: under R2's 10 GB free tier, so the bill cannot move (FJS-D1563). */
const FILE_BUDGET = 5 * 1024 * MiB
/** A link lasts a day unless asked otherwise, a week at most, and a minute at least. */
const FILE_SECONDS     = 86400
const FILE_SECONDS_MAX = 7 * 86400
const FILE_SECONDS_MIN = 60
const FILE_DOWNLOADS_MAX = 10
/** A member's allowance; the owner has none (FJS-D1565). Ten full files, so the tenth is not refused by its envelope. */
const FILES_A_DAY = 10
const FILES_HELD  = 10 * FILE_MAX
/** An ask not put by then is swept, so a member cannot hold the budget with asks. */
const PUT_SECONDS = 600
/** The sweep after a last download whose stream never said it finished — long enough for 24 MiB on a slow line. */
const DRAIN_SECONDS = 600
/** 16 random bytes of base64url: the link is the capability, so an id is never guessed. */
const FILE_ID = '[A-Za-z0-9_-]{22}'
const FILE_STEP = new RegExp(`^/file/(${FILE_ID})(?:/(put|held|take|drained|peek))?$`)
const FILE_TOKEN = 'x-file-token'

const KEY_HEADER = 'x-tell-key'

/** A number, a row key and never a pattern; nine digits is past any network this post holds. */
const BADGE = /^\/badge\/(\d{1,9})\.svg$/
/** A badge cannot change: a number is never reused, a nick never renamed, a root never replaced. A day bounds a crest redrawn by a newer crest.js. */
const BADGE_CACHE = 'public, max-age=86400'

const LETTER = 'id, fromNick AS "from", body, sealed, created'

/** One letter as a client reads it, from `/inbox` and down a `/follow` socket alike — `text` or `sealed`, never both. */
const letterOut = ({ id, from, body, sealed, created }) =>
  sealed ? { id, from, sealed: body, created } : { id, from, text: body, created }

const now = () => Math.floor(Date.now() / 1000)
const answer = (body, status = 200) => Response.json(body, { status })
const refuse = (status, message) => answer({ message }, status)

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const randomCode = n => base64url(crypto.getRandomValues(new Uint8Array(n)))
const inviteCode = () => randomCode(16)
const sha256 = async text => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))

// ─── the object ────────────────────────────────────────────────────────────

// A plain class, not `DurableObject` from `cloudflare:workers`: that import
// does not resolve outside workerd, and nothing here needs RPC.
export class TellPost {
  constructor(state, env) {
    this.state = state
    this.env   = env
    this.sql   = state.storage.sql
    // In memory, so an evicted object forgets it: the worst case is one
    // sender getting a fresh five.
    this.sent  = new Map()
    // Answered by the runtime without waking the object, so an idle follower
    // keeps its socket at no cost.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS members (nick TEXT PRIMARY KEY, publicKey TEXT NOT NULL UNIQUE, sealKey TEXT, joined INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, byNick TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS letters (id INTEGER PRIMARY KEY, fromNick TEXT NOT NULL, toNick TEXT NOT NULL, body TEXT NOT NULL, sealed INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS letters_to ON letters (toNick, id);
      CREATE TABLE IF NOT EXISTS nonces (id TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS links (nick TEXT NOT NULL, seq INTEGER NOT NULL, link TEXT NOT NULL, PRIMARY KEY (nick, seq));
      CREATE TABLE IF NOT EXISTS machines (publicKey TEXT PRIMARY KEY, nick TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asks (code TEXT PRIMARY KEY, machine TEXT NOT NULL UNIQUE, sealKey TEXT NOT NULL, expires INTEGER NOT NULL, nick TEXT, link TEXT, sealed TEXT);
      CREATE TABLE IF NOT EXISTS boxes (machine TEXT PRIMARY KEY, box TEXT NOT NULL, sig TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rekeys (machine TEXT PRIMARY KEY, sealKey TEXT NOT NULL, sealed TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS post (id INTEGER PRIMARY KEY CHECK (id = 1), publicKey TEXT NOT NULL, privateKey TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, nick TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, downloadsLeft INTEGER NOT NULL, tokenHash TEXT NOT NULL, state TEXT NOT NULL, sweepAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS files_sweep ON files (sweepAt);
      CREATE TABLE IF NOT EXISTS uploads (nick TEXT NOT NULL, at INTEGER NOT NULL);
    `)
    // A post deployed before the seal or the chain keeps its members, so its
    // tables gain the columns; a column already there throws and is left.
    // `publicKey` stays the machine a member came in with, which a chain's
    // root must name.
    for (const [table, column] of [
      ['members', 'sealKey TEXT'], ['letters', 'sealed INTEGER NOT NULL DEFAULT 0'],
      ['members', 'root TEXT'], ['members', 'seq INTEGER'], ['members', 'head TEXT'],
      ['members', 'number INTEGER'], ['members', 'invitedBy TEXT'], ['members', 'fliVersion TEXT'],
    ]) {
      try { this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`) } catch {}
    }
    // SQLite's ALTER cannot add a UNIQUE column, so the index is what stops
    // two members holding one number.
    this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS members_number ON members (number)')
    const owner = this.owner = String(env.OWNER_NICK ?? '').trim().toLowerCase()
    if (env.OWNER_KEY && NICK.test(owner)) {
      this.sql.exec('INSERT OR IGNORE INTO members (nick, publicKey, joined) VALUES (?, ?, ?)', owner, env.OWNER_KEY, now())
    }
    // A member who joined before numbers draws one now, the owner first and
    // then in the order they joined, so the owner of a post deployed before
    // numbers is still #1. A numbered row is never touched again.
    for (const { nick } of this.sql.exec('SELECT nick FROM members WHERE number IS NULL ORDER BY nick = ? DESC, joined, nick', owner).toArray()) {
      this.sql.exec('UPDATE members SET number = (SELECT COALESCE(MAX(number), 0) + 1 FROM members) WHERE nick = ?', nick)
    }
    // A member with no chain is a chain of one not yet published: its one
    // machine is the key it came in with, and a sealing key no chain signed
    // is none.
    this.sql.exec('INSERT OR IGNORE INTO machines (publicKey, nick) SELECT publicKey, nick FROM members WHERE root IS NULL')
    this.sql.exec('UPDATE members SET sealKey = NULL WHERE root IS NULL AND sealKey IS NOT NULL')
  }

  async fetch(req) {
    const url  = new URL(req.url)
    const body = await req.text()
    const route = `${req.method} ${url.pathname}`
    if (route === 'POST /join') return this.join(req, url, body)
    if (route === 'POST /link/ask') return this.ask(req, url, body)
    if (route === 'POST /link/accept') return this.accept(req, url, body)
    if (route === 'GET /follow') return this.follow(req, await this.member(req, url, body))
    const badge = req.method === 'GET' && url.pathname.match(BADGE)
    if (badge) return this.badge(Number(badge[1]))
    const file = url.pathname.match(FILE_STEP)
    if (file?.[2] && req.method === 'POST') return this.fileStep(file[2], file[1], body)
    if (file && !file[2] && req.method === 'DELETE') {
      const who = await this.member(req, url, body)
      return who.refused ? refuse(who.status, who.refused) : this.removeFile(who.nick, file[1])
    }

    const handler = {
      'POST /send':   this.send,
      'GET /inbox':   this.inbox,
      'GET /waiting': this.waiting,
      'POST /invite': this.invite,
      'GET /members': this.members,
      'GET /row':     this.row,
      'GET /chain':   this.chain,
      'POST /chain':  this.extendChain,
      'GET /link/ask':     this.readAsk,
      'POST /link/offer':  this.offer,
      'POST /box':    this.putBox,
      'GET /boxes':   this.boxes,
      'GET /rekey':   this.rekey,
      'POST /file':   this.askFile,
    }[route]
    if (!handler) return refuse(404, `No route ${route}.`)

    const who = await this.member(req, url, body)
    if (who.refused) return refuse(who.status, who.refused)
    return handler.call(this, who.nick, body, url, req.headers.get(KEY_HEADER))
  }

  /** `{ nick, machine }` for a signed request from a member's machine, else `{ status, refused }`. */
  async member(req, url, body) {
    const publicKey = req.headers.get(KEY_HEADER)
    if (!publicKey) return { status: 401, refused: `A request is signed and names its key in ${KEY_HEADER}.` }
    const member = this.sql.exec('SELECT nick FROM machines WHERE publicKey = ?', publicKey).toArray()[0]
    if (!member) return { status: 403, refused: 'That key is no member\'s machine here. `fli frontier:stake <nick> <code>` walks in with an invite.' }

    const verdict = await this.verify(req, url, body, publicKey)
    if (!verdict.ok) return { status: 401, refused: `The signature does not verify: ${verdict.reason}.` }
    return { nick: member.nick, machine: publicKey }
  }

  verify(req, url, body, publicKey) {
    return verifyRequest({
      publicKey, method: req.method, path: url.pathname, query: url.search, body,
      headers: req.headers, toleranceSeconds: WINDOW, now: now(), seenNonce: nonce => this.seen(publicKey, nonce),
    })
  }

  // In SQLite rather than memory: an idle object is evicted inside the window,
  // and a memory would forget every nonce with it.
  seen(publicKey, nonce) {
    const t = now()
    this.sql.exec('DELETE FROM nonces WHERE until <= ?', t)
    const kept = this.sql.exec('INSERT OR IGNORE INTO nonces (id, until) VALUES (?, ?) RETURNING id', `${publicKey}\n${nonce}`, t + 2 * WINDOW)
    return kept.toArray().length === 0
  }

  // ─── routes ──────────────────────────────────────────────────────────────

  send(from, body) {
    const { to, text, sealed } = parse(body)
    const toNick = typeof to === 'string' ? to.trim().toLowerCase() : ''
    const isSealed = typeof sealed === 'string'
    if (!toNick || (isSealed ? !sealed.startsWith('v1.') : typeof text !== 'string' || !text.trim())) return refuse(400, 'A letter is { to, text } or { to, sealed }.')
    const letter = isSealed ? sealed : text
    const max = isSealed ? SEALED_MAX : BODY_MAX
    if (letter.length > max) return refuse(413, `A letter is at most ${max} characters; this one is ${letter.length}.`)
    const recipient = this.sql.exec('SELECT sealKey FROM members WHERE nick = ?', toNick).toArray()[0]
    if (!recipient) return refuse(404, `No member is called '${toNick}'.`)
    if (recipient.sealKey && !isSealed) return refuse(409, `${toNick} has a sealing key, so a letter to them is sealed. A newer fli seals it.`)
    if (!recipient.sealKey && isSealed) return refuse(409, `${toNick} has no sealing key, so nothing sealed can reach them.`)

    const t = now()
    const recent = (this.sent.get(from) ?? []).filter(at => at > t - SEND_SECONDS)
    if (recent.length >= SEND_MAX) return refuse(429, `Slow down — ${SEND_MAX} letters in ${SEND_SECONDS} seconds.`)
    this.sent.set(from, [...recent, t])

    const { id } = this.sql.exec('INSERT INTO letters (fromNick, toNick, body, sealed, created) VALUES (?, ?, ?, ?, ?) RETURNING id', from, toNick, letter, isSealed ? 1 : 0, t).one()
    const frame = JSON.stringify(letterOut({ id, from, body: letter, sealed: isSealed, created: t }))
    for (const ws of this.state.getWebSockets(toNick)) {
      try { ws.send(frame) } catch {}
    }
    return answer({ id }, 201)
  }

  inbox(nick) {
    const letters = this.sql.exec(`DELETE FROM letters WHERE toNick = ? RETURNING ${LETTER}`, nick)
      .toArray().sort((a, b) => a.id - b.id)
    return answer({ letters: letters.map(({ id, ...row }) => letterOut(row)) })
  }

  // What the notice line names (FJS-D1398): who has letters
  // waiting and how many, each sender in the order its first letter came.
  waiting(nick) {
    const waiting = this.sql.exec('SELECT fromNick AS "from", COUNT(*) AS count FROM letters WHERE toNick = ? GROUP BY fromNick ORDER BY MIN(id)', nick).toArray()
    return answer({ waiting })
  }

  // A refusal is sent as the close of an accepted socket, code 4000 + the
  // status: a client sees no status on a failed upgrade, so a 403 there would
  // read as the network.
  follow(req, who) {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return refuse(426, 'GET /follow is a WebSocket upgrade.')
    const [client, server] = Object.values(new WebSocketPair())
    if (who.refused) {
      server.accept()
      server.close(4000 + who.status, who.refused.slice(0, 100))
    } else {
      this.state.acceptWebSocket(server, [who.nick, who.machine])
      for (const letter of this.sql.exec(`SELECT ${LETTER} FROM letters WHERE toNick = ? ORDER BY id`, who.nick).toArray()) {
        server.send(JSON.stringify(letterOut(letter)))
      }
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws, message) {
    const { ack } = parse(typeof message === 'string' ? message : '')
    if (!Number.isSafeInteger(ack)) return
    const [nick] = this.state.getTags(ws)
    this.sql.exec('DELETE FROM letters WHERE id = ? AND toNick = ?', ack, nick)
  }

  webSocketClose(ws, code, reason) {
    // 1005 and 1006 cannot be sent back, and a runtime that already answered
    // the close throws on a second one.
    try { ws.close(code, reason) } catch {}
  }

  invite(nick) {
    const t = now()
    this.sql.exec('DELETE FROM invites WHERE expires <= ?', t)
    // A code that expires unspent gives its seat back; a join never does.
    let left = null
    if (nick !== this.owner) {
      const { used } = this.sql.exec('SELECT (SELECT COUNT(*) FROM members WHERE invitedBy = ?) + (SELECT COUNT(*) FROM invites WHERE byNick = ?) AS used', nick, nick).one()
      if (used >= INVITE_ALLOWANCE) return refuse(403, `You have vouched for ${INVITE_ALLOWANCE}, counting codes not yet spent. A code nobody spends gives its seat back when it expires.`)
      left = INVITE_ALLOWANCE - used - 1
    }
    const code = inviteCode()
    this.sql.exec('INSERT INTO invites (code, byNick, expires) VALUES (?, ?, ?)', code, nick, t + INVITE_SECONDS)
    return answer({ code, expires: t + INVITE_SECONDS, left }, 201)
  }

  members() {
    return answer({ members: this.sql.exec('SELECT number, nick, invitedBy, fliVersion, publicKey, sealKey, root, seq, head, joined FROM members ORDER BY number').toArray() })
  }

  // ─── the member row ──────────────────────────────────────────────────────

  /** The post's own signing pair, made on first use; two first uses racing keep whichever lands first. */
  async postKeys() {
    const held = this.sql.exec('SELECT publicKey, privateKey FROM post').toArray()[0]
    if (held) return held
    const made = await generateSigningKeys()
    this.sql.exec('INSERT OR IGNORE INTO post (id, publicKey, privateKey) VALUES (1, ?, ?)', made.publicKey, made.privateKey)
    return this.sql.exec('SELECT publicKey, privateKey FROM post').one()
  }

  /** `{ row, postKey }` for `nick` as stored now, or null for a member with no chain, whose row would bind no key. */
  async signedRow(nick) {
    const keys = await this.postKeys()
    // Read after the await, so the row is one moment of the table.
    const m = this.sql.exec('SELECT number, nick, root, head, joined, invitedBy, fliVersion FROM members WHERE nick = ?', nick).toArray()[0]
    if (!m?.root) return null
    const row = await signRow(keys.privateKey, { ...m, invitedBy: m.invitedBy ?? null, fliVersion: m.fliVersion ?? null, signed: now() })
    return { row, postKey: keys.publicKey }
  }

  // A member's row by nick or by number, the caller's own with neither. A
  // machine fetches its own before its copy is a day old, and after its chain
  // moves; `frontier:who` reads anyone's.
  async row(own, __, url) {
    const number = url.searchParams.get('number')
    const nick = number
      ? this.sql.exec('SELECT nick FROM members WHERE number = ?', Number(number)).toArray()[0]?.nick
      : String(url.searchParams.get('nick') ?? own).trim().toLowerCase()
    if (!nick) return refuse(404, `No member is #${number}.`)
    if (!this.sql.exec('SELECT 1 FROM members WHERE nick = ?', nick).toArray().length) return refuse(404, `No member is called '${nick}'.`)
    const signed = await this.signedRow(nick)
    if (!signed) return refuse(409, `${nick} has published no chain yet, so a row would bind no key. Any \`fli tell\` verb publishes it.`)
    return answer(signed)
  }

  // Opened on its own, an SVG is a document on the post's origin, and the
  // CSP keeps anything in it from running there.
  badge(number) {
    const m = this.sql.exec('SELECT nick, root FROM members WHERE number = ?', number).toArray()[0]
    if (!m) return refuse(404, `No member is ${memberNumber(number)}.`)
    if (!m.root) return refuse(409, `${memberNumber(number)} has published no chain yet, so there is no crest to draw. Any \`fli tell\` verb publishes it.`)
    return new Response(crestSvg(m.root, `${memberNumber(number)} ${m.nick}`), { headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': BADGE_CACHE,
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
    } })
  }

  // A member's links as they were signed, for a client to verify itself:
  // the post's word on a chain is worth nothing to the peer reading it. A
  // member with no chain answers none, and a client that pinned one refuses
  // that as a chain cut short. No nick is the caller's own, which is how a
  // paper key typed on a new machine learns whose it is.
  chain(own, __, url) {
    const nick = String(url.searchParams.get('nick') ?? own).trim().toLowerCase()
    if (!this.sql.exec('SELECT 1 FROM members WHERE nick = ?', nick).toArray().length) return refuse(404, `No member is called '${nick}'.`)
    return answer({ nick, links: this.links(nick) })
  }

  links(nick) {
    return this.sql.exec('SELECT link FROM links WHERE nick = ? ORDER BY seq', nick).toArray().map(row => JSON.parse(row.link))
  }

  /** `{ chain }` for links that verify and may stand for `nick`, else `{ status, refused }`. */
  async graded(nick, links) {
    if (JSON.stringify(links ?? null).length > CHAIN_MAX) return { status: 413, refused: 'That chain is too long.' }
    const chain = await readChain(links)
    if (chain.refused) return { status: 400, refused: `The chain does not verify: ${chain.refused}.` }
    if (!SEAL_KEY.test(chain.sealKey)) return { status: 400, refused: 'The chain\'s sealing key is not 32 bytes of base64url.' }
    const held = chain.machines.map(key => this.sql.exec('SELECT nick FROM machines WHERE publicKey = ?', key).toArray()[0]).find(m => m && m.nick !== nick)
    if (held) return { status: 409, refused: `A machine in that chain is already ${held.nick}'s.` }
    return { chain }
  }

  /**
   * The chain stored for `nick`, its links replaced from the first new one and
   * its machines and sealing key the chain's; a machine the chain revoked
   * loses its box, its rekey and its socket. Synchronous, so no request lands
   * between the grading and the write.
   */
  storeChain(nick, links, chain, fromSeq) {
    for (const link of links.slice(fromSeq)) {
      this.sql.exec('INSERT OR REPLACE INTO links (nick, seq, link) VALUES (?, ?, ?)', nick, link.seq, JSON.stringify(link))
    }
    this.sql.exec('DELETE FROM machines WHERE nick = ?', nick)
    for (const key of chain.machines) this.sql.exec('INSERT INTO machines (publicKey, nick) VALUES (?, ?)', key, nick)
    this.sql.exec('UPDATE members SET sealKey = ?, root = ?, seq = ?, head = ? WHERE nick = ?', chain.sealKey, chain.root, chain.seq, chain.head, nick)
    for (const { machine } of chain.revoked) {
      this.sql.exec('DELETE FROM boxes WHERE machine = ?', machine)
      this.sql.exec('DELETE FROM rekeys WHERE machine = ?', machine)
      for (const ws of this.state.getWebSockets(machine)) {
        try { ws.close(4403, 'This machine was revoked from its member.') } catch {}
      }
    }
  }

  // How a member's chain reaches the post: whole, every link checked again,
  // and taken only when it carries the stored one forward. A member with no
  // chain yet takes the root that names the machine it came in with, which is
  // how a member from before chains, the owner included, becomes a chain of
  // one. The same chain again is answered as stored. A chain that rotates the
  // sealing key brings `rekeys`, the new pair sealed to each machine left,
  // which the post holds without reading.
  async extendChain(nick, body) {
    const { links, rekeys = {} } = parse(body)
    const graded = await this.graded(nick, links)
    if (graded.refused) return refuse(graded.status, graded.refused)
    const { chain } = graded
    const sealedTo = Object.entries(rekeys && typeof rekeys === 'object' ? rekeys : {})
    if (sealedTo.length > REKEYS_MAX || sealedTo.some(([machine, sealed]) => !chain.machines.includes(machine) || typeof sealed !== 'string' || !sealed.startsWith('v1.') || sealed.length > SEALED_MAX)) {
      return refuse(400, 'A chain\'s rekeys are { machine: sealed } for machines in it.')
    }
    const stored = this.sql.exec('SELECT publicKey, root, seq, head FROM members WHERE nick = ?', nick).one()
    if (stored.root) {
      const behind = extendsSeen(stored, chain)
      if (behind) return refuse(409, `That chain does not carry ${nick}'s forward: ${behind}.`)
    } else if (links[0].machine !== stored.publicKey) {
      return refuse(409, `A first chain for ${nick} is rooted at the machine they came in with, and this one is not.`)
    }
    if (stored.root && chain.seq === stored.seq) return answer({ nick, root: chain.root, seq: chain.seq, head: chain.head })
    this.storeChain(nick, links, chain, stored.root ? stored.seq : 0)
    for (const [machine, sealed] of sealedTo) {
      this.sql.exec('INSERT OR REPLACE INTO rekeys (machine, sealKey, sealed) VALUES (?, ?, ?)', machine, chain.sealKey, sealed)
    }
    return answer({ nick, root: chain.root, seq: chain.seq, head: chain.head })
  }

  // ─── box keys and rekeys ─────────────────────────────────────────────────

  // A machine's claim to its own box key, verified here only so the table
  // holds nothing a machine did not sign; the machine that seals to it
  // verifies it again.
  async putBox(nick, body, _, machine) {
    const claim = parse(body)
    if (!SEAL_KEY.test(String(claim.box ?? '')) || !await verifyBox(machine, claim)) return refuse(400, 'A box is { box, sig }, signed by the machine it is for.')
    this.sql.exec('INSERT OR REPLACE INTO boxes (machine, box, sig) VALUES (?, ?, ?)', machine, claim.box, claim.sig)
    return answer({ box: claim.box }, 201)
  }

  boxes(nick) {
    return answer({ boxes: this.sql.exec('SELECT b.machine, b.box, b.sig FROM boxes b JOIN machines m ON m.publicKey = b.machine WHERE m.nick = ?', nick).toArray() })
  }

  // The member's sealing pair as the last revoke sealed it to this machine,
  // and only while it is still the member's.
  rekey(nick, _, __, machine) {
    const row = this.sql.exec('SELECT r.sealKey, r.sealed FROM rekeys r JOIN members m ON m.sealKey = r.sealKey WHERE r.machine = ? AND m.nick = ?', machine, nick).toArray()[0]
    if (!row) return refuse(404, 'No sealing key was sealed to this machine since the last revoke.')
    return answer(row)
  }

  // ─── linking ─────────────────────────────────────────────────────────────

  /** The asking machine's request verified against the key it names, else a refusal. */
  async asker(req, url, body) {
    const machine = req.headers.get(KEY_HEADER)
    if (!machine) return { refused: refuse(401, `A request is signed and names its key in ${KEY_HEADER}.`) }
    const verdict = await this.verify(req, url, body, machine)
    if (!verdict.ok) return { refused: refuse(401, `The signature does not verify: ${verdict.reason}.`) }
    return { machine }
  }

  // Asked again until it is answered an offer: the same ask is kept, a new
  // sealing key replaces it, and an ask runs out ten minutes after it was
  // first made.
  async ask(req, url, body) {
    const { machine, refused } = await this.asker(req, url, body)
    if (refused) return refused
    const { sealKey } = parse(body)
    if (!SEAL_KEY.test(String(sealKey ?? ''))) return refuse(400, 'An ask is { sealKey }, the key the member\'s sealing key is sealed to.')
    const code = await askCode(machine, sealKey)

    const t = now()
    this.sql.exec('DELETE FROM asks WHERE expires <= ?', t)
    if (this.sql.exec('SELECT 1 FROM machines WHERE publicKey = ?', machine).toArray().length) return refuse(409, 'That key is already a member\'s machine.')
    const held = this.sql.exec('SELECT * FROM asks WHERE machine = ?', machine).toArray()[0]
    if (held?.code === code) {
      if (!held.link) return answer({ code, expires: held.expires }, 202)
      return answer({ nick: held.nick, links: this.links(held.nick), link: JSON.parse(held.link), sealed: held.sealed })
    }
    if (held) this.sql.exec('DELETE FROM asks WHERE machine = ?', machine)
    else if (this.sql.exec('SELECT COUNT(*) AS n FROM asks').one().n >= ASKS_MAX) return refuse(429, 'Too many machines are waiting to be linked. Try again in a few minutes.')
    this.sql.exec('INSERT INTO asks (code, machine, sealKey, expires) VALUES (?, ?, ?, ?)', code, machine, sealKey, t + ASK_SECONDS)
    return answer({ code, expires: t + ASK_SECONDS }, 202)
  }

  // The asking machine's keys for the member who typed its words — the
  // keys, not the post's word on them: the typing side hashes them against
  // the words.
  readAsk(_, __, url) {
    const row = this.sql.exec('SELECT machine, sealKey, link FROM asks WHERE code = ? AND expires > ?', String(url.searchParams.get('code') ?? ''), now()).toArray()[0]
    if (!row) return refuse(404, 'No machine is waiting under those words. They run out after ten minutes; ask again on the new machine.')
    if (row.link) return refuse(409, 'Another machine already offered a link to that ask.')
    return answer({ machine: row.machine, sealKey: row.sealKey })
  }

  async offer(nick, body, _, by) {
    const { code, link, sealed } = parse(body)
    if (!link || typeof link !== 'object' || typeof sealed !== 'string' || !sealed.startsWith('v1.') || sealed.length > SEALED_MAX) return refuse(400, 'An offer is { code, link, sealed }.')
    if (link.kind !== 'link' || link.by !== by) return refuse(400, 'An offer is a link signed by the machine that sends it.')
    if (!await verifyMessage({ publicKey: by, signature: link.sig, message: linkMessage(link) })) return refuse(400, 'The link\'s signature does not verify.')

    const stored = this.sql.exec('SELECT root, seq, head FROM members WHERE nick = ?', nick).one()
    if (!stored.root) return refuse(409, `${nick} has published no chain yet, so there is nothing to link to. Any \`fli tell\` verb publishes it.`)
    if (link.seq !== stored.seq + 1 || link.prev !== stored.head) return refuse(409, `That link does not follow ${nick}'s chain as the post holds it, link ${stored.seq}.`)
    const row = this.sql.exec('SELECT machine, link FROM asks WHERE code = ? AND expires > ?', String(code ?? ''), now()).toArray()[0]
    if (!row) return refuse(404, 'No machine is waiting under those words. They run out after ten minutes; ask again on the new machine.')
    if (row.link) return refuse(409, 'Another machine already offered a link to that ask.')
    if (link.machine !== row.machine) return refuse(400, 'That link names another machine than the one asking.')
    this.sql.exec('UPDATE asks SET nick = ?, link = ?, sealed = ? WHERE code = ?', nick, JSON.stringify(link), sealed, code)
    return answer({ code }, 201)
  }

  // The asker's chain, countersigned: taken only when it is the stored chain
  // and the offered link with the asker's signature added, and nothing else.
  async accept(req, url, body) {
    const { machine, refused } = await this.asker(req, url, body)
    if (refused) return refused
    const { links } = parse(body)
    const asked = this.sql.exec('SELECT nick FROM asks WHERE machine = ? AND link IS NOT NULL AND expires > ?', machine, now()).toArray()[0]
    if (!asked) return refuse(404, 'This machine has no offer waiting. Ask again.')
    const { nick } = asked
    const graded = await this.graded(nick, links)
    if (graded.refused) return refuse(graded.status, graded.refused)
    const { chain } = graded

    // Read again after the awaits: another request may have landed in them.
    const row = this.sql.exec('SELECT link FROM asks WHERE machine = ? AND nick = ?', machine, nick).toArray()[0]
    const offered = row && JSON.parse(row.link)
    const last = links.at(-1)
    if (!offered || linkMessage(last) !== linkMessage(offered) || last.sig !== offered.sig) return refuse(409, 'That chain does not end on the link offered to this machine.')
    const stored = this.sql.exec('SELECT root, seq, head FROM members WHERE nick = ?', nick).one()
    const behind = extendsSeen(stored, chain)
    if (behind || chain.seq !== stored.seq + 1) return refuse(409, `${nick}'s chain moved since the offer${behind ? ` (${behind})` : ''}. Ask again.`)
    this.storeChain(nick, links, chain, stored.seq)
    this.sql.exec('DELETE FROM asks WHERE machine = ?', machine)
    return answer({ nick, root: chain.root, seq: chain.seq, head: chain.head })
  }

  async join(req, url, body) {
    const { code, nick: asked, chain: links, fliVersion } = parse(body)
    const machine = Array.isArray(links) ? links[0]?.machine : undefined
    if (typeof machine !== 'string' || !machine) return refuse(400, 'A join is { code, nick, chain }, signed by the machine the chain\'s root names. A newer fli sends one.')

    // The machine in the root is the key that must have signed the join, so
    // a join naming somebody else's key verifies under nothing it holds.
    const verdict = await this.verify(req, url, body, machine)
    if (!verdict.ok) return refuse(401, `The signature does not verify: ${verdict.reason}.`)

    const nick = typeof asked === 'string' ? asked.trim().toLowerCase() : ''
    if (!NICK.test(nick)) return refuse(400, 'A nick is 2 to 16 lower-case letters, digits, - and _.')
    if (RESERVED.has(nick)) return refuse(409, `The nick '${nick}' is reserved: it reads as the post or the project speaking. Choose another.`)
    if (links.length !== 1) return refuse(400, 'A join brings a chain of one, its root. A machine linked to a member is already in.')
    if (fliVersion !== undefined && !FLI_VERSION.test(String(fliVersion))) return refuse(400, 'A join\'s fliVersion is the version of the fli that sent it.')
    // Made before the synchronous run below, so the join's own row costs it no await.
    await this.postKeys()
    const graded = await this.graded(nick, links)
    if (graded.refused) return refuse(graded.status, graded.refused)

    // From here to the insert is one synchronous run: a Durable Object takes
    // another request at an await, so two joins on one code or one nick must
    // both be checked after the last of them.
    if (this.sql.exec('SELECT 1 FROM machines WHERE publicKey = ?', machine).toArray().length) return refuse(409, 'That key is already a member.')
    if (this.sql.exec('SELECT 1 FROM members WHERE nick = ?', nick).toArray().length) return refuse(409, `The nick '${nick}' is taken. Choose another.`)
    const spent = this.sql.exec('DELETE FROM invites WHERE code = ? AND expires > ? RETURNING byNick', String(code ?? ''), now()).toArray()[0]
    if (!spent) return refuse(403, 'That invite is spent, expired or unknown. Ask a member for a new one.')
    // Drawn in the same synchronous run, so two joins cannot draw one
    // number; a member never leaves the table, so a number is never reused.
    const { number } = this.sql.exec('INSERT INTO members (nick, publicKey, joined, number, invitedBy, fliVersion) VALUES (?, ?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM members), ?, ?) RETURNING number', nick, machine, now(), spent.byNick, fliVersion ?? null).one()
    this.storeChain(nick, links, graded.chain, 0)
    return answer({ number, nick, invitedBy: spent.byNick, root: graded.chain.root, ...await this.signedRow(nick) }, 201)
  }

  // ─── files ───────────────────────────────────────────────────────────────

  // An ask holds its size against the allowance and the budget from the
  // moment it is answered, so a hundred asks racing cannot each see room.
  async askFile(nick, body) {
    const { size, seconds = FILE_SECONDS, downloads = 1 } = parse(body)
    if (!Number.isSafeInteger(size) || size < 1) return refuse(400, 'A file is { size, seconds, downloads }, its size the bytes it will be put as.')
    if (size > FILE_MAX) return refuse(413, `A file is at most ${FILE_MAX} bytes as put; this one is ${size}.`)
    if (!Number.isSafeInteger(seconds) || seconds < FILE_SECONDS_MIN || seconds > FILE_SECONDS_MAX) return refuse(400, `A link lasts ${FILE_SECONDS_MIN} to ${FILE_SECONDS_MAX} seconds.`)
    if (!Number.isSafeInteger(downloads) || downloads < 1 || downloads > FILE_DOWNLOADS_MAX) return refuse(400, `A link allows 1 to ${FILE_DOWNLOADS_MAX} downloads.`)
    const id = randomCode(16)
    const token = randomCode(32)
    const tokenHash = await sha256(token)

    // From here to the insert is one synchronous run, as the join's is.
    const t = now()
    this.sql.exec('DELETE FROM uploads WHERE at <= ?', t - 86400)
    if (nick !== this.owner) {
      if (this.sql.exec('SELECT COUNT(*) AS n FROM uploads WHERE nick = ?', nick).one().n >= FILES_A_DAY) return refuse(429, `A member uploads ${FILES_A_DAY} files a day.`)
      const held = this.sql.exec('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE nick = ?', nick).one().n
      if (held + size > FILES_HELD) return refuse(429, `A member holds ${FILES_HELD} bytes at a time, and you hold ${held}. A file gives its bytes back after its last download or when it expires.`)
    }
    const total = this.sql.exec('SELECT COALESCE(SUM(size), 0) AS n FROM files').one().n
    if (total + size > FILE_BUDGET) return refuse(507, `The post holds all the bytes it may (${FILE_BUDGET}). Try again when a file expires.`)
    const expires = t + seconds
    this.sql.exec('INSERT INTO files (id, nick, size, created, expires, downloadsLeft, tokenHash, state, sweepAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, nick, size, t, expires, downloads, tokenHash, 'asked', Math.min(t + PUT_SECONDS, expires))
    this.sql.exec('INSERT INTO uploads (nick, at) VALUES (?, ?)', nick, t)
    await this.schedule()
    return answer({ id, putToken: token, size, expires, downloads }, 201)
  }

  /** The Worker's steps, unsigned: only the Worker reaches a `/file/<id>/<step>` path. */
  fileStep(step, id, body) {
    return { put: this.putFile, held: this.holdFile, take: this.takeFile, drained: this.drainFile, peek: this.peekFile }[step].call(this, id, body)
  }

  // The token is spent once, by the upload whose length is the size asked
  // for; a wrong length leaves it unspent to try again.
  async putFile(id, body) {
    const { token, length } = parse(body)
    const tokenHash = await sha256(String(token ?? ''))
    const row = this.sql.exec('SELECT size, state, tokenHash, sweepAt FROM files WHERE id = ?', id).toArray()[0]
    if (!row || row.tokenHash !== tokenHash) return refuse(403, 'No upload waits under that id and token.')
    if (row.state !== 'asked') return refuse(409, 'That file was already put. Ask for a new one.')
    if (row.sweepAt <= now()) return refuse(410, `An ask is put within ${PUT_SECONDS} seconds. Ask for a new one.`)
    if (length !== row.size) return refuse(400, `That file was asked for as ${row.size} bytes, and this upload is ${length}.`)
    this.sql.exec('UPDATE files SET state = ? WHERE id = ?', 'putting', id)
    return answer({ size: row.size })
  }

  // Refused once the ask's time is past, because the sweep may already have
  // deleted the object, and a row held over no object would serve a 404.
  async holdFile(id) {
    const row = this.sql.exec('UPDATE files SET state = ?, sweepAt = expires WHERE id = ? AND state = ? AND sweepAt > ? RETURNING expires, downloadsLeft', 'held', id, 'putting', now()).toArray()[0]
    if (!row) return refuse(410, `An ask is put within ${PUT_SECONDS} seconds, and this one was swept. Ask for a new one.`)
    await this.schedule()
    return answer({ id, expires: row.expires, downloads: row.downloadsLeft }, 201)
  }

  async takeFile(id) {
    const t = now()
    const row = this.sql.exec(`UPDATE files SET downloadsLeft = downloadsLeft - 1, sweepAt = CASE WHEN downloadsLeft = 1 THEN MIN(expires, ?) ELSE sweepAt END
      WHERE id = ? AND state = ? AND downloadsLeft > 0 AND expires > ? RETURNING downloadsLeft`, t + DRAIN_SECONDS, id, 'held', t).toArray()[0]
    if (row) {
      if (row.downloadsLeft === 0) await this.schedule()
      return answer({ left: row.downloadsLeft })
    }
    const held = this.sql.exec('SELECT state, downloadsLeft FROM files WHERE id = ?', id).toArray()[0]
    if (!held) return refuse(404, 'No file is held under that link: it was downloaded as often as it allowed, it expired, or it never was.')
    if (held.state !== 'held') return refuse(409, 'That file is still being uploaded.')
    if (held.downloadsLeft === 0) return refuse(410, 'That link was downloaded as often as it allows.')
    return refuse(410, 'That link has expired.')
  }

  /** What the download page says before a click spends a download. */
  peekFile(id) {
    const row = this.sql.exec('SELECT state, expires, downloadsLeft, root FROM files LEFT JOIN members USING (nick) WHERE id = ?', id).toArray()[0]
    if (!row || row.downloadsLeft === 0 || row.expires <= now()) return refuse(404, 'No file is held under that link: it was downloaded as often as it allowed, it expired, or it never was.')
    if (row.state !== 'held') return refuse(409, 'That file is still being uploaded.')
    return answer({ expires: row.expires, downloads: row.downloadsLeft, root: row.root })
  }

  async drainFile(id) {
    if (!this.sql.exec('SELECT 1 FROM files WHERE id = ? AND downloadsLeft = 0', id).toArray().length) return answer({ id })
    return this.dropFile(id)
  }

  // The kill switch (6.6): the uploader's own file, or any file for the owner.
  async removeFile(nick, id) {
    const row = this.sql.exec('SELECT nick FROM files WHERE id = ?', id).toArray()[0]
    if (!row) return refuse(404, 'No file is held under that id.')
    if (row.nick !== nick && nick !== this.owner) return refuse(403, 'A file is deleted by the member who uploaded it, or by the owner.')
    return this.dropFile(id)
  }

  // The object goes first: a row deleted over an object left behind would
  // free its budget while R2 still bills for it.
  async dropFile(id) {
    await this.env.FILES.delete(id)
    this.sql.exec('DELETE FROM files WHERE id = ?', id)
    await this.schedule()
    return answer({ id })
  }

  async schedule() {
    const { at } = this.sql.exec('SELECT MIN(sweepAt) AS at FROM files').one()
    if (at === null) await this.state.storage.deleteAlarm()
    else await this.state.storage.setAlarm(at * 1000)
  }

  // Only a row still due after the delete returns goes: a step that landed
  // during the await moved its sweepAt, or refused because it was due.
  async alarm() {
    const t = now()
    const ids = this.sql.exec('SELECT id FROM files WHERE sweepAt <= ?', t).toArray().map(row => row.id)
    if (ids.length) await this.env.FILES.delete(ids)
    for (const id of ids) this.sql.exec('DELETE FROM files WHERE id = ? AND sweepAt <= ?', id, t)
    await this.schedule()
  }
}

function parse(body) {
  try {
    const value = JSON.parse(body || '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

// ─── the Worker ────────────────────────────────────────────────────────────

const thePost = env => env.POST.get(env.POST.idFromName('post'))

/** One file step asked of the object; its Response, refusal or not. */
const step = (env, id, name, body = {}) =>
  thePost(env).fetch(new Request(`https://post/file/${id}/${name}`, { method: 'POST', body: JSON.stringify(body) }))

const FILE_ONE   = new RegExp(`^/file/(${FILE_ID})$`)
const FILE_BYTES = new RegExp(`^/file/(${FILE_ID})/bytes$`)

async function putBytes(req, env, id) {
  const token  = req.headers.get(FILE_TOKEN)
  const length = Number(req.headers.get('content-length'))
  if (!token) return refuse(401, `A file is put with the token its ask answered, in ${FILE_TOKEN}.`)
  if (!req.body || !Number.isSafeInteger(length)) return refuse(411, 'A file is put with its Content-Length.')
  const spent = await step(env, id, 'put', { token, length })
  if (!spent.ok) return spent
  let stored
  try { stored = await env.FILES.put(id, req.body) } catch {}
  if (stored?.size !== length) {
    await env.FILES.delete(id)
    return refuse(400, 'The upload stopped short of its length. Ask for a new one.')
  }
  const held = await step(env, id, 'held')
  if (!held.ok) await env.FILES.delete(id)
  return held
}

// The last download tells the object when its stream ends, so the sweep
// need not wait out DRAIN_SECONDS; a client that hangs up ends it too.
async function getBytes(env, ctx, id) {
  const taken = await step(env, id, 'take')
  if (!taken.ok) return taken
  const { left } = await taken.json()
  const object = await env.FILES.get(id)
  if (!object) return refuse(404, 'No file is held under that link.')
  const { readable, writable } = new FixedLengthStream(object.size)
  const piped = object.body.pipeTo(writable).catch(() => {})
  ctx.waitUntil(left === 0 ? piped.then(() => step(env, id, 'drained')) : piped)
  return new Response(readable, { headers: {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-downloads-left': String(left),
  } })
}

// A link's page fetches nothing until the click, so a chat app's preview of
// the link spends no download. It loads no script but its own, and CSP pins
// that script by hash.
const PAGE_STYLE = 'body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 16px;color:#1b1b1f;background:#fff}'
  + 'button{font:inherit;padding:.5rem 1.25rem;cursor:pointer}'
  + '.from svg{width:96px;height:96px;display:block}'
  + '@media (prefers-color-scheme:dark){body{color:#e8e8ec;background:#151518}}'

const PAGE_SCRIPT = `${openFile}
const said = document.getElementById('said')
const button = document.getElementById('get')
// A key pasted onto the open page is a fragment change, which reloads nothing.
const keyed = () => {
  button.disabled = !location.hash.slice(1)
  said.textContent = button.disabled ? 'This link has no key after its #, so the file cannot be opened. Ask for the link again, whole.' : ''
}
keyed()
addEventListener('hashchange', keyed)
button.addEventListener('click', async () => {
  const key = location.hash.slice(1)
  removeEventListener('hashchange', keyed)
  button.disabled = true
  said.textContent = 'Downloading...'
  const res = await fetch(location.pathname + '/bytes')
  if (!res.ok) {
    said.textContent = (await res.json().catch(() => null))?.message ?? 'The post refused (' + res.status + ').'
    return
  }
  const left = res.headers.get('x-downloads-left')
  const file = await openFile(new Uint8Array(await res.arrayBuffer()), key)
  if (!file) {
    said.textContent = 'The key in this link does not open the file: the link was cut short, or the file is not the one that was put. Nothing was saved.'
    return
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([file.bytes], { type: file.type || 'application/octet-stream' }))
  a.download = file.name || 'download'
  document.body.append(a)
  a.click()
  said.textContent = 'Saved ' + a.download + '. ' + (left === '0' ? 'The link is spent.' : left + ' download' + (left === '1' ? '' : 's') + ' left on the link.')
})
`

const hashSource = async text =>
  `'sha256-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))))}'`

async function pageResponse(status, main, script = '') {
  const csp = [
    "default-src 'none'", `style-src ${await hashSource(PAGE_STYLE)}`,
    ...script ? [`script-src ${await hashSource(script)}`, "connect-src 'self'"] : [],
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ')
  return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>A file at the Frontier post</title><style>${PAGE_STYLE}</style><main><h1>A file for you</h1>${main}</main>`
    + (script ? `<script>${script}</script>` : ''), { status, headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': csp,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  } })
}

async function filePage(env, id) {
  const peeked = await step(env, id, 'peek')
  const { message, root, ...held } = await peeked.json()
  if (!peeked.ok) return pageResponse(peeked.status, `<p>${message}</p>`)
  // The sender's crest, so a link is traced to a member at a glance: the
  // name a post vouches for is what made Firefox Send a phishing host.
  const from = root ? `<div class="from">${crestSvg(root)}</div>` : ''
  return pageResponse(200, `${from}<p>A sealed file: ${fileLimits(held, now())}.</p><button id="get" type="button">Download</button><p id="said" role="status"></p>`, PAGE_SCRIPT)
}

// The Worker handles the bytes of `/file/` and forwards only the routes a
// member signs; every other `/file/` path stops here, so the object's steps
// are the Worker's alone.
export default {
  fetch(req, env, ctx) {
    const { pathname } = new URL(req.url)
    if (pathname.startsWith('/file/')) {
      const put   = req.method === 'PUT' && pathname.match(FILE_ONE)
      const bytes = req.method === 'GET' && pathname.match(FILE_BYTES)
      const page  = req.method === 'GET' && pathname.match(FILE_ONE)
      if (put) return putBytes(req, env, put[1])
      if (bytes) return getBytes(env, ctx, bytes[1])
      if (page) return filePage(env, page[1])
      if (!(req.method === 'DELETE' && FILE_ONE.test(pathname))) return refuse(404, `No route ${req.method} ${pathname}.`)
    }
    return thePost(env).fetch(req)
  },
}
