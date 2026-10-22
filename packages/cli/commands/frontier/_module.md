---
namespace: frontier
description: The Frontier network — one nick and one chain of machines for every fli surface, staked with an invite
---

<script>
const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
const { dirname, join, resolve } = await import('node:path')
const { userInfo } = await import('node:os')
const { generateSigningKeys, signMessage, verifyMessage } = await import('@frontierjs/toolbelt/signature')
const { generateSealingKeys, seal, open: openSealed } = await import('@frontierjs/toolbelt/seal')
const { FRONTIER_DIR, KEY_FILE, CONFIG_FILE, PEERS_FILE, CHAIN_FILE, readConfig, readPeers, tellSign, tellFetch, writeWaiting, pinPeer, fingerprint, rootPrint, safetyWords } =
  await import(new URL('file://' + global.fliRoot + '/core/tell.js'))
const { readChain, rootLink, linkHash, extendsSeen, boxClaim } = await import(new URL('file://' + global.fliRoot + '/core/frontier-chain.js'))
const { plural } = await import(new URL('file://' + global.fliRoot + '/core/text.js'))
const { NICK, writeMemberConfig, machineKeys, writeKeys, completeKeys, ownChain, ownRoot, writeOwnChain, syncChain, publishOwn, meetMember, pickNick, currentMember } =
  await import(new URL('file://' + global.fliRoot + '/core/frontier-member.js'))
</script>

Who a member of the Frontier network is: one nick and one chain of machines,
staked with an invite at the post (`IDEAS/frontier-network.md`). Mail reads it
as `tell:` (`commands/tell/`).

- `frontier:invite` — any member mints a one-use code, `<origin>#<code>`, good for a day.
- `frontier:stake <nick> <code>` — a new machine walks in with it: a key made, the nick taken, the code spent, the origin saved.
- `frontier:link <origin>` on a new machine, `frontier:link <eight words>` on a linked one — the new machine signed into this member, with its sealing key.
- `frontier:who [nick]` — a member's root as eight words, their chain pinned if new, to read aloud and compare away from the post; this member's own with no nick, and its machines.
- `frontier:revoke <machine>` — a lost or stolen machine taken out of this member, the sealing key rotated.
- `frontier:paper` on a linked machine, `frontier:paper <origin>` on a new one — a key printed as sixteen words, one more machine in this member, and how a new machine walks back in with it.

What a machine keeps:

- `~/.fli/frontier/key.json` — this machine's keys, 0600: the signing pair, which is this machine in the member's chain; `sealing`, the member's pair its letters are sealed to, and `retired`, the ones a revoke rotated out; and `box`, this machine's own pair a rotated sealing key is sealed to. On the first machine the chain's root link is made from it.
- `~/.fli/frontier/chain.json` — this member's chain as this machine last saw it, once a machine has been linked; absent, the chain is the root alone.
- `~/.fli/config.json`, key `frontier` — `api`, the Worker's origin, `nick`, `root`, the member's chain root once the post holds the chain, and `box`, this machine's box key once the post holds its claim.
- `~/.fli/frontier/peers.json` — every correspondent met, pinned by chain root with the nick, length, head, machines and sealing key last seen. Another root under the nick, or a chain shorter than the pin or forked from it, is refused.
