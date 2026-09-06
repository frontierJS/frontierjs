// ─── image-identity.test.js — which bytes ran, and how far that answer goes ──
//
// 2.3f, first step. The pipeline builds on the target and names the result
// `${appId}:${shortSha}`, so two servers at one commit hold two images with the
// same name and different bytes. A digest is what fixes that — but Docker has
// two digests with very different reach, and reporting the weaker one as though
// it were the stronger brings the problem back wearing a fix.

import { describe, test, expect } from 'bun:test'
import { imageIdentity, describeIdentity, addressOf, parseImageList,
         movesBytes, short } from '../core/image.js'

const A = 'sha256:' + 'a'.repeat(64)
const B = 'sha256:' + 'b'.repeat(64)

describe('which digest, and what it covers', () => {
  // Present only once an image has been pushed or pulled, and the only one that
  // means the same thing on a second machine.
  test('a registry digest wins, and says it travels', () => {
    const id = imageIdentity([{ Id: A, RepoDigests: [`shop@${B}`] }])
    expect(id).toEqual({ digest: B, ref: `shop@${B}`, scope: 'registry' })
    expect(describeIdentity(id)).toContain('anywhere')
  })

  // The build-on-target case, which is every deploy this pipeline does today.
  test('with no registry it is the image id, and it says THIS HOST', () => {
    const id = imageIdentity([{ Id: A, RepoDigests: [] }])
    expect(id).toEqual({ digest: A, ref: A, scope: 'host' })
    expect(describeIdentity(id)).toContain('this host')
    expect(describeIdentity(id)).not.toContain('anywhere')
  })

  // A plausible wrong digest is worse than none: the entire point is that two
  // things which look alike are not.
  test.each([
    ['nothing',        []],
    ['no id',          [{ RepoDigests: [] }]],
    ['a junk row',     ['not an object']],
    ['a malformed repo digest', [{ RepoDigests: ['shop-without-an-at'] }]],
  ])('%s answers null rather than guessing', (_label, input) => {
    const id = imageIdentity(input)
    expect(id === null || id.scope === 'host').toBe(true)
    if (id === null) expect(describeIdentity(id)).toContain('unknown')
  })

  test('the array and one element of it read the same', () => {
    expect(imageIdentity([{ Id: A }])).toEqual(imageIdentity({ Id: A }))
  })
})

describe('addressing', () => {
  test('a registry digest is addressed against its repository', () => {
    expect(addressOf(imageIdentity([{ RepoDigests: [`shop@${B}`] }]), 'shop:v1').address)
      .toBe(`shop@${B}`)
  })

  test('a local image is addressed by its id', () => {
    expect(addressOf(imageIdentity([{ Id: A }]), 'shop:v1').address).toBe(A)
  })

  // A caller that fell back is running a NAME, and that is the thing this
  // module exists to stop being invisible.
  test('with no identity it falls back to the tag and SAYS so', () => {
    expect(addressOf(null, 'shop:v1')).toEqual({ address: 'shop:v1', addressed: 'tag' })
  })
})

describe('the rollback list', () => {
  const LIST = [
    `shop:abc1234 ${'a'.repeat(12)} 2026-08-26 09:00:00 +0000 UTC`,
    `shop:def5678 ${'b'.repeat(12)} 2026-08-25 09:00:00 +0000 UTC`,
  ].join('\n')

  // The last column has spaces in it, so a naive split takes the date apart and
  // leaves the id looking fine.
  test('the date does not eat the id', () => {
    const rows = parseImageList(LIST)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ tag: 'shop:abc1234', id: 'a'.repeat(12), created: '2026-08-26 09:00:00 +0000 UTC' })
  })

  test('blank and partial lines are dropped', () => {
    expect(parseImageList('\n\n  \nshop:x deadbeef1234 now\nrubbish\n')).toHaveLength(1)
  })

  // The catch this exists for: a rebuild that produced identical layers, or a
  // moved tag, means rolling back by NAME restores the bytes you were leaving.
  test('two tags naming one image is not a rollback', () => {
    const [a, b] = parseImageList([
      `shop:new ${'a'.repeat(12)} now`,
      `shop:old ${'a'.repeat(12)} then`,
    ].join('\n'))
    expect(movesBytes(a, b)).toBe(false)
  })

  test('different bytes is a rollback', () => {
    const [a, b] = parseImageList(LIST)
    expect(movesBytes(a, b)).toBe(true)
  })

  // Not knowing must not block an operator mid-incident.
  test('an unreadable row does not block the rollback', () => {
    expect(movesBytes({ tag: 'x' }, { tag: 'y' })).toBe(true)
  })
})

describe('short', () => {
  test('is Docker’s own width, and normalizes the prefix', () => {
    expect(short(A)).toBe('sha256:' + 'a'.repeat(12))
    expect(short('a'.repeat(64))).toBe('sha256:' + 'a'.repeat(12))
    expect(short(undefined)).toBe('')
  })
})
