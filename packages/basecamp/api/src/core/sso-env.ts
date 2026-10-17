// src/core/sso-env.ts
// Which sign-in providers this install has, read from its environment.
//
// No imports on purpose: web/config reads this file too, because cookie mode
// and the OAuth block turn on together exactly when one provider is configured
// (`FJS-D670`), and the browser cannot see the server's source. Two readers of
// one list is the reason it is a file of its own rather than a few lines in
// app.ts.

export interface SsoProvider {
  name:   string
  preset: 'github' | 'google' | 'oidc'
  opts:   {
    clientId:      string
    clientSecret:  string
    authorizeUrl?: string
    tokenUrl?:     string
    userinfoUrl?:  string
  }
}

type Source = Record<string, unknown>

// The variables a provider needs, all of them. `oidc` has no endpoints of its
// own, so it names three more.
const PROVIDERS = [
  { name: 'github', preset: 'github', prefix: 'GITHUB', endpoints: false },
  { name: 'google', preset: 'google', prefix: 'GOOGLE', endpoints: false },
  { name: 'oidc',   preset: 'oidc',   prefix: 'OIDC',   endpoints: true  },
] as const

/**
 * The providers `source` configures. A provider with none of its variables set
 * is absent; one with some of them is a THROW naming the rest, because a
 * half-set provider that is silently skipped is a sign-in button the operator
 * believes they turned on.
 */
export function ssoFromEnv(source: Source): SsoProvider[] {
  const found: SsoProvider[] = []

  for (const p of PROVIDERS) {
    const keys = [`${p.prefix}_CLIENT_ID`, `${p.prefix}_CLIENT_SECRET`]
    if (p.endpoints) keys.push(`${p.prefix}_AUTHORIZE_URL`, `${p.prefix}_TOKEN_URL`, `${p.prefix}_USERINFO_URL`)

    const set     = keys.filter(k => source[k])
    if (set.length === 0) continue

    const missing = keys.filter(k => !source[k])
    if (missing.length) {
      throw new Error(`[basecamp] ${p.name} sign-in is half configured: ${set.join(', ')} set, ${missing.join(', ')} missing`)
    }

    const get = (suffix: string) => source[`${p.prefix}_${suffix}`] as string
    found.push({
      name:   p.name,
      preset: p.preset,
      opts: {
        clientId:     get('CLIENT_ID'),
        clientSecret: get('CLIENT_SECRET'),
        ...(p.endpoints ? {
          authorizeUrl: get('AUTHORIZE_URL'),
          tokenUrl:     get('TOKEN_URL'),
          userinfoUrl:  get('USERINFO_URL'),
        } : {}),
      },
    })
  }

  return found
}
