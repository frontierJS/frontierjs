// api/test/acme.test.ts
// The ACME client, graded against a real CA: Pebble, Let's Encrypt's own test
// server, in docker. `PEBBLE_VA_ALWAYS_VALID=1` makes it skip the DNS lookup, so
// the whole protocol runs -- directory, nonce, account, order, challenge,
// finalize, download -- with no resolver; what it cannot grade is that the TXT
// record is what the CA would have found, so the callbacks are graded here.
//
// Pebble's defaults reject 5% of good nonces and reuse an authorization half
// the time, which is the point: the client has to survive both, and a run that
// passes by luck would pass again.
//
// Pebble's directory is served with a self-signed certificate. The injected
// fetch below trusts it, in this file only.
//
// The CSR is also checked alone with openssl, so a DER mistake is reported in
// openssl's words and not as an opaque `malformed` from the CA.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { issue, AcmeError } from '../src/providers/acme/index.ts'
import { buildCsr, toPem }  from '../src/providers/acme/csr.ts'

const IMAGE     = 'ghcr.io/letsencrypt/pebble:2.9.0'
const CONTAINER = `acme-test-pebble-${process.pid}`

const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' })

const hasDocker = (() => {
  try { return docker('info', '--format', '{{.ServerVersion}}').status === 0 } catch { return false }
})()

let directoryUrl = ''
let calls: { op: 'set' | 'clear', name: string, value: string }[] = []

const trusting: typeof fetch = ((url: any, init: any) =>
  fetch(url, { ...init, tls: { rejectUnauthorized: false } })) as typeof fetch

const dns = {
  async set(name: string, value: string)   { calls.push({ op: 'set', name, value }) },
  async clear(name: string, value: string) { calls.push({ op: 'clear', name, value }) },
}

describe('csr', () => {
  test('openssl verifies the request and reads its names', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
    const pem  = toPem('CERTIFICATE REQUEST', await buildCsr(['*.example.test', 'example.test'], keys))

    const verify = spawnSync('openssl', ['req', '-verify', '-noout'], { input: pem, encoding: 'utf8' })
    expect(verify.stderr).toContain('verify OK')
    expect(verify.status).toBe(0)

    const text = spawnSync('openssl', ['req', '-noout', '-text'], { input: pem, encoding: 'utf8' }).stdout
    expect(text).toContain('DNS:*.example.test, DNS:example.test')
    expect(text).toContain('CN = *.example.test')
  })
})

describe.skipIf(!hasDocker)('issue against Pebble', () => {
  beforeAll(() => {
    const run = docker('run', '-d', '--name', CONTAINER,
      '-e', 'PEBBLE_VA_ALWAYS_VALID=1', '-e', 'PEBBLE_VA_NOSLEEP=1',
      '-p', '127.0.0.1:0:14000', IMAGE)
    if (run.status !== 0) throw new Error(`docker run: ${run.stderr}`)
    const port = docker('port', CONTAINER, '14000/tcp').stdout.trim().split(':').pop()
    directoryUrl = `https://127.0.0.1:${port}/dir`
  }, 120_000)

  afterAll(() => { docker('rm', '-f', CONTAINER) })

  // Pebble listens a moment after the container starts.
  async function ready() {
    for (let i = 0; i < 50; i++) {
      try { if ((await trusting(directoryUrl)).ok) return } catch {}
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error(`Pebble never answered at ${directoryUrl}`)
  }

  test('issues a wildcard by DNS-01 and reuses the account', async () => {
    await ready()

    const accountStatuses: number[] = []
    const watching: typeof fetch = (async (url: any, init: any) => {
      const res = await trusting(url, init)
      // A nonce Pebble rejects on purpose answers 400 first; only the retry that took counts.
      if (String(url).endsWith('/sign-me-up') && res.ok) accountStatuses.push(res.status)
      return res
    }) as typeof fetch

    calls = []
    const first = await issue({ directoryUrl, names: ['*.example.test'], dns, fetch: watching })

    const x509 = new X509Certificate(first.cert)
    expect(x509.subjectAltName).toContain('DNS:*.example.test')
    expect(x509.checkPrivateKey(createPrivateKey(first.key))).toBe(true)
    expect(first.key).toStartWith('-----BEGIN PRIVATE KEY-----')
    expect(new Date(first.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(first.accountKey.d).toBeString()

    const sets   = calls.filter(c => c.op === 'set')
    const clears = calls.filter(c => c.op === 'clear')
    expect(sets).toHaveLength(1)
    expect(sets[0].name).toBe('_acme-challenge.example.test')
    expect(sets[0].value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(clears).toEqual([{ ...sets[0], op: 'clear' }])

    // Same key, second order: Pebble answers 200 for an account it knows and
    // 201 for one it just made.
    const second = await issue({ directoryUrl, names: ['*.example.test'], dns, fetch: watching, accountKey: first.accountKey })
    expect(second.accountKey).toEqual(first.accountKey)
    expect(accountStatuses).toEqual([201, 200])
    expect(new X509Certificate(second.cert).subjectAltName).toContain('DNS:*.example.test')
  }, 60_000)

  test('a wildcard and its apex share one TXT name with two values', async () => {
    await ready()
    calls = []
    const got = await issue({ directoryUrl, names: ['*.example.test', 'example.test'], dns, fetch: trusting })

    const sets = calls.filter(c => c.op === 'set')
    // Authorization reuse can satisfy one of the two without a challenge.
    expect(sets.length).toBeGreaterThanOrEqual(1)
    for (const s of sets) expect(s.name).toBe('_acme-challenge.example.test')
    expect(calls.filter(c => c.op === 'clear')).toHaveLength(sets.length)
    expect(new X509Certificate(got.cert).subjectAltName).toContain('DNS:example.test')
  }, 60_000)

  test('records are cleared when the order fails', async () => {
    await ready()
    calls = []
    const failing = { ...dns, async set(name: string, value: string) { await dns.set(name, value); throw new Error('zone write refused') } }
    await expect(issue({ directoryUrl, names: ['*.cleared.test'], dns: failing, fetch: trusting }))
      .rejects.toThrow('zone write refused')
    // A `set` that threw wrote nothing the caller must undo; the finally clears only what landed.
    expect(calls.filter(c => c.op === 'clear')).toHaveLength(0)

    calls = []
    const refused = { ...dns, async waitForDns() { throw new Error('resolver gave up') } }
    await expect(issue({ directoryUrl, names: ['*.cleared.test'], dns, waitForDns: refused.waitForDns, fetch: trusting }))
      .rejects.toThrow('resolver gave up')
    const sets = calls.filter(c => c.op === 'set')
    expect(calls.filter(c => c.op === 'clear')).toHaveLength(sets.length)
  }, 60_000)

  test('a problem document becomes an AcmeError with its type', async () => {
    await ready()
    const err = await issue({ directoryUrl, names: ['not a name'], dns, fetch: trusting }).catch(e => e)
    expect(err).toBeInstanceOf(AcmeError)
    expect(err.type).toStartWith('urn:ietf:params:acme:error:')
    expect(err.detail).toBeString()
  }, 60_000)
})
