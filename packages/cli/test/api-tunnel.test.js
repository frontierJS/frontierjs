/*
 * test/api-tunnel.test.js
 *
 * `fli dev --api`: what a target names, and that the surfaces wait for the API
 * to answer through the forward — a tunnel that never connects must refuse,
 * not start a web surface whose every request fails.
 */

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { resolveApiTarget, sshArgs, openTunnel } from '../core/api-tunnel.js'

const deploy = { server: 'box', path: '/apps/a', api: { port: 3005, health: '/api/health' }, stage: { server: 'stage-box' } }

describe('resolveApiTarget', () => {
  test('a deploy target resolves off the deploy block', () => {
    expect(resolveApiTarget('production', deploy)).toEqual({ ok: true, host: 'box', port: 3005, health: '/api/health', target: 'production' })
    expect(resolveApiTarget('stage', deploy)).toMatchObject({ host: 'stage-box', target: 'stage' })
    expect(resolveApiTarget('prod', deploy).target).toBe('production')
  })

  test('the api side wins over the shared server', () => {
    const split = { ...deploy, api: { ...deploy.api, server: 'api-box', user: 'ops' } }
    expect(resolveApiTarget('production', split).host).toBe('ops@api-box')
  })

  test('anything else is an ssh destination, with an optional port', () => {
    expect(resolveApiTarget('thod', deploy)).toMatchObject({ host: 'thod', port: 3005, target: null })
    expect(resolveApiTarget('me@10.0.0.2:3001', null)).toMatchObject({ host: 'me@10.0.0.2', port: 3001, health: '/health' })
  })

  test('refuses what it cannot resolve', () => {
    expect(resolveApiTarget(true, deploy).ok).toBe(false)
    expect(resolveApiTarget('true', deploy).ok).toBe(false)
    expect(resolveApiTarget('', deploy).ok).toBe(false)
    expect(resolveApiTarget('production', null).ok).toBe(false)
    expect(resolveApiTarget('box; rm -rf /', deploy).ok).toBe(false)
  })
})

test('sshArgs forwards loopback to loopback', () => {
  expect(sshArgs({ host: 'box', port: 3000, localPort: 8100 })).toContain('127.0.0.1:8100:127.0.0.1:3000')
})

const fakeSsh = () => {
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => child.emit('close', null, 'SIGTERM')
  return child
}

describe('openTunnel', () => {
  test('resolves once the health path answers, with its status', async () => {
    let calls = 0
    const fetchImpl = async () => { if (++calls < 3) throw new Error('ECONNREFUSED'); return { status: 404 } }
    const { status } = await openTunnel({ host: 'box', port: 3000, localPort: 8100, health: '/h', spawnImpl: fakeSsh, fetchImpl })
    expect(status).toBe(404)
    expect(calls).toBe(3)
  })

  test('rejects with what ssh said when it exits first', async () => {
    const spawnImpl = () => {
      const child = fakeSsh()
      setTimeout(() => { child.stderr.emit('data', 'Permission denied (publickey).\n'); child.emit('close', 255, null) }, 10)
      return child
    }
    const fetchImpl = async () => { throw new Error('ECONNREFUSED') }
    await expect(openTunnel({ host: 'box', port: 3000, localPort: 8100, health: '/h', spawnImpl, fetchImpl }))
      .rejects.toThrow('Permission denied')
  })
})
