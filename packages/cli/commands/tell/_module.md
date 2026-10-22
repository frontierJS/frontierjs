---
namespace: tell
description: Letters between fli users — one Cloudflare Worker, a key per machine, an invite to join
---

<script>
const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
const { dirname, join, resolve } = await import('node:path')
const { userInfo } = await import('node:os')
const { generateSigningKeys } = await import('@frontierjs/toolbelt/signature')
const { TELL_DIR, KEY_FILE, CONFIG_FILE, readConfig, tellSign, tellFetch, writeWaiting } =
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
 * This machine's key pair, `machineKeys`' shape in Haven's sign-in.js, made
 * and written 0600 on the first call. The key IS the member: lose it and
 * this machine is nobody until it joins again.
 */
const tellKeys = async () => {
  if (existsSync(KEY_FILE)) {
    const keys = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
    if (keys?.publicKey && keys?.privateKey) return { keys, made: false }
    throw new Error(`${KEY_FILE} holds no key pair. Move it aside and a new one is made, which is a new member.`)
  }
  const keys = await generateSigningKeys()
  mkdirSync(TELL_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(KEY_FILE, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
  return { keys, made: true }
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
const tellMember = () => {
  const saved = readConfig().tell ?? {}
  if (!saved.api) throw new Error(`No post is set up here — tell.api is absent from ${CONFIG_FILE}. \`fli tell:join <code>\` walks in with an invite, or \`fli tell:setup\` stands up your own.`)
  if (!existsSync(KEY_FILE)) throw new Error(`${KEY_FILE} is missing, and the key is the member — put it back, or join again with a new invite.`)
  const keys = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
  if (!keys?.publicKey || !keys?.privateKey) throw new Error(`${KEY_FILE} holds no key pair.`)
  return { api: saved.api, nick: saved.nick, keys }
}

</script>

The commands that speak to the post (`IDEAS/pony-express.md`):

- `tell:setup` — the owner's one run: a key, the Worker deployed to their Cloudflare account, the origin saved.
- `tell:invite` — any member mints a one-use code, `<origin>#<code>`, good for a day.
- `tell:join <code>` — a new machine walks in with it: a key made, the code spent, the origin saved.
- `tell:send <nick> <words>`, alias `tell` — a letter left at the post for a member.
- `tell:inbox`, alias `inbox` — the letters waiting, oldest first; reading deletes them. `-f` stays open and prints each as it arrives.

What a machine keeps:

- `~/.fli/tell/key.json` — this machine's key pair, 0600. It is the member.
- `~/.fli/tell/wrangler.jsonc` — the owner's deploy config; wrangler's state sits beside it.
- `~/.fli/config.json`, key `tell` — `api`, the Worker's origin, and `nick`.
- `~/.fli/tell/waiting.json` — who has letters waiting, as the last check found it; every `fli` command prints one line from it while any wait, and checks again in the background once it is a minute old.
