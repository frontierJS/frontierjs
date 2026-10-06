/*
 * audit-signature.test.js — audit 1.3, the command port's signature.
 *
 * Written against the code, not the docs. A test that FAILS here is a finding;
 * one that passes is evidence a claim held under attack. Each test names which.
 */

import { test, expect, describe, setSystemTime, afterEach } from 'bun:test'
import { signRequest, verifyRequest } from '@frontierjs/toolbelt/signature'
import { createOutpostServer }        from '../src/server.js'
import { createReporter }             from '../src/report.js'

const CONFIG = {
  serverId: 'srv-1', secret: 'fleet-secret', basecampUrl: 'http://basecamp.test',
  port: 7180, version: '0.1.0', publicUrl: 'https://outpost.test:7180',
  heartbeatMs: 30_000, reportMs: 300_000, workDir: '/tmp/outpost-audit',
  caddyAdmin: 'http://127.0.0.1:1',
}
const quiet = { warn() {}, error() {} }

afterEach(() => setSystemTime())

/** A server whose /exec records what it was asked and runs nothing. */
function server() {
  const calls = []
  const docker = { exec: async (args) => { calls.push(args); return { exit_code: 0, stdout: '', stderr: '' } } }
  return { handle: createOutpostServer(CONFIG, { docker, log: quiet }).handle, calls }
}

describe('FINDING — replay after the nonce is forgotten', () => {

  test('a request signed inside the tolerance is accepted AGAIN once its nonce ages out of the 300s memory', async () => {
    const T0 = 1_800_000_000 // receiver clock, seconds
    setSystemTime(new Date(T0 * 1000))

    const { handle, calls } = server()
    const payload = JSON.stringify({ command: 'id' })
    // The sender's clock is 300s ahead — inside the ±300s tolerance, so this
    // is a legitimate request as the verifier grades it.
    const signed = await signRequest({
      secret: CONFIG.secret, method: 'POST', path: '/exec', body: payload,
      timestamp: T0 + 300, nonce: 'audit-nonce-1',
    })
    const hit = () => handle(new Request('http://outpost.test/exec', {
      method: 'POST', headers: { 'content-type': 'application/json', ...signed }, body: payload,
    }))

    expect((await hit()).status).toBe(200)
    expect((await hit()).status).toBe(401)   // the replay is caught now…

    // …and 301s later the nonce has been swept (memory window = tolerance),
    // while the timestamp T0+300 is still only 1s from the receiver's clock.
    setSystemTime(new Date((T0 + 301) * 1000))
    const replay = await hit()
    expect(replay.status).toBe(401)          // FAILS: 200, the command runs twice
    expect(calls.length).toBe(1)
  })
})

describe('FINDING — what the outbound signature leaves uncovered', () => {

  test('x-service-method, the header junction dispatches on, is not in the canonical string', async () => {
    let sent
    const reporter = createReporter(CONFIG, {
      inspector: { volumes: async () => [], disk: async () => ({}) },
      vitals:    { read: async () => ({ cpu: 1 }) },
      fetch:     async (url, init) => { sent = { url, init }; return new Response('{}', { status: 200 }) },
      log:       quiet,
    })
    await reporter.heartbeat()

    const headers = { ...sent.init.headers, 'x-service-method': 'somethingElse' }
    const verdict = await verifyRequest({
      secret: CONFIG.secret, method: 'POST', path: new URL(sent.url).pathname, query: '',
      body: sent.init.body, headers, now: Math.floor(Date.now() / 1000),
    })
    // The header that selects the service method can be rewritten under a
    // signature that still verifies.
    expect(verdict.ok).toBe(false)           // FAILS: ok is true
  })
})

describe('FINDING — /exec timeout_s: 0 disables the bound', () => {

  test('a step with timeout_s 0 is run with no timer at all', async () => {
    const { createDocker } = await import('../src/docker.js')
    const seen = []
    const docker = createDocker({ run: async (argv, opts) => { seen.push(opts); return { exitCode: 0, stdout: '', stderr: '' } } })
    const { handle } = createOutpostServer(CONFIG, { docker, log: quiet })
    const payload = JSON.stringify({ command: 'sleep 1', timeout_s: 0 })
    const signed  = await signRequest({
      secret: CONFIG.secret, method: 'POST', path: '/exec', body: payload,
      timestamp: Math.floor(Date.now() / 1000), nonce: 'audit-timeout-0',
    })
    await handle(new Request('http://outpost.test/exec', {
      method: 'POST', headers: { 'content-type': 'application/json', ...signed }, body: payload,
    }))
    // `spawnRun` reads `timeoutMs ? setTimeout : null`: 0 means never killed.
    expect(seen[0].timeoutMs).toBeGreaterThan(0)   // FAILS: 0
  })
})

describe('HOLDS — what a page on 8181 can do to the command port (FJS-D345)', () => {

  test('the command port answers no CORS header, so a cross-origin page cannot read even /health', async () => {
    const { handle } = server()
    const res = await handle(new Request('http://outpost.test/health', {
      headers: { origin: 'http://shop.fleet.test:8181' },
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('a preflight for /exec is refused unsigned, with no CORS grant', async () => {
    const { handle, calls } = server()
    const res = await handle(new Request('http://outpost.test/exec', {
      method: 'OPTIONS',
      headers: { origin: 'http://shop.fleet.test:8181', 'access-control-request-method': 'POST' },
    }))
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(calls.length).toBe(0)
  })

  test('a "simple" cross-origin POST (text/plain, no preflight) still needs the secret', async () => {
    const { handle, calls } = server()
    const res = await handle(new Request('http://outpost.test/exec', {
      method: 'POST', headers: { origin: 'http://shop.fleet.test:8181', 'content-type': 'text/plain' },
      body: JSON.stringify({ command: 'id' }),
    }))
    expect(res.status).toBe(401)
    expect(calls.length).toBe(0)
  })

  test('a signature over the same path and body, but for another method, does not verify', async () => {
    const payload = JSON.stringify({ command: 'id' })
    const signed  = await signRequest({
      secret: CONFIG.secret, method: 'PUT', path: '/exec', body: payload,
      timestamp: Math.floor(Date.now() / 1000), nonce: 'audit-method',
    })
    const { handle } = server()
    const res = await handle(new Request('http://outpost.test/exec', {
      method: 'POST', headers: { 'content-type': 'application/json', ...signed }, body: payload,
    }))
    expect(res.status).toBe(401)
  })

  test('a signed body that arrives one byte different is refused', async () => {
    const payload = JSON.stringify({ command: 'id' })
    const signed  = await signRequest({
      secret: CONFIG.secret, method: 'POST', path: '/exec', body: payload,
      timestamp: Math.floor(Date.now() / 1000), nonce: 'audit-body',
    })
    const { handle } = server()
    const res = await handle(new Request('http://outpost.test/exec', {
      method: 'POST', headers: { 'content-type': 'application/json', ...signed },
      body: JSON.stringify({ command: 'id;rm -rf /' }),
    }))
    expect(res.status).toBe(401)
  })

  test('a timestamp 301s out is refused in either direction', async () => {
    const now = Math.floor(Date.now() / 1000)
    const { handle } = server()
    for (const ts of [now - 301, now + 301]) {
      const payload = JSON.stringify({ command: 'id' })
      const signed  = await signRequest({ secret: CONFIG.secret, method: 'POST', path: '/exec', body: payload, timestamp: ts, nonce: `audit-skew-${ts}` })
      const res = await handle(new Request('http://outpost.test/exec', {
        method: 'POST', headers: { 'content-type': 'application/json', ...signed }, body: payload,
      }))
      expect(res.status).toBe(401)
    }
  })
})
