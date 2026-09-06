// tests/secret-redaction.test.ts
//
// Junction printed credentials in two places and neither was an accident of one
// call site (`FJS-709` `batteries-11`).
//
//   The logger wrote `data` with `JSON.stringify` and no filter, so an
//   `authorization` header handed to `log.info` reached stdout whole — nested
//   ones included, which is the shape a request logger produces.
//
//   `defineEnv` quoted the offending value on a type failure, so a malformed
//   `DATABASE_URL` put its password on stderr AT BOOT, which is the most-pasted
//   output a process produces.
//
// The name set is `@frontierjs/toolbelt/redact` and is tested there. What is
// tested HERE is the seam — that junction asks it — because the kit passing and
// junction never calling it look identical from the kit's side.
//
// Every removal row is PAIRED with an ordinary sibling on the same line, since a
// redactor that blanked everything would satisfy a test that only checked the
// secret was gone.

import { describe, test, expect } from 'bun:test'
import { createLogger } from '../src/core/logger.ts'
import { defineEnv } from '../src/core/env.ts'
import { redactProtected } from '../src/core/errors.ts'

const capture = (fn: () => void): string => {
  const out: string[] = []
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  ;(process.stdout as any).write = (s: string) => { out.push(String(s)); return true }
  ;(process.stderr as any).write = (s: string) => { out.push(String(s)); return true }
  try { fn() } finally {
    ;(process.stdout as any).write = realOut
    ;(process.stderr as any).write = realErr
  }
  return out.join('')
}

describe('the logger does not print credentials', () => {
  test('json format, top level and nested', () => {
    const log = createLogger({ format: 'json', level: 'debug' })
    const line = capture(() => log.info('request', {
      authorization: 'Bearer sk_live_TOKEN',
      cookie:        'session=DEADBEEF',
      password:      'hunter2',
      userId:        42,
      path:          '/orders',
      headers:       { Authorization: 'Bearer NESTED_TOKEN', accept: 'application/json' },
    }))

    for (const secret of ['sk_live_TOKEN', 'DEADBEEF', 'hunter2', 'NESTED_TOKEN'])
      expect(line).not.toContain(secret)

    // The pair: everything else on the same line survives, or this passes
    // against a logger that stopped writing `data` at all.
    expect(line).toContain('"userId":42')
    expect(line).toContain('/orders')
    expect(line).toContain('application/json')
    expect(line).toContain('[redacted]')
  })

  test('pretty format too — a terminal is where a token gets shoulder-surfed', () => {
    const log = createLogger({ format: 'pretty', level: 'debug' })
    const line = capture(() => log.info('request', {
      authorization: 'Bearer sk_live_TOKEN',
      headers:       { cookie: 'session=DEADBEEF' },
      userId:        42,
    }))
    expect(line).not.toContain('sk_live_TOKEN')
    expect(line).not.toContain('DEADBEEF')
    expect(line).toContain('42')
  })
})

describe('defineEnv does not quote what it must not', () => {
  const withEnv = (vars: Record<string, string>, fn: () => void) => {
    const prev: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v }
    try { fn() } finally {
      for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v)
    }
  }
  const refusal = (spec: any): string => {
    try { defineEnv(spec); return '' } catch (e: any) { return e.message }
  }

  test('a malformed connection string loses its password and keeps its host', () => {
    // Malformed on purpose: the value being quoted is by definition the one
    // that failed to parse, so a rule anchored on `://` would miss it.
    withEnv({ DATABASE_URL: 'postgres//admin:S3cr3tP@ss@db.internal:5432/prod' }, () => {
      const msg = refusal({ DATABASE_URL: { required: true, type: 'url' } })
      expect(msg).not.toContain('S3cr3tP@ss')
      // …and still says which host and which user, or nobody can debug it.
      expect(msg).toContain('db.internal')
      expect(msg).toContain('admin')
    })
  })

  test('a secret NAME says nothing about its value, and a lookalike is untouched', () => {
    withEnv({ STRIPE_SECRET_KEY: 'sk_live_51HxxYY', SORT_KEY: 'not-a-url-either' }, () => {
      expect(refusal({ STRIPE_SECRET_KEY: { required: true, type: 'url' } })).not.toContain('sk_live_51HxxYY')
      // The pair. `SORT_KEY` and `CACHE_KEY` are why the env rule is per
      // segment and why `key` alone does not qualify — a redaction that ate
      // these would be turned off wholesale.
      expect(refusal({ SORT_KEY: { required: true, type: 'url' } })).toContain('not-a-url-either')
    })
  })

  test('`secret` can be stated where the name does not say it', () => {
    withEnv({ LEGACY_HANDSHAKE: 'plaintext-credential' }, () => {
      expect(refusal({ LEGACY_HANDSHAKE: { required: true, type: 'url' } })).toContain('plaintext-credential')
      expect(refusal({ LEGACY_HANDSHAKE: { required: true, type: 'url', secret: true } }))
        .not.toContain('plaintext-credential')
    })
  })
})

describe('one walker, two predicates', () => {
  test('the schema predicate still answers only for schema fields', () => {
    // `redactProtected` delegates to the kit's walk now. Its predicate is the
    // SCHEMA's protected set, so a credential-shaped key it does not name must
    // survive — the two questions are separate and folding them would redact a
    // caller's own payload.
    const out: any = redactProtected(
      { ssn: '111-22-3333', password: 'p', ok: 1 },
      { ssn: 'encrypted' },
    )
    expect(out.ssn).toBe('[redacted]')
    expect(out.password).toBe('p')
    expect(out.ok).toBe(1)
  })

  test('cycles and non-plain objects survive the delegation', () => {
    const a: any = { ssn: 'x' }
    a.self = a
    const out: any = redactProtected(a, { ssn: 'encrypted' })
    expect(out.ssn).toBe('[redacted]')
    expect(out.self).toBe('[circular]')

    const d = new Date(0)
    expect((redactProtected({ d }, {}) as any).d).toBe(d)
  })
})
