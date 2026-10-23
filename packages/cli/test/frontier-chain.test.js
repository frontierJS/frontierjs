// test/frontier-chain.test.js — the post's attackers, at the one place a member
// is checked (THREATS B17–B19). The post stores and serves every chain, so each
// case here is a chain the post could hand a client: one it forged, one cut
// short, one forked, one under a nick another root already holds. Every refusal
// sits one change away from a chain that reads, so a `readChain` that refused
// everything fails here too.
import { describe, expect, test, beforeAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateSigningKeys } from '@frontierjs/toolbelt/signature'
import { generateSealingKeys } from '@frontierjs/toolbelt/seal'

import { rootLink, nextLink, countersign, readChain, extendsSeen } from '../core/frontier-chain.js'

const machine = async () => ({ ...await generateSigningKeys(), sealing: await generateSealingKeys() })

let laptop, desk, thief, stranger
beforeAll(async () => { [laptop, desk, thief, stranger] = await Promise.all([machine(), machine(), machine(), machine()]) })

/** laptop's root, then desk linked: the member as two machines. */
const twoMachines = async () => {
  const root = await rootLink(laptop)
  const link = await countersign(desk, await nextLink(laptop, [root], 'link', desk.publicKey))
  return [root, link]
}

/** twoMachines, then laptop revokes desk and rotates the sealing key. */
const deskRevoked = async () => {
  const links = await twoMachines()
  const rotated = await generateSealingKeys()
  return [...links, await nextLink(laptop, links, 'revoke', desk.publicKey, rotated.publicKey)]
}

describe('the post forging a member', () => {
  test('a chain the member signed reads', async () => {
    const chain = await readChain(await twoMachines())
    expect(chain.refused).toBeUndefined()
    expect(chain.machines).toEqual([laptop.publicKey, desk.publicKey])
  })

  test('a link signed by a key outside the chain is refused', async () => {
    const [root] = await twoMachines()
    const forged = await countersign(stranger, await nextLink(stranger, [root], 'link', stranger.publicKey))
    expect((await readChain([root, forged])).refused).toBe("link 2 is signed by no machine of the member's")
  })

  test('a link the added machine did not countersign is refused', async () => {
    const [root] = await twoMachines()
    const unsigned = await nextLink(laptop, [root], 'link', stranger.publicKey)
    expect((await readChain([root, unsigned])).refused).toBe('link 2 is not countersigned by the machine it links')
  })

  test('a field changed after signing is refused', async () => {
    const [root, link] = await twoMachines()
    expect((await readChain([{ ...root, sealKey: stranger.sealing.publicKey }, link])).refused).toBe("link 1's signature does not verify")
  })
})

describe('a thief holding a revoked machine', () => {
  test('the revoke takes the machine out and rotates the sealing key', async () => {
    const chain = await readChain(await deskRevoked())
    expect(chain.machines).toEqual([laptop.publicKey])
    expect(chain.revoked).toEqual([{ machine: desk.publicKey, seq: 3 }])
    expect(chain.sealKey).not.toBe(laptop.sealing.publicKey)
  })

  test('a link the revoked machine signs after the revoke is refused', async () => {
    const links = await deskRevoked()
    const after = await countersign(thief, await nextLink(desk, links, 'link', thief.publicKey))
    expect((await readChain([...links, after])).refused).toBe("link 4 is signed by no machine of the member's")
  })

  test('the revoked machine is never linked again', async () => {
    const links = await deskRevoked()
    const back = await countersign(desk, await nextLink(laptop, links, 'link', desk.publicKey))
    expect((await readChain([...links, back])).refused).toMatch(/links a machine revoked from the chain/)
  })

  test('a revoke that keeps the sealing key the thief holds is refused', async () => {
    const links = await twoMachines()
    const kept = await nextLink(laptop, links, 'revoke', desk.publicKey, laptop.sealing.publicKey)
    expect((await readChain([...links, kept])).refused).toBe("link 3 does not rotate the sealing key, which the revoked machine holds")
  })

  test('a post serving the chain from before the revoke is refused by a client that saw it', async () => {
    const seen = await readChain(await deskRevoked())
    const stale = await readChain(await twoMachines())
    expect(extendsSeen(seen, stale)).toBe('it is 2 link(s) long, and 3 were seen before')
  })

  test('a fork at the seen head is refused', async () => {
    const seen = await readChain(await deskRevoked())
    const links = await twoMachines()
    const other = await countersign(thief, await nextLink(laptop, links, 'link', thief.publicKey))
    expect(extendsSeen(seen, await readChain([...links, other]))).toBe('its link 3 is not the one seen before')
  })

  test('a longer chain carrying the seen head forward is accepted', async () => {
    const links = await deskRevoked()
    const seen = await readChain(links)
    const next = await countersign(thief, await nextLink(laptop, links, 'link', thief.publicKey))
    expect(extendsSeen(seen, await readChain([...links, next]))).toBeNull()
  })
})

// tell.js takes its pin file from the HOME the process STARTED with — bun's
// homedir() ignores a HOME assigned later — so the pins are graded in a child
// spawned with a temp HOME, which refuses to pin anywhere else. Assigning HOME
// here instead writes the pins into the person's own ~/.fli/frontier/.
const PIN_SCRIPT = `
  import { generateSigningKeys } from '@frontierjs/toolbelt/signature'
  import { generateSealingKeys } from '@frontierjs/toolbelt/seal'
  import { rootLink, readChain } from './core/frontier-chain.js'
  import { pinPeer, PEERS_FILE } from './core/tell.js'
  if (!PEERS_FILE.startsWith(process.env.HOME + '/')) { console.log(JSON.stringify({ outside: PEERS_FILE })); process.exit(0) }
  const member = async () => readChain([await rootLink({ ...await generateSigningKeys(), sealing: await generateSealingKeys() })])
  const [ada, impostor, bea] = await Promise.all([member(), member(), member()])
  console.log(JSON.stringify({
    adaMet:      await pinPeer('ada', ada),
    impostor:    await pinPeer('ada', impostor),
    adaAgain:    await pinPeer('ada', ada),
    beaMet:      await pinPeer('bea', bea),
    beaRenamed:  await pinPeer('ada2', bea),
  }))
`

describe('a stranger impersonating a nick', () => {
  let pins
  beforeAll(() => {
    const HOME = mkdtempSync(join(tmpdir(), 'fjs-frontier-pins-'))
    const run = Bun.spawnSync([process.execPath, '-e', PIN_SCRIPT], { cwd: join(import.meta.dir, '..'), env: { ...process.env, HOME } })
    pins = JSON.parse(run.stdout.toString() || `{"stderr":${JSON.stringify(run.stderr.toString())}}`)
  })

  test('the pins live under the child\'s temp HOME', () => {
    expect(pins.outside).toBeUndefined()
    expect(pins.stderr).toBeUndefined()
  })

  test('a nick answering with another root is refused, and the pin is kept', () => {
    expect(pins.adaMet.met).toBeDefined()
    expect(pins.impostor.refused).toMatch(/^ada was pinned at /)
    expect(pins.adaAgain.refused).toBeUndefined()
  })

  test('a pinned root answering under another nick is refused', () => {
    expect(pins.beaMet.met).toBeDefined()
    expect(pins.beaRenamed.refused).toMatch(/was pinned as bea and now answers as ada2/)
  })
})
