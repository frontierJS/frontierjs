// tests/forwarded.test.ts — which address do we believe?
//
// `X-Forwarded-For` is a list the CLIENT can start, and the nginx template
// this framework ships appends to whatever it is handed. So every assertion
// here is paired: the value that must win, and the caller's own claim that
// must not — a fix that answered the socket address for everything would
// satisfy the first half alone (`FJS-744`).

import { describe, it, expect } from 'bun:test'
import { clientAddress } from '../src/transport/forwarded.ts'

// What the wire really looks like behind the shipped template: the client
// sent one entry, nginx appended what it observed, and our socket sees nginx.
const CLAIMED = '6.6.6.6'
const REAL    = '198.51.100.7'
const NGINX   = '10.0.0.1'

describe('nothing is trusted by default', () => {
  it('answers the socket address', () => {
    expect(clientAddress({
      forwarded: `${CLAIMED}, ${REAL}`, remoteAddr: NGINX,
    })).toBe(NGINX)
  })

  it('answers the socket address even when the header names it', () => {
    expect(clientAddress({
      forwarded: NGINX, realIp: CLAIMED, remoteAddr: '203.0.113.9',
    })).toBe('203.0.113.9')
  })

  it('has no address to fall back to rather than a header', () => {
    expect(clientAddress({ forwarded: CLAIMED, realIp: CLAIMED })).toBe('127.0.0.1')
  })
})

describe('a hop count', () => {
  it('one hop is what the nearest proxy observed', () => {
    const answer = clientAddress({
      forwarded: `${CLAIMED}, ${REAL}`, remoteAddr: NGINX, trust: true,
    })
    expect(answer).toBe(REAL)
    expect(answer).not.toBe(CLAIMED)
  })

  it('two hops steps one further left', () => {
    // A load balancer in front of nginx: chain is claim, real, lb, socket.
    expect(clientAddress({
      forwarded: `${CLAIMED}, ${REAL}, 172.16.0.4`, remoteAddr: NGINX, trust: 2,
    })).toBe(REAL)
  })

  it('a forged chain cannot buy the caller a distinct key', () => {
    // The attack: five requests, five invented left-hand entries. Under the
    // leftmost reading these were five clients; they are one.
    const seen = new Set(
      ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5'].map(forged =>
        clientAddress({ forwarded: `${forged}, ${REAL}`, remoteAddr: NGINX, trust: true }),
      ),
    )
    expect(seen).toEqual(new Set([REAL]))
  })

  it('clamps rather than falling off the end', () => {
    // A proxy that did not write its header. Stepping past the chain must not
    // answer undefined, and the leftmost entry here is still an observed one.
    expect(clientAddress({ remoteAddr: NGINX, trust: 3 })).toBe(NGINX)
    expect(clientAddress({ forwarded: REAL, remoteAddr: NGINX, trust: 9 })).toBe(REAL)
  })

  it('zero hops is the same statement as false', () => {
    expect(clientAddress({
      forwarded: CLAIMED, remoteAddr: NGINX, trust: 0,
    })).toBe(NGINX)
  })
})

describe('a trusted-proxy list', () => {
  const TRUST = ['10.0.0.0/8', '::1']

  it('walks left past our own proxies and stops at the first that is not', () => {
    expect(clientAddress({
      forwarded: `${CLAIMED}, ${REAL}, 10.0.0.9`, remoteAddr: '10.0.0.1', trust: TRUST,
    })).toBe(REAL)
  })

  it('ignores the header entirely when the peer is not one of ours', () => {
    // Somebody reaching the app directly, sending a header that names a
    // plausible chain. Nothing in it was written by us.
    expect(clientAddress({
      forwarded: `${CLAIMED}, 10.0.0.9`, remoteAddr: '203.0.113.9', trust: TRUST,
    })).toBe('203.0.113.9')
  })

  it('answers the leftmost when every hop is ours', () => {
    expect(clientAddress({
      forwarded: '10.0.0.7, 10.0.0.8', remoteAddr: '10.0.0.1', trust: TRUST,
    })).toBe('10.0.0.7')
  })

  it('does not let a v4 prefix match a v6 address, or the reverse', () => {
    expect(clientAddress({
      forwarded: CLAIMED, remoteAddr: '::1', trust: ['10.0.0.0/8'],
    })).toBe('::1')
    expect(clientAddress({
      forwarded: CLAIMED, remoteAddr: '10.0.0.1', trust: ['::/0'],
    })).toBe('10.0.0.1')
  })

  it('matches a prefix that is not a whole number of bytes', () => {
    // /12 is the case a private range actually uses (172.16.0.0/12), and it
    // is the one a byte-at-a-time comparison gets wrong.
    const trust = ['172.16.0.0/12']
    expect(clientAddress({
      forwarded: `${CLAIMED}, ${REAL}`, remoteAddr: '172.31.255.254', trust,
    })).toBe(REAL)
    // 172.32.0.1 is outside /12 and inside a naive /16-or-/8 reading.
    expect(clientAddress({
      forwarded: `${CLAIMED}, ${REAL}`, remoteAddr: '172.32.0.1', trust,
    })).toBe('172.32.0.1')
  })

  it('matches an IPv6 proxy by prefix', () => {
    expect(clientAddress({
      forwarded: `${CLAIMED}, ${REAL}`, remoteAddr: '2001:db8::5', trust: ['2001:db8::/32'],
    })).toBe(REAL)
    expect(clientAddress({
      forwarded: `${CLAIMED}, ${REAL}`, remoteAddr: '2001:db9::5', trust: ['2001:db8::/32'],
    })).toBe('2001:db9::5')
  })

  it('reads an IPv4-mapped socket address as the v4 address it is', () => {
    // What a dual-stack listener reports. Without this the `10.0.0.0/8` an
    // operator wrote never matches anything and the list silently trusts
    // nobody — which looks exactly like a correctly refused header.
    expect(clientAddress({
      forwarded: `${CLAIMED}, ${REAL}`, remoteAddr: '::ffff:10.0.0.1', trust: ['10.0.0.0/8'],
    })).toBe(REAL)
  })

  it('reads a port off an address', () => {
    expect(clientAddress({
      forwarded: `${CLAIMED}, ${REAL}`, remoteAddr: '10.0.0.1:54321', trust: ['10.0.0.0/8'],
    })).toBe(REAL)
    expect(clientAddress({
      forwarded: `${CLAIMED}, ${REAL}`, remoteAddr: '[2001:db8::5]:443', trust: ['2001:db8::/32'],
    })).toBe(REAL)
  })
})

describe('x-real-ip', () => {
  it('stands in only where there is no chain to read', () => {
    expect(clientAddress({
      realIp: REAL, remoteAddr: NGINX, trust: true,
    })).toBe(REAL)
  })

  it('loses to the chain, which the same proxy also wrote', () => {
    expect(clientAddress({
      forwarded: `${CLAIMED}, ${REAL}`, realIp: '9.9.9.9', remoteAddr: NGINX, trust: true,
    })).toBe(REAL)
  })

  it('is refused when the peer is not a proxy of ours', () => {
    expect(clientAddress({
      realIp: CLAIMED, remoteAddr: '203.0.113.9', trust: ['10.0.0.0/8'],
    })).toBe('203.0.113.9')
  })
})

// ─── Through a real app ──────────────────────────────────────
// The unit half above is about one function. This is about whether an app can
// reach it at all: `trustProxy` lived on the transport and was passed from
// NOWHERE — no config key, and `app.ts` never set one — so every deployed app
// keyed on the proxy's own address and shared one rate-limit bucket across the
// whole internet (`FJS-744`).
//
// A REAL listening socket, because the in-process `request()` helper goes
// through the bridge and never reaches the transport, so it cannot see this at
// all — which is why the option could be dead for as long as it was.

import { createApp } from '../src/core/app.ts'

async function appSeeing(trustProxy: unknown) {
  const app = createApp({
    config: {
      port:     0,
      http:     { trustProxy } as never,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
    },
    logLevel: 'silent',
  })
  // A RAW route: `ctx.ip` is the transport context's, which is the value the
  // rate limiter and the DDoS guard key on.
  app.get('/whoami', ctx => ctx.json({ ip: ctx.ip }))
  await app.start()
  const port = app.http.port as number
  return {
    async ask(forwarded: string) {
      const res = await fetch(`http://127.0.0.1:${port}/whoami`, {
        headers: { 'x-forwarded-for': forwarded },
      })
      return (await res.json() as { ip: string }).ip
    },
    stop: () => app.stop(),
  }
}

describe('an app can actually declare it', () => {
  it('reads the chain from the right when the app says one hop', async () => {
    const app = await appSeeing(true)
    try {
      expect(await app.ask('6.6.6.6, 198.51.100.7')).toBe('198.51.100.7')
    } finally { await app.stop() }
  })

  it('ignores the header entirely when the app says nothing', async () => {
    const app = await appSeeing(undefined)
    try {
      const ip = await app.ask('6.6.6.6, 198.51.100.7')
      expect(ip).not.toBe('6.6.6.6')
      expect(ip).not.toBe('198.51.100.7')
      // The socket, which is the only thing that observed this request.
      expect(ip).toBe('127.0.0.1')
    } finally { await app.stop() }
  })
})
