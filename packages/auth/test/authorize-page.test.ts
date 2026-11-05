/**
 * The packed /authorize page (`FJS-D1934`). It renders strings a stranger
 * chose -- the client's host, an App name, an error carrying input -- into a
 * page that asks for a password, so every prop is checked escaped where it
 * lands, and the style hash is checked against the style it hashes: a policy
 * naming the wrong hash is a page that renders unstyled, which no other test
 * would see.
 */
import { describe, test, expect } from 'bun:test'
import { createHash }             from 'node:crypto'
import { render, STYLE_HASH, type AuthorizeProps } from '../authorize-page.snapshot.js'

const base: AuthorizeProps = {
  app:          'Yuma',
  client:       { host: 'claude.ai', loopback: false },
  redirectHost: 'claude.ai',
  step:         'password',
  error:        null,
  action:       '/api/auth/authorize',
  fields:       { request: 'r1', csrf: 'c1' },
}
const page = (over: Partial<AuthorizeProps> = {}) => render({ ...base, ...over })
const HOSTILE = '<script>alert(1)</script>"x'

describe('authorize page', () => {
  test('the password step asks for email and password and carries the hidden fields', () => {
    const html = page()
    expect(html).toStartWith('<!DOCTYPE html>')
    expect(html).toContain('action="/api/auth/authorize"')
    expect(html).toMatch(/<input[^>]*name="email"/)
    expect(html).toMatch(/<input[^>]*name="password"[^>]*type="password"/)
    expect(html).toMatch(/<input[^>]*name="request"[^>]*value="r1"/)
    expect(html).toMatch(/<input[^>]*name="csrf"[^>]*value="c1"/)
    expect(html).not.toContain('name="code"')
    expect(html).not.toContain('name="decision"')
  })

  test('the totp step asks for the code alone', () => {
    const html = page({ step: 'totp' })
    expect(html).toMatch(/<input[^>]*name="code"[^>]*autocomplete="one-time-code"/)
    expect(html).not.toContain('name="password"')
  })

  test('the consent step names the host, the App and the redirect, with Allow and Deny', () => {
    const html = page({ step: 'consent', client: { host: 'evil.example', loopback: false }, redirectHost: 'cb.example' })
    expect(html).toContain('Allow <strong>evil.example</strong> to act as you in <strong>Yuma</strong>')
    expect(html).toContain('<strong>cb.example</strong>')
    expect(html).toMatch(/name="decision"[^>]*value="allow"/)
    expect(html).toMatch(/name="decision"[^>]*value="deny"/)
    expect(html).not.toContain('name="password"')
  })

  test('the loopback warning appears only when every redirect is loopback', () => {
    const consent = { step: 'consent' as const }
    expect(page({ ...consent, client: { host: 'localhost', loopback: true } })).toContain('any program running here can receive the code')
    expect(page({ ...consent, client: { host: 'claude.ai', loopback: false } })).not.toContain('any program running here')
  })

  test('a hostile App name, client host, error and field come out escaped', () => {
    const html = page({
      step: 'consent', app: HOSTILE, client: { host: HOSTILE, loopback: false },
      redirectHost: HOSTILE, error: HOSTILE, fields: { request: HOSTILE },
    })
    // Six text sinks: the App in the title and twice in the body, the host,
    // the redirect, the error.
    // Inside a quoted attribute only `"` and `&` can end or bend the value, so
    // the server target escapes those two there, as the DOM serializer does.
    const outsideAttributes = html.replace(/="[^"]*"/g, '=""')
    expect(outsideAttributes).not.toContain('<script')
    expect(outsideAttributes.match(/&lt;script&gt;alert\(1\)&lt;\/script&gt;"x/g)).toHaveLength(6)
    expect(html).toContain('value="<script>alert(1)</script>&quot;x"')
    expect(page({ error: 'Wrong password' })).toMatch(/role="alert"[\s\S]*Wrong password/)
    expect(page()).not.toContain('role="alert"')
  })

  test('STYLE_HASH is the sha256 of the one inlined style', () => {
    const styles = [...page().matchAll(/<style>([\s\S]*?)<\/style>/g)]
    expect(styles).toHaveLength(1)
    expect(STYLE_HASH).toBe('sha256-' + createHash('sha256').update(styles[0][1]).digest('base64'))
  })
})
