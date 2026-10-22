---
namespace: tell
description: Letters between fli users — one Cloudflare Worker, a key per machine, an invite to join
---

<script>
const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
const { dirname, join, resolve } = await import('node:path')
const { userInfo } = await import('node:os')
const { generateSigningKeys, signMessage, verifyMessage } = await import('@frontierjs/toolbelt/signature')
const { generateSealingKeys, seal, open: openSealed } = await import('@frontierjs/toolbelt/seal')
const { TELL_DIR, KEY_FILE, CONFIG_FILE, readConfig, tellSign, tellFetch, writeWaiting, pinPeer, fingerprint } =
  await import(new URL('file://' + global.fliRoot + '/core/tell.js'))

/** Haven's `Member.nick` rule, the Worker's too — checked here so a bad nick never deploys. */
const NICK        = /^[a-z0-9_-]{2,16}$/

/** Merges into the `tell` key, keeping every other key (`haven` lives there too). */
const writeTellConfig = (patch) => {
  const config = readConfig()
  config.tell = { ...config.tell, ...patch }
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n')
}

/**
 * This machine's keys, `machineKeys`' shape in Haven's sign-in.js, made and
 * written 0600 on the first call: the Ed25519 signing pair at the top, and
 * `sealing`, the X25519 pair letters are sealed to (`FJS-D1400`). The signing
 * key IS the member: lose it and this machine is nobody until it joins again.
 */
const tellKeys = async () => {
  if (existsSync(KEY_FILE)) {
    const keys = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
    if (keys?.publicKey && keys?.privateKey) return { keys: await withSealing(keys), made: false }
    throw new Error(`${KEY_FILE} holds no key pair. Move it aside and a new one is made, which is a new member.`)
  }
  const keys = { ...await generateSigningKeys(), sealing: await generateSealingKeys() }
  mkdirSync(TELL_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(KEY_FILE, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
  return { keys, made: true }
}

/** `keys` with a sealing pair, one made and written beside the signing pair when a key file from before the seal has none. */
const withSealing = async (keys) => {
  if (keys.sealing?.publicKey && keys.sealing?.privateKey) return keys
  const next = { ...keys, sealing: await generateSealingKeys() }
  writeFileSync(KEY_FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

/**
 * Publishes this machine's sealing key to the post unless `tell.sealKey`
 * says the post already holds it — the owner after setup, and a member who
 * joined before the seal on their first verb after it. Answers null, or the
 * reason the post gave; a failure is tried again on the next verb.
 */
const publishSealKey = async (api, keys) => {
  if (readConfig().tell?.sealKey === keys.sealing.publicKey) return null
  const answer = await tellFetch(api, keys, 'POST', '/seal-key', { sealKey: keys.sealing.publicKey })
  if (answer.status !== 200) return `${answer.status}: ${answer.json?.message ?? 'no reason given'}`
  writeTellConfig({ sealKey: keys.sealing.publicKey })
  return null
}

/**
 * A sealed letter is `{ body, key, sig }` once opened: `body` the JSON of
 * `{ text }` or `{ env, source, count }`, `key` the sender's signing key, and
 * `sig` that key's signature over the body and the RECIPIENT's signing key.
 * The post stamps `from` and could seal anything to a public key, so the
 * signature is what says who wrote it (IDEAS/pony-express.md 4.1); naming the
 * recipient means a letter re-sealed to a third member does not verify there.
 */
const LETTER = 'frontierjs/tell letter v1'
const letterMessage = (toKey, body) => `${LETTER}\n${toKey}\n${body}`

const sealLetter = async (keys, recipient, payload) => {
  const body = JSON.stringify(payload)
  const sig = await signMessage({ privateKey: keys.privateKey, message: letterMessage(recipient.publicKey, body) })
  return seal(recipient.sealKey, JSON.stringify({ body, key: keys.publicKey, sig }))
}

/**
 * `{ inside, key }` for a letter that opens and verifies, `{ forged: true }`
 * for one that opens unsigned or whose signature fails — an unsigned sealed
 * letter is what a host would write — and null for one this machine cannot
 * open.
 */
const openLetter = async (keys, sealed) => {
  const bytes = keys.sealing?.privateKey ? await openSealed(keys.sealing.privateKey, sealed) : null
  if (!bytes) return null
  let opened
  try { opened = JSON.parse(new TextDecoder().decode(bytes)) } catch { return null }
  if (typeof opened?.body !== 'string') return { forged: true }
  const signed = await verifyMessage({ publicKey: opened.key, signature: opened.sig, message: letterMessage(keys.publicKey, opened.body) })
  if (!signed) return { forged: true }
  try { return { inside: JSON.parse(opened.body), key: opened.key } } catch { return null }
}

/** The nick a run speaks as: --nick, else `tell.nick`, else this machine's user name. Throws on one the post would refuse. */
const tellNick = (flagNick, saved) => {
  const nick = String(flagNick || saved.nick || userInfo().username).trim().toLowerCase()
  if (!NICK.test(nick)) throw new Error(`'${nick}' is no nick — a nick is 2 to 16 of a-z, 0-9, - and _. Name one with --nick.`)
  return nick
}

/**
 * The post this machine is a member of — `tell.api` and the key already on
 * disk — for every verb after `setup` and `join`. Never makes a key: a key
 * made here would be nobody at the post.
 */
const tellMember = async () => {
  const saved = readConfig().tell ?? {}
  if (!saved.api) throw new Error(`No post is set up here — tell.api is absent from ${CONFIG_FILE}. \`fli tell:join <code>\` walks in with an invite, or \`fli tell:setup\` stands up your own.`)
  if (!existsSync(KEY_FILE)) throw new Error(`${KEY_FILE} is missing, and the key is the member — put it back, or join again with a new invite.`)
  const keys = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
  if (!keys?.publicKey || !keys?.privateKey) throw new Error(`${KEY_FILE} holds no key pair.`)
  return { api: saved.api, nick: saved.nick, keys: await withSealing(keys) }
}

</script>

The commands that speak to the post (`IDEAS/pony-express.md`):

- `tell:setup` — the owner's one run: a key, the Worker deployed to their Cloudflare account, the origin saved.
- `tell:invite` — any member mints a one-use code, `<origin>#<code>`, good for a day.
- `tell:join <code>` — a new machine walks in with it: a key made, the code spent, the origin saved.
- `tell:send <nick> <words>`, alias `tell` — a letter left at the post for a member, signed, and sealed to them once they have a sealing key. `--env KEY...` sends env values instead, and only sealed.
- `tell:inbox`, alias `inbox` — the letters waiting, oldest first, opened; reading deletes them. `-f` stays open and prints each as it arrives.

What a machine keeps:

- `~/.fli/tell/key.json` — this machine's keys, 0600: the signing pair, which is the member, and `sealing`, the pair its letters are sealed to.
- `~/.fli/tell/wrangler.jsonc` — the owner's deploy config; wrangler's state sits beside it.
- `~/.fli/config.json`, key `tell` — `api`, the Worker's origin, `nick`, and `sealKey`, the sealing key the post is known to hold.
- `~/.fli/tell/peers.json` — every correspondent met, pinned by signing key with the nick and sealing key seen then. A later answer that disagrees is refused, naming both fingerprints.
- `~/.fli/tell/waiting.json` — who has letters waiting, as the last check found it; every `fli` command prints one line from it while any wait, and checks again in the background once it is a minute old.
