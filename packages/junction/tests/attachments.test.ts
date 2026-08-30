// tests/attachments.test.ts
//
// An attached service is a third-party dependency the app needs and does not
// own, declared here and bound per environment. The product is the refusal, so
// what is asserted is which situations refuse and which do not — and the two
// that carry the design are:
//
//   HALF-BOUND ALWAYS REFUSES, `optional` included. That is the shape that
//   actually reaches production, because somebody binds the URL and forgets the
//   key; and it is exactly the shape a per-variable check cannot see, since
//   every individual variable it can name is either legitimately absent or
//   legitimately set.
//
//   A DEFAULTED KEY IS NOT EVIDENCE. It is satisfied whether or not anybody
//   bound the service, so counting it would make every unbound attachment with
//   one default look half-bound — which would turn the rule above into noise on
//   the first app that uses it.
//
// Every per-key question — present, non-empty, a URL, long enough — is
// `checkEnvField`'s, which `defineEnv` also calls. The tests at the bottom are
// that function's own, and they are here because it had none: it was inline in
// `defineEnv` and the whole of `env.ts` was untested.

import { describe, it, expect } from 'bun:test'
import {
  checkAttachment, checkAttachments, formatAttachmentRefusal, formatAttachmentSkips,
} from '../src/core/attachments.ts'
import type { Attachments } from '../src/core/attachments.ts'
import { checkEnvField } from '../src/core/env.ts'
import { createApp } from '../src/core/app.ts'

const n8n: Attachments = {
  n8n: {
    describe: 'workflow automation',
    env: {
      N8N_URL:     { required: true, type: 'url' },
      N8N_API_KEY: { required: true },
    },
  },
}

const bound = { N8N_URL: 'https://n8n.internal', N8N_API_KEY: 'k-123' }

describe('an attachment against an environment', () => {

  it('is bound when every declared key is satisfied', () => {
    const r = checkAttachment('n8n', n8n.n8n, bound)
    expect(r.state).toBe('bound')
    expect(r.fatal).toBe(false)
    expect(r.present).toEqual(['N8N_URL', 'N8N_API_KEY'])
  })

  it('refuses when nothing is bound and the service is required', () => {
    const r = checkAttachment('n8n', n8n.n8n, {})
    expect(r.state).toBe('unbound')
    expect(r.fatal).toBe(true)
  })

  it('forgives nothing bound when the service is optional', () => {
    const r = checkAttachment('n8n', { ...n8n.n8n, optional: true }, {})
    expect(r.state).toBe('unbound')
    expect(r.fatal).toBe(false)
  })

  // The headline. `optional` says the app can run WITHOUT the service, never
  // that it can run against half of one.
  it('refuses a half-bound service even when it is optional', () => {
    const r = checkAttachment('n8n', { ...n8n.n8n, optional: true }, { N8N_URL: 'https://n8n.internal' })
    expect(r.state).toBe('partial')
    expect(r.fatal).toBe(true)
    expect(r.present).toEqual(['N8N_URL'])
    expect(r.problems.map(p => p.key)).toContain('N8N_API_KEY')
  })

  it('refuses a half-bound required service too', () => {
    const r = checkAttachment('n8n', n8n.n8n, { N8N_API_KEY: 'k-123' })
    expect(r.state).toBe('partial')
    expect(r.fatal).toBe(true)
  })

  it('refuses a key that is set and does not satisfy its own spec', () => {
    const r = checkAttachment('n8n', n8n.n8n, { ...bound, N8N_URL: 'not a url' })
    expect(r.state).toBe('invalid')
    expect(r.fatal).toBe(true)
    expect(r.problems[0].message).toContain('expected a valid URL')
  })

  // `optional` forgives absence, never a value that cannot be used. A bad URL
  // is a mistake in every environment.
  it('refuses an unusable value even when the service is optional', () => {
    const r = checkAttachment('n8n', { ...n8n.n8n, optional: true }, { ...bound, N8N_URL: 'not a url' })
    expect(r.state).toBe('invalid')
    expect(r.fatal).toBe(true)
  })

  it('treats an empty string as absent, which is what a deploy writes for a key with no value', () => {
    const r = checkAttachment('n8n', n8n.n8n, { N8N_URL: 'https://n8n.internal', N8N_API_KEY: '' })
    expect(r.state).toBe('partial')
    expect(r.fatal).toBe(true)
  })

  it('does not report every key as a problem when nothing is bound', () => {
    // One service nobody bound is one fault, not one per variable.
    const r = checkAttachment('n8n', n8n.n8n, {})
    expect(r.problems).toEqual([])
  })
})

describe('a defaulted key is not evidence that a service is bound', () => {

  const withDefault: Attachments = {
    search: {
      env: {
        SEARCH_URL:     { required: true, type: 'url' },
        SEARCH_TIMEOUT: { type: 'number', default: 30 },
      },
    },
  }

  it('does not count toward the signals', () => {
    const r = checkAttachment('search', withDefault.search, {})
    expect(r.signals).toEqual(['SEARCH_URL'])
  })

  it('leaves an unbound service unbound rather than making it look half-bound', () => {
    const r = checkAttachment('search', withDefault.search, {})
    expect(r.state).toBe('unbound')
  })

  it('leaves a bound service bound without anybody setting it', () => {
    const r = checkAttachment('search', withDefault.search, { SEARCH_URL: 'https://s.internal' })
    expect(r.state).toBe('bound')
    expect(r.fatal).toBe(false)
  })

  it('is bound trivially when every key carries a default', () => {
    const allDefaulted = { env: { A: { default: '1' }, B: { default: '2' } } }
    const r = checkAttachment('thing', allDefaulted, {})
    expect(r.signals).toEqual([])
    expect(r.state).toBe('bound')
  })
})

describe('the report', () => {

  it('is empty for an app that declares nothing', () => {
    const rep = checkAttachments(undefined, {})
    expect(rep.results).toEqual([])
    expect(rep.fatal).toEqual([])
  })

  it('preserves declaration order', () => {
    const many: Attachments = {
      alpha: { env: { A: { required: true } } },
      beta:  { env: { B: { required: true } } },
      gamma: { env: { C: { required: true } } },
    }
    expect(checkAttachments(many, {}).results.map(r => r.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('separates the ones that refuse from the optional ones nobody bound', () => {
    const mixed: Attachments = {
      needed:   { env: { A: { required: true } } },
      niceties: { optional: true, env: { B: { required: true } } },
    }
    const rep = checkAttachments(mixed, {})
    expect(rep.fatal.map(r => r.name)).toEqual(['needed'])
    expect(rep.skipped.map(r => r.name)).toEqual(['niceties'])
  })
})

describe('what the operator reads', () => {

  it('names the service and what it is, not just a variable', () => {
    const rep = checkAttachments(n8n, {})
    const text = formatAttachmentRefusal(rep.fatal)
    expect(text).toContain('n8n (workflow automation)')
    expect(text).toContain('not bound here')
    expect(text).toContain('N8N_URL')
  })

  // A half-bound service and an unbound one have different causes and different
  // fixes, and a list of missing variables reads identically for both.
  it('says a half-bound service is a gap rather than a choice', () => {
    const rep = checkAttachments(n8n, { N8N_URL: 'https://n8n.internal' })
    const text = formatAttachmentRefusal(rep.fatal)
    expect(text).toContain('bound halfway')
    expect(text).toContain('set:     N8N_URL')
    expect(text).toContain('missing: N8N_API_KEY')
    expect(text).toContain('gap rather than a choice')
  })

  it('names the fix, both of them', () => {
    const text = formatAttachmentRefusal(checkAttachments(n8n, {}).fatal)
    expect(text).toContain('attachments')
    expect(text).toContain('optional: true')
  })

  it('says once that an optional service is not bound here', () => {
    const rep = checkAttachments({ n8n: { ...n8n.n8n, optional: true } }, {})
    const lines = formatAttachmentSkips(rep.skipped)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('declared optional, so continuing')
  })
})

describe('the app refuses to start', () => {

  it('when a declared attachment is not bound', async () => {
    const app = createApp({ config: { attachments: n8n }, logLevel: 'silent' })
    let threw: Error | null = null
    try { await app._startForTest() } catch (e) { threw = e as Error }
    expect(threw).not.toBeNull()
    expect(threw!.message).toContain('n8n')
    expect(threw!.message).toContain('not bound here')
  })

  it('when a declared attachment is bound halfway', async () => {
    const half = { n8n: { ...n8n.n8n, optional: true } }
    const app = createApp({
      config: { attachments: { n8n: { ...half.n8n, env: { ...half.n8n.env } } } },
      logLevel: 'silent',
    })
    // Bind one of the two, in this process, for the length of this test.
    process.env.N8N_URL = 'https://n8n.internal'
    try {
      let threw: Error | null = null
      try { await app._startForTest() } catch (e) { threw = e as Error }
      expect(threw).not.toBeNull()
      expect(threw!.message).toContain('bound halfway')
    } finally {
      delete process.env.N8N_URL
    }
  })

  it('and starts when the environment binds it', async () => {
    process.env.N8N_URL     = 'https://n8n.internal'
    process.env.N8N_API_KEY = 'k-123'
    try {
      const app = createApp({ config: { attachments: n8n }, logLevel: 'silent' })
      await app._startForTest()
      expect(app.config.attachments).toBeDefined()
    } finally {
      delete process.env.N8N_URL
      delete process.env.N8N_API_KEY
    }
  })

  it('and starts when an app declares none, which is every app today', async () => {
    const app = createApp({ logLevel: 'silent' })
    await app._startForTest()
    expect(app.config.attachments).toBeUndefined()
  })
})

// ─── the declaration arrives from the config file ────────────────────────────
//
// `junction.config.js` uses friendly section names and `loadConfig` maps only
// the ones it names onto AppConfig — everything else is stashed under
// `_junction` for whichever subsystem owns it. So a top-level key nobody mapped
// is read by nothing and does nothing, silently, which is FJS-431's shape: an
// app writes the block, the app boots, and the feature is simply off.

describe('attachments declared in junction.config.js', () => {

  it('reach config.attachments rather than being stashed under _junction', async () => {
    const { mkdtempSync, writeFileSync: write, rmSync } = await import('node:fs')
    const { join }    = await import('node:path')
    const { tmpdir }  = await import('node:os')
    const { loadConfig } = await import('../src/config/index.ts')

    const dir = mkdtempSync(join(tmpdir(), 'fjs-attach-'))
    try {
      write(join(dir, 'junction.config.js'),
        `export default { app: { name: 'x' }, attachments: { n8n: { env: { N8N_URL: { required: true } } } } }\n`)
      const cfg = await loadConfig(dir)
      expect(cfg.attachments).toBeDefined()
      expect(Object.keys(cfg.attachments!)).toEqual(['n8n'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves an app that declares none with nothing', async () => {
    const { mkdtempSync, writeFileSync: write, rmSync } = await import('node:fs')
    const { join }   = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { loadConfig } = await import('../src/config/index.ts')

    const dir = mkdtempSync(join(tmpdir(), 'fjs-attach-'))
    try {
      write(join(dir, 'junction.config.js'), `export default { app: { name: 'x' } }\n`)
      expect((await loadConfig(dir)).attachments).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── checkEnvField ───────────────────────────────────────────────────────────
//
// The shared per-key validator, extracted so the attachment check calls it
// rather than asking the same questions again. It had no tests at all while it
// lived inside `defineEnv`.

describe('checkEnvField', () => {

  it('reports a required key that is not set', () => {
    const r = checkEnvField('K', { required: true }, undefined)
    expect(r.error).toContain('required but not set')
    expect(r.present).toBe(false)
  })

  it('treats an empty string as not set', () => {
    expect(checkEnvField('K', { required: true }, '').error).toContain('required but not set')
  })

  it('falls back to a default rather than failing', () => {
    const r = checkEnvField('K', { required: true, default: 'd' }, undefined)
    expect(r.error).toBeUndefined()
    expect(r.value).toBe('d')
    // The default satisfied it; nobody set it. Both facts are answered.
    expect(r.present).toBe(false)
  })

  it('coerces a number and refuses one that is not', () => {
    expect(checkEnvField('K', { type: 'number' }, '42').value).toBe(42)
    expect(checkEnvField('K', { type: 'number' }, 'x').error).toContain('expected a number')
  })

  it('bounds a port', () => {
    expect(checkEnvField('K', { type: 'port' }, '70000').error).toContain('between 1 and 65535')
  })

  it('reads the six spellings of a boolean', () => {
    for (const t of ['true', '1', 'yes']) expect(checkEnvField('K', { type: 'boolean' }, t).value).toBe(true)
    for (const f of ['false', '0', 'no']) expect(checkEnvField('K', { type: 'boolean' }, f).value).toBe(false)
    expect(checkEnvField('K', { type: 'boolean' }, 'maybe').error).toContain('expected boolean')
  })

  it('validates a URL and parses JSON', () => {
    expect(checkEnvField('K', { type: 'url' }, 'https://a.b').value).toBe('https://a.b')
    expect(checkEnvField('K', { type: 'url' }, 'nope').error).toContain('valid URL')
    expect(checkEnvField('K', { type: 'json' }, '{"a":1}').value).toEqual({ a: 1 })
    expect(checkEnvField('K', { type: 'json' }, '{').error).toContain('valid JSON')
  })

  it('applies the string constraints', () => {
    expect(checkEnvField('K', { minLength: 5 }, 'abc').error).toContain('at least 5')
    expect(checkEnvField('K', { maxLength: 2 }, 'abc').error).toContain('at most 2')
    expect(checkEnvField('K', { enum: ['a', 'b'] }, 'c').error).toContain('must be one of')
  })

  it('warns about a short signing key without failing the boot', () => {
    const r = checkEnvField('AUTH_SECRET', {}, 'short')
    expect(r.error).toBeUndefined()
    expect(r.warnings.join(' ')).toContain('at least 32')
  })
})
