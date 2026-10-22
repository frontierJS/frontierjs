// core/tell-worker.js — the server `fli tell` speaks to: one Cloudflare Worker
// and one Durable Object holding every member, invite and letter
// (IDEAS/pony-express.md 1.1, FJS-D1392).
//
// Never imported by the cli. `fli tell:setup` points a wrangler config at this
// file and wrangler bundles it, so it runs in workerd and may use nothing a
// Worker lacks. It ships because `core/` is in the package's `files`.
//
// Every route but `join` is signed by a member's key (toolbelt's
// `signRequest`), named in `x-tell-key`; a key no member holds is refused
// before the signature is looked at. `join` is signed by the key it brings,
// as Haven's login is. The owner is member one, seeded from the OWNER_KEY
// and OWNER_NICK vars that `tell:setup` writes.
//
// A member with a sealing key (FJS-D1400) is sent only sealed letters, and
// a plain one to them is refused here rather than trusted to the sender
// (FJS-D1402), so the post holds only ciphertext for them. A letter to a
// member with none is plaintext, as V1's were (FJS-D1393). Reading deletes
// either (FJS-D1395). The post hands out the keys, and a client pins them on
// first contact and signs inside the seal (IDEAS/pony-express.md 4.1), so a
// host swapping a key or writing a letter is caught there, not here.
//
// `GET /follow` is a WebSocket, signed like every other route at the upgrade.
// The object pushes the waiting letters on accept and each new one as `send`
// writes it, and deletes a letter only when the socket acks its id, so a
// client that dies before printing gets it again. Two followers of one member
// both print it; the first ack deletes it.
//
// `GET /waiting` counts a member's letters by sender and deletes nothing — the
// background check behind the notice line every `fli` command prints.

import { verifyRequest } from '@frontierjs/toolbelt/signature'

// ─── limits ────────────────────────────────────────────────────────────────

/** Seconds a signature stays fresh. A nonce is kept twice this (FJS-1833). */
const WINDOW       = 300
/** Haven's `messages.service.ts` number: five sends in ten seconds. */
const SEND_MAX     = 5
const SEND_SECONDS = 10
/** An invite is spent by its first join or expires in a day (FJS-D1394). */
const INVITE_SECONDS = 86400
const BODY_MAX     = 4000
/** A sealed letter's length, opaque here: 4000 characters JSON-escaped, sealed, then base64url, with room. */
const SEALED_MAX   = 32768
/** `@frontierjs/toolbelt/seal`'s public key, 32 bytes of base64url. */
const SEAL_KEY     = /^[A-Za-z0-9_-]{43}$/
/** Haven's `Member.nick` rule, so a nick here is one Haven accepts in Phase 5. */
const NICK         = /^[a-z0-9_-]{2,16}$/

const KEY_HEADER = 'x-tell-key'

const LETTER = 'id, fromNick AS "from", body, sealed, created'

/** One letter as a client reads it, from `/inbox` and down a `/follow` socket alike — `text` or `sealed`, never both. */
const letterOut = ({ id, from, body, sealed, created }) =>
  sealed ? { id, from, sealed: body, created } : { id, from, text: body, created }

const now = () => Math.floor(Date.now() / 1000)
const answer = (body, status = 200) => Response.json(body, { status })
const refuse = (status, message) => answer({ message }, status)

function inviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

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
    `)
    // A post deployed before the seal keeps its members (FJS-D1400 publishes
    // their keys by a signed update), so its tables gain the two columns; a
    // column already there throws and is left.
    for (const [table, column] of [['members', 'sealKey TEXT'], ['letters', 'sealed INTEGER NOT NULL DEFAULT 0']]) {
      try { this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`) } catch {}
    }
    const owner = String(env.OWNER_NICK ?? '').trim().toLowerCase()
    if (env.OWNER_KEY && NICK.test(owner)) {
      this.sql.exec('INSERT OR IGNORE INTO members (nick, publicKey, joined) VALUES (?, ?, ?)', owner, env.OWNER_KEY, now())
    }
  }

  async fetch(req) {
    const url  = new URL(req.url)
    const body = await req.text()
    const route = `${req.method} ${url.pathname}`
    if (route === 'POST /join') return this.join(req, url, body)
    if (route === 'GET /follow') return this.follow(req, await this.member(req, url, body))

    const handler = {
      'POST /send':   this.send,
      'GET /inbox':   this.inbox,
      'GET /waiting': this.waiting,
      'POST /invite': this.invite,
      'GET /members': this.members,
      'POST /seal-key': this.sealKey,
    }[route]
    if (!handler) return refuse(404, `No route ${route}.`)

    const who = await this.member(req, url, body)
    if (who.refused) return refuse(who.status, who.refused)
    return handler.call(this, who.nick, body)
  }

  /** `{ nick }` for a signed request from a member, else `{ status, refused }`. */
  async member(req, url, body) {
    const publicKey = req.headers.get(KEY_HEADER)
    if (!publicKey) return { status: 401, refused: `A request is signed and names its key in ${KEY_HEADER}.` }
    const member = this.sql.exec('SELECT nick FROM members WHERE publicKey = ?', publicKey).toArray()[0]
    if (!member) return { status: 403, refused: 'That key is no member here. `fli tell:join <code>` walks in with an invite.' }

    const verdict = await this.verify(req, url, body, publicKey)
    if (!verdict.ok) return { status: 401, refused: `The signature does not verify: ${verdict.reason}.` }
    return { nick: member.nick }
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

  // What the notice line names (IDEAS/pony-express.md 2.2): who has letters
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
      this.state.acceptWebSocket(server, [who.nick])
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
    const code = inviteCode()
    this.sql.exec('INSERT INTO invites (code, byNick, expires) VALUES (?, ?, ?)', code, nick, t + INVITE_SECONDS)
    return answer({ code, expires: t + INVITE_SECONDS }, 201)
  }

  members() {
    return answer({ members: this.sql.exec('SELECT nick, publicKey, sealKey, joined FROM members ORDER BY joined, nick').toArray() })
  }

  // How a member publishes the key letters to them are sealed to: at setup
  // for the owner, and on the first verb after the seal for anyone who joined
  // before it. Signed by the member's signing key like every route, so only
  // that member sets it. A new key replaces the old, and a letter sealed to
  // the old one stays unopenable.
  sealKey(nick, body) {
    const { sealKey } = parse(body)
    if (typeof sealKey !== 'string' || !SEAL_KEY.test(sealKey)) return refuse(400, 'A sealing key is { sealKey }, 32 bytes of base64url.')
    this.sql.exec('UPDATE members SET sealKey = ? WHERE nick = ?', sealKey, nick)
    return answer({ nick, sealKey })
  }

  async join(req, url, body) {
    const { code, nick: asked, publicKey, sealKey } = parse(body)
    if (typeof publicKey !== 'string' || !publicKey) return refuse(400, 'A join is { code, nick, publicKey, sealKey }, signed with that key.')
    if (typeof sealKey !== 'string' || !SEAL_KEY.test(sealKey)) return refuse(400, 'A join brings a sealing key, 32 bytes of base64url. A newer fli makes one.')

    // The key in the body is the key that must have signed it, so a join
    // naming somebody else's key verifies under nothing it holds.
    const verdict = await this.verify(req, url, body, publicKey)
    if (!verdict.ok) return refuse(401, `The signature does not verify: ${verdict.reason}.`)

    const nick = typeof asked === 'string' ? asked.trim().toLowerCase() : ''
    if (!NICK.test(nick)) return refuse(400, 'A nick is 2 to 16 lower-case letters, digits, - and _.')
    if (this.sql.exec('SELECT 1 FROM members WHERE publicKey = ?', publicKey).toArray().length) return refuse(409, 'That key is already a member.')
    if (this.sql.exec('SELECT 1 FROM members WHERE nick = ?', nick).toArray().length) return refuse(409, `The nick '${nick}' is taken. Choose another.`)

    // Spent before the member is written, in one synchronous run: a Durable
    // Object handles one request at a time between awaits, so two joins on one
    // code cannot both see it.
    const spent = this.sql.exec('DELETE FROM invites WHERE code = ? AND expires > ? RETURNING byNick', String(code ?? ''), now()).toArray()[0]
    if (!spent) return refuse(403, 'That invite is spent, expired or unknown. Ask a member for a new one.')
    this.sql.exec('INSERT INTO members (nick, publicKey, sealKey, joined) VALUES (?, ?, ?, ?)', nick, publicKey, sealKey, now())
    return answer({ nick, invitedBy: spent.byNick, sealKey }, 201)
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

export default {
  fetch(req, env) {
    return env.POST.get(env.POST.idFromName('post')).fetch(req)
  },
}
