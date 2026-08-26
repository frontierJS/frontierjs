// api/src/core/idp-sink.ts — the identity provider, standing in for a real one.
//
// A dev OIDC provider: authorize, token, userinfo. Same idea as psp-sink.ts
// beside it, and a SEPARATE LISTENER for the same reason plus one of its own.
//
//   • an in-process fake would prove the app builds a URL and nothing else —
//     no redirect actually followed by a browser, no cookie actually withheld,
//     no `Set-Cookie` actually stored
//   • the whole flow IS the browser. A sign-in that never leaves the process
//     cannot exercise the one thing this design turns on: that the state on the
//     URL and the state in the cookie are carried by different mechanisms and
//     an attacker can hold one without the other
//
// ─── It VERIFIES PKCE, and that is the point ──────────────────────────────
//
// `POST /token` recomputes S256(code_verifier) and refuses a mismatch. A fake
// that accepts any verifier proves the app SENDS one and nothing more — which
// is the same shape as a signer with no verifier, and is how a scheme ends up
// looking enforced while enforcing nothing (FJS-349).
//
// ─── The drive says who signs in ──────────────────────────────────────────
//
// A real consent screen has a person at it. `POST /_control/next` is that
// person: the drive states who comes back and whether the provider will vouch
// for the address, then starts the flow. Without it every case would need its
// own provider process.

import { createHash, randomBytes } from 'crypto'

const PORT = Number(process.env.IDP_SINK_PORT ?? 8113)

const CLIENT_ID     = process.env.IDP_CLIENT_ID     ?? 'dev-idp-client'
const CLIENT_SECRET = process.env.IDP_CLIENT_SECRET ?? 'dev-idp-secret'

interface NextIdentity {
  sub:      string
  email:    string
  name:     string
  /** What the provider will claim. The app decides what to DO with the claim. */
  verified: boolean
  /** Simulate the person clicking Deny at the consent screen. */
  deny:     boolean
}

let next: NextIdentity = {
  sub: 'idp-1', email: 'ada@shop.test', name: 'Ada', verified: true, deny: false,
}

/** code → what it is worth. Single use, like the real thing. */
const codes = new Map<string, { challenge: string; identity: NextIdentity }>()
/** access token → identity, for userinfo. */
const tokens = new Map<string, NextIdentity>()

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function startIdpSink() {
  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url)

      // ── control ──────────────────────────────────────────────────────
      if (url.pathname === '/_control/next' && req.method === 'POST') {
        next = { ...next, ...(await req.json() as Partial<NextIdentity>) }
        return json({ ok: true, next })
      }

      // ── authorize ────────────────────────────────────────────────────
      //
      // No consent screen: the drive already said what the person would do.
      // Everything else a real provider checks is checked, because each one is
      // a thing the app could get wrong and never find out about.
      if (url.pathname === '/authorize') {
        const q           = url.searchParams
        const redirectUri = q.get('redirect_uri') ?? ''
        const state       = q.get('state') ?? ''

        if (q.get('client_id') !== CLIENT_ID) return json({ error: 'invalid_client' }, 401)
        if (!redirectUri)                     return json({ error: 'invalid_request' }, 400)
        // A provider that accepted `plain` would let the app ship a PKCE that
        // does nothing, so the method is checked rather than assumed.
        if (q.get('code_challenge_method') !== 'S256') return json({ error: 'invalid_request' }, 400)
        const challenge = q.get('code_challenge')
        if (!challenge) return json({ error: 'invalid_request' }, 400)

        const back = new URL(redirectUri)
        if (next.deny) {
          back.searchParams.set('error', 'access_denied')
          back.searchParams.set('state', state)
          return Response.redirect(back.toString(), 302)
        }

        const code = randomBytes(16).toString('hex')
        codes.set(code, { challenge, identity: { ...next } })
        back.searchParams.set('code',  code)
        back.searchParams.set('state', state)
        return Response.redirect(back.toString(), 302)
      }

      // ── token ────────────────────────────────────────────────────────
      if (url.pathname === '/token' && req.method === 'POST') {
        const form     = new URLSearchParams(await req.text())
        const code     = form.get('code') ?? ''
        const verifier = form.get('code_verifier') ?? ''
        const entry    = codes.get(code)

        if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
          return json({ error: 'invalid_client' }, 401)
        }
        // Single use. A replayed code is the case the app's own flow row also
        // guards, and both halves have to hold — this is the one a real
        // provider enforces.
        if (!entry) return json({ error: 'invalid_grant' }, 400)
        codes.delete(code)

        if (createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) {
          return json({ error: 'invalid_grant' }, 400)
        }

        const token = randomBytes(16).toString('hex')
        tokens.set(token, entry.identity)
        return json({ access_token: token, token_type: 'Bearer', expires_in: 3600 })
      }

      // ── userinfo ─────────────────────────────────────────────────────
      if (url.pathname === '/userinfo') {
        const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
        const who    = tokens.get(bearer)
        if (!who) return json({ error: 'invalid_token' }, 401)
        return json({
          sub:            who.sub,
          email:          who.email,
          // The claim the linking rule is about, sent as the provider sends it.
          email_verified: who.verified,
          name:           who.name,
        })
      }

      return json({ error: 'not_found' }, 404)
    },
  })

  console.log(`[idp-sink] dev identity provider on :${PORT}`)
  return server
}

export const IDP_URL = process.env.IDP_URL ?? `http://localhost:${PORT}`
