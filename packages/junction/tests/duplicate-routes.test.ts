// tests/duplicate-routes.test.ts
//
// FJS-225. A second registration of one path used to be accepted in silence,
// and WHICH copy survived depended on something the caller cannot see:
//
//   fixed path   → build() writes it into a map, so the LAST one wins
//   dynamic path → build() pushes onto a list lookup() scans in order, so the
//                  FIRST one wins and the later handler never runs
//
// Same mistake, opposite outcome, decided by whether the path has a parameter.
// It surfaced as doubled CORS — `cors()` registers `OPTIONS /*`, and `fli new`'s
// own scaffold called it by hand beside the config entry that installs it at
// startup, so every scaffolded app ran doubled CORS from its first boot. The
// headers came out right, which is why nobody looked.
//
// These assert the refusal AND its two blast radii: it names the offender, and
// it does not fire on paths that merely look similar.

import { describe, it, expect } from 'bun:test'
import { Router } from '../src/transport/router.ts'
import { createTestApp } from '../src/testing/index.ts'
import { cors } from '../src/transport/middleware.ts'

const noop = async () => new Response('ok')

describe('a duplicate route is refused, naming it', () => {

  it('refuses a second FIXED registration — where the last one used to win', () => {
    const r = new Router()
    r.get('/health', noop)
    expect(() => r.get('/health', noop)).toThrow(/GET \/health is already registered/)
  })

  it('refuses a second DYNAMIC registration — where the second used to be dead weight', () => {
    const r = new Router()
    r.options('/*', noop)
    expect(() => r.options('/*', noop)).toThrow(/OPTIONS \/\* is already registered/)
  })

  it('a differently-NAMED param is the same route, and says which path claimed it', () => {
    // `/leads/{id}` and `/leads/{leadId}` accept exactly the same requests — the
    // name is read by the handler and by nothing that matches.
    const r = new Router()
    r.get('/leads/{id}', noop)
    expect(() => r.get('/leads/{leadId}', noop)).toThrow(/already registered \(as \/leads\/\{id\}\)/)
  })

  it('the same path under a different METHOD is not a duplicate', () => {
    const r = new Router()
    r.get('/leads/{id}', noop)
    expect(() => r.patch('/leads/{id}', noop)).not.toThrow()
    expect(() => r.delete('/leads/{id}', noop)).not.toThrow()
  })

  it('a static segment that spells a placeholder is not a duplicate', () => {
    // The shape key joins on a space so a literal segment cannot collide with
    // the '{}' or '*' placeholders it uses.
    const r = new Router()
    r.get('/a/{id}', noop)
    expect(() => r.get('/a/{}', noop)).not.toThrow()
    expect(() => r.get('/a/*',  noop)).not.toThrow()
  })

  it('different arities do not collide', () => {
    const r = new Router()
    r.get('/a', noop)
    expect(() => r.get('/a/{id}', noop)).not.toThrow()
    expect(() => r.get('/a/{id}/b', noop)).not.toThrow()
  })
})

describe('the case that surfaced it', () => {

  it('configuring CORS twice now fails at startup instead of shipping', async () => {
    // The scaffold had `app.configure(cors({...}))` in api/src/app.ts beside
    // `middleware.cors` in config — one owner each, both installed.
    const app = await createTestApp({})
    app.configure(cors({ origins: ['*'] }))
    expect(() => app.configure(cors({ origins: ['*'] }))).toThrow(/OPTIONS \/\* is already registered/)
  })
})
