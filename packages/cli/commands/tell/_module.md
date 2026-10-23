---
namespace: tell
description: Letters between members of the Frontier network, left at the project's post
---

<script>
const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
const { dirname, join, resolve } = await import('node:path')
const { userInfo } = await import('node:os')
const { generateSigningKeys, signMessage, verifyMessage } = await import('@frontierjs/toolbelt/signature')
const { generateSealingKeys, seal, open: openSealed } = await import('@frontierjs/toolbelt/seal')
const { FRONTIER_DIR, KEY_FILE, CONFIG_FILE, PEERS_FILE, CHAIN_FILE, readConfig, readPeers, tellSign, tellFetch, writeWaiting, pinPeer, fingerprint, rootPrint, safetyWords, postOrigin } =
  await import(new URL('file://' + global.fliRoot + '/core/tell.js'))
const { readChain, rootLink, linkHash, extendsSeen, boxClaim } = await import('@frontierjs/toolbelt/frontier')
const { plural } = await import(new URL('file://' + global.fliRoot + '/core/text.js'))
const { NICK, writeMemberConfig, machineKeys, writeKeys, completeKeys, ownChain, ownRoot, writeOwnChain, syncChain, publishOwn, meetMember, pickNick, currentMember } =
  await import(new URL('file://' + global.fliRoot + '/core/frontier-member.js'))

/**
 * A sealed letter is `{ body, key, seq, head, sig }` once opened: `body` the
 * JSON of `{ text }` or `{ env, source, count }`, `key` the signing key of
 * the sender's machine, `seq` and `head` the sender's chain as that machine
 * held it, and `sig` that key's signature over all of it and the RECIPIENT's
 * root. The post stamps `from` and could seal anything to a public key, so
 * the signature is what says who wrote it (FJS-D1393), and
 * the reader checks `key` is a machine in the sender's chain; naming the
 * recipient means a letter re-sealed to a third member does not verify there.
 * The head is how a reader learns of a link the post hides from it — a
 * revoke most of all (4.6, FJS-D1421).
 */
const LETTER = 'frontierjs/tell letter v3'
const letterMessage = (toRoot, seq, head, body) => `${LETTER}\n${toRoot}\n${seq}\n${head}\n${body}`

/** `from` is the sender's own chain, `{ seq, head }`. */
const sealLetter = async (keys, from, recipient, payload) => {
  const body = JSON.stringify(payload)
  const sig = await signMessage({ privateKey: keys.privateKey, message: letterMessage(recipient.root, from.seq, from.head, body) })
  return seal(recipient.sealKey, JSON.stringify({ body, key: keys.publicKey, seq: from.seq, head: from.head, sig }))
}

/**
 * `{ inside, key, seq, head }` for a letter that opens and verifies,
 * `{ forged: true }` for one that opens unsigned or whose signature fails — an
 * unsigned sealed letter is what a host would write — and null for one this
 * machine cannot open with its sealing key or any it retired.
 */
const openLetter = async (keys, sealed) => {
  let bytes = null
  for (const pair of [keys.sealing, ...(keys.retired ?? [])]) {
    bytes = pair?.privateKey ? await openSealed(pair.privateKey, sealed) : null
    if (bytes) break
  }
  if (!bytes) return null
  let opened
  try { opened = JSON.parse(new TextDecoder().decode(bytes)) } catch { return null }
  if (typeof opened?.body !== 'string' || !Number.isSafeInteger(opened.seq) || typeof opened.head !== 'string') return { forged: true }
  const signed = await verifyMessage({ publicKey: opened.key, signature: opened.sig, message: letterMessage(await ownRoot(keys), opened.seq, opened.head, opened.body) })
  if (!signed) return { forged: true }
  try { return { inside: JSON.parse(opened.body), key: opened.key, seq: opened.seq, head: opened.head } } catch { return null }
}
</script>

Mail between members of the Frontier network (`FJS-D1392`). Who a
member is — the key, the chain, the nick — is `frontier:` (`commands/frontier/`,
`core/frontier-member.js`); these verbs only read it.

- `tell:send <nick> <words>`, alias `tell` — a letter left at the post for a member, signed, and sealed to them once they have a sealing key. `--env KEY...` sends env values instead, and only sealed.
- `tell:inbox`, alias `inbox` — the letters waiting, oldest first, opened; reading deletes them. `-f` stays open and prints each as it arrives.

What a machine keeps for mail, beside the member's files `commands/frontier/_module.md` lists:

- `~/.fli/frontier/waiting.json` — who has letters waiting, as the last check found it; every `fli` command prints one line from it while any wait, and checks again in the background once it is a minute old.
