import { test, expect } from 'bun:test'
import { channels } from '../index.ts'
import type { ChannelClaimsFn } from '../index.ts'

// FJS-2535: an app writes its claims resolver in its own module, so the type
// must be importable from the package root.
const socketClaims: ChannelClaimsFn = (channelName) =>
  channelName.startsWith('workspace:') ? { workspace: channelName.slice(10) } : null

test('ChannelClaimsFn is exported and channels(undefined, { claims }) accepts it', () => {
  expect(channels(undefined, { claims: socketClaims })).toBeDefined()
})
