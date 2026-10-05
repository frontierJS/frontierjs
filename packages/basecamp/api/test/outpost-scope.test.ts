/**
 * outpost-scope.test.ts — what a signed machine may reach once the signature
 * is a credential instead of a hook (`FJS-1715`).
 *
 * The signature is checked at the transport and a good one becomes a principal
 * (`authMethod: 'outpost'`) that every service method can see, so the grade on
 * that principal is the whole of what keeps a check-in from calling `drain`.
 * The HTTP half — a signed request is accepted, a forged one is not — is
 * `services.test.ts` § an outpost endpoint takes a signature or nothing.
 */

import { test, expect, describe } from 'bun:test'
import { Forbidden, Unauthorized } from '@frontierjs/junction'
import { outpostScope } from '../src/core/hooks.ts'

const machine = (id: string) => ({ userId: `outpost:${id}`, userType: 'service', authMethod: 'outpost' })

function call(service: string, method: string, user: unknown, extra: Record<string, unknown> = {}) {
  return outpostScope()({ service, method, auth: { user }, ...extra } as never)
}

describe('the grade on a machine principal', () => {
  test('its own check-in passes', () => {
    expect(() => call('servers', 'heartbeat', machine('srv_1'), { id: 'srv_1' })).not.toThrow()
    expect(() => call('volumes', 'report', machine('srv_1'), { data: { server_id: 'srv_1' } })).not.toThrow()
    expect(() => call('cleanup', 'report', machine('srv_1'), { data: { server_id: 'srv_1' } })).not.toThrow()
  })

  test('another machine\'s check-in is refused', () => {
    expect(() => call('servers', 'heartbeat', machine('srv_1'), { id: 'srv_2' })).toThrow(Unauthorized)
    expect(() => call('volumes', 'report', machine('srv_1'), { data: { server_id: 'srv_2' } })).toThrow(Unauthorized)
  })

  test('any other method is refused, however good the signature was', () => {
    expect(() => call('servers', 'drain', machine('srv_1'), { id: 'srv_1' })).toThrow(Forbidden)
    expect(() => call('servers', 'find', machine('srv_1'))).toThrow(Forbidden)
    expect(() => call('secrets', 'find', machine('srv_1'))).toThrow(Forbidden)
  })

  test('an outpost endpoint with no machine behind it is refused', () => {
    expect(() => call('servers', 'heartbeat', null, { id: 'srv_1' })).toThrow(Unauthorized)
    expect(() => call('servers', 'heartbeat', { userId: 'u1', authMethod: 'session' }, { id: 'srv_1' })).toThrow(Unauthorized)
  })

  test('a person calling an ordinary method is not this hook\'s business', () => {
    expect(() => call('servers', 'drain', { userId: 'u1', authMethod: 'session' }, { id: 'srv_1' })).not.toThrow()
    expect(() => call('apps', 'find', null)).not.toThrow()
  })
})
