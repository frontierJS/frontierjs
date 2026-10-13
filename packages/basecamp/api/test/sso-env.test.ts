// api/test/sso-env.test.ts
// Sign-in providers come from the environment (`FJS-1783`, `FJS-D670`): none
// set means Bearer and a password login, any set means cookie mode and a
// button per provider. The switch is only as good as the read behind it.

import { test, expect, describe } from 'bun:test'
import { ssoFromEnv } from '../src/core/sso-env.ts'

describe('ssoFromEnv', () => {
  test('nothing set configures nothing, so the app stays Bearer', () => {
    expect(ssoFromEnv({})).toEqual([])
    expect(ssoFromEnv({ PATH: '/bin' })).toEqual([])
  })

  test('a preset provider needs its id and secret', () => {
    const found = ssoFromEnv({ GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret' })
    expect(found).toEqual([
      { name: 'github', preset: 'github', opts: { clientId: 'gh-id', clientSecret: 'gh-secret' } },
    ])
  })

  test('oidc carries its three endpoints', () => {
    const found = ssoFromEnv({
      OIDC_CLIENT_ID: 'i', OIDC_CLIENT_SECRET: 's',
      OIDC_AUTHORIZE_URL: 'https://idp/authorize', OIDC_TOKEN_URL: 'https://idp/token', OIDC_USERINFO_URL: 'https://idp/userinfo',
    })
    expect(found.map(p => p.name)).toEqual(['oidc'])
    expect(found[0]!.opts.tokenUrl).toBe('https://idp/token')
  })

  test('a half-set provider throws naming what is missing', () => {
    expect(() => ssoFromEnv({ GOOGLE_CLIENT_ID: 'only-id' })).toThrow(/GOOGLE_CLIENT_SECRET/)
    expect(() => ssoFromEnv({ OIDC_CLIENT_ID: 'i', OIDC_CLIENT_SECRET: 's' })).toThrow(/OIDC_TOKEN_URL/)
  })
})

// ─── the switch, through a real app ─────────────────────────────────────────

import { beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { createTestEnv } from '@frontierjs/testing'
import { request } from '@frontierjs/junction'
import { GatePlugin } from '@frontierjs/litestone'
import { basecampGateLevel } from '../src/core/gate.ts'
import { buildBasecampApp } from '../src/app.ts'

async function appWith(sso: Record<string, string>) {
  const env = await createTestEnv({
    schema:        join(import.meta.dir, '..', '..', 'db', 'schema.lite'),
    migrations:    join(import.meta.dir, '..', '..', 'db', 'migrations'),
    encryptionKey: '0'.repeat(64),
    plugins:       [new GatePlugin({ getLevel: basecampGateLevel })],
    api: ({ db, path }: any) => buildBasecampApp({ db, dbPath: path, sso }),
  })
  return env
}

describe('the app', () => {
  let none: any, github: any

  beforeAll(async () => {
    none   = await appWith({})
    github = await appWith({ GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret' })
  })
  afterAll(async () => { await none?.cleanup?.(); await github?.cleanup?.() })

  test('with no provider set, /auth/oauth lists nothing and stays Bearer', async () => {
    const res = await request(none.app).get('/auth/oauth')
    expect(res.body).toEqual({ providers: [] })
  })

  test('with a provider set, /auth/oauth lists it and the flow starts at the provider', async () => {
    const list = await request(github.app).get('/auth/oauth')
    expect(list.body).toEqual({ providers: ['github'] })

    const start = await request(github.app).get('/auth/oauth/github')
    expect(start.status).toBe(302)
    expect(String(start.headers['location'])).toContain('github.com/login/oauth/authorize')
  })
})
