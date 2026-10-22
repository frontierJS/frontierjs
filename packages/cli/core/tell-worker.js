// core/tell-worker.js — the server `fli tell` speaks to: one Cloudflare Worker
// and one Durable Object holding every member, invite and letter
// (IDEAS/pony-express.md 1.1, FJS-D1392).
//
// Never imported by the cli. `fli tell:setup` points a wrangler config at this
// file and wrangler bundles it, so it runs in workerd and may use nothing a
// Worker lacks. It ships because `core/` is in the package's `files`.
//
// A member is a chain of machines (core/tell-chain.js, IDEAS/pony-express.md
// 4.3): every route but `join` is signed by one of them (toolbelt's
// `signRequest`), named in `x-tell-key`; a key that is no member's machine is
// refused before the signature is looked at. `join` is signed by the machine
// its root names, as Haven's login is. The owner is member one, seeded from
// the OWNER_KEY and OWNER_NICK vars that `tell:setup` writes, with no chain
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

import { verifyMessage, verifyRequest } from '@frontierjs/toolbelt/signature'
import { askCode, extendsSeen, linkMessage, readChain, verifyBox } from './tell-chain.js'

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
/** A chain as it travels, JSON: far past `tell-chain.js`'s 256 links of three keys and a signature each. */
const CHAIN_MAX    = 131072
/** Machines a member's rekeys are sealed to, at most — a chain's own bound. */
const REKEYS_MAX   = 256
/** A link ask waits ten minutes for a linked machine to type its words. */
const ASK_SECONDS  = 600
/** Asks open at once: anyone may ask, so the table is bounded rather than the askers. */
const ASKS_MAX     = 64
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
      CREATE TABLE IF NOT EXISTS links (nick TEXT NOT NULL, seq INTEGER NOT NULL, link TEXT NOT NULL, PRIMARY KEY (nick, seq));
      CREATE TABLE IF NOT EXISTS machines (publicKey TEXT PRIMARY KEY, nick TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asks (code TEXT PRIMARY KEY, machine TEXT NOT NULL UNIQUE, sealKey TEXT NOT NULL, expires INTEGER NOT NULL, nick TEXT, link TEXT, sealed TEXT);
      CREATE TABLE IF NOT EXISTS boxes (machine TEXT PRIMARY KEY, box TEXT NOT NULL, sig TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rekeys (machine TEXT PRIMARY KEY, sealKey TEXT NOT NULL, sealed TEXT NOT NULL);
    `)
    // A post deployed before the seal or the chain keeps its members, so its
    // tables gain the columns; a column already there throws and is left.
    // `publicKey` stays the machine a member came in with, which a chain's
    // root must name.
    for (const [table, column] of [
      ['members', 'sealKey TEXT'], ['letters', 'sealed INTEGER NOT NULL DEFAULT 0'],
      ['members', 'root TEXT'], ['members', 'seq INTEGER'], ['members', 'head TEXT'],
    ]) {
      try { this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`) } catch {}
    }
    const owner = String(env.OWNER_NICK ?? '').trim().toLowerCase()
    if (env.OWNER_KEY && NICK.test(owner)) {
      this.sql.exec('INSERT OR IGNORE INTO members (nick, publicKey, joined) VALUES (?, ?, ?)', owner, env.OWNER_KEY, now())
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

    const handler = {
      'POST /send':   this.send,
      'GET /inbox':   this.inbox,
      'GET /waiting': this.waiting,
      'POST /invite': this.invite,
      'GET /members': this.members,
      'GET /chain':   this.chain,
      'POST /chain':  this.extendChain,
      'GET /link/ask':     this.readAsk,
      'POST /link/offer':  this.offer,
      'POST /box':    this.putBox,
      'GET /boxes':   this.boxes,
      'GET /rekey':   this.rekey,
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
    if (!member) return { status: 403, refused: 'That key is no member\'s machine here. `fli tell:join <code>` walks in with an invite.' }

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
    const code = inviteCode()
    this.sql.exec('INSERT INTO invites (code, byNick, expires) VALUES (?, ?, ?)', code, nick, t + INVITE_SECONDS)
    return answer({ code, expires: t + INVITE_SECONDS }, 201)
  }

  members() {
    return answer({ members: this.sql.exec('SELECT nick, publicKey, sealKey, root, seq, head, joined FROM members ORDER BY joined, nick').toArray() })
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
    const { code, nick: asked, chain: links } = parse(body)
    const machine = Array.isArray(links) ? links[0]?.machine : undefined
    if (typeof machine !== 'string' || !machine) return refuse(400, 'A join is { code, nick, chain }, signed by the machine the chain\'s root names. A newer fli sends one.')

    // The machine in the root is the key that must have signed the join, so
    // a join naming somebody else's key verifies under nothing it holds.
    const verdict = await this.verify(req, url, body, machine)
    if (!verdict.ok) return refuse(401, `The signature does not verify: ${verdict.reason}.`)

    const nick = typeof asked === 'string' ? asked.trim().toLowerCase() : ''
    if (!NICK.test(nick)) return refuse(400, 'A nick is 2 to 16 lower-case letters, digits, - and _.')
    if (links.length !== 1) return refuse(400, 'A join brings a chain of one, its root. A machine linked to a member is already in.')
    const graded = await this.graded(nick, links)
    if (graded.refused) return refuse(graded.status, graded.refused)

    // From here to the insert is one synchronous run: a Durable Object takes
    // another request at an await, so two joins on one code or one nick must
    // both be checked after the last of them.
    if (this.sql.exec('SELECT 1 FROM machines WHERE publicKey = ?', machine).toArray().length) return refuse(409, 'That key is already a member.')
    if (this.sql.exec('SELECT 1 FROM members WHERE nick = ?', nick).toArray().length) return refuse(409, `The nick '${nick}' is taken. Choose another.`)
    const spent = this.sql.exec('DELETE FROM invites WHERE code = ? AND expires > ? RETURNING byNick', String(code ?? ''), now()).toArray()[0]
    if (!spent) return refuse(403, 'That invite is spent, expired or unknown. Ask a member for a new one.')
    this.sql.exec('INSERT INTO members (nick, publicKey, joined) VALUES (?, ?, ?)', nick, machine, now())
    this.storeChain(nick, links, graded.chain, 0)
    return answer({ nick, invitedBy: spent.byNick, root: graded.chain.root }, 201)
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
