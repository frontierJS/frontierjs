// src/types.ts — the OpenID Connect shapes this connector reads and writes.

/** `GET /.well-known/openid-configuration` (OpenID Connect Discovery 1.0 §3). */
export interface Discovery {
  issuer:                                 string
  authorization_endpoint:                 string
  token_endpoint:                         string
  jwks_uri:                               string
  userinfo_endpoint?:                     string
  end_session_endpoint?:                  string
  revocation_endpoint?:                   string
  introspection_endpoint?:                string
  response_types_supported?:              string[]
  id_token_signing_alg_values_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  code_challenge_methods_supported?:      string[]
  scopes_supported?:                      string[]
  claims_supported?:                      string[]
  backchannel_logout_supported?:          boolean
}

/** One key of a JWK Set (RFC 7517). Only the public halves this verifier reads. */
export interface Jwk {
  kty:  'RSA' | 'EC' | 'OKP' | string
  kid?: string
  use?: 'sig' | 'enc' | string
  alg?: string
  // RSA
  n?:   string
  e?:   string
  // EC
  crv?: string
  x?:   string
  y?:   string
}

export interface Jwks { keys: Jwk[] }

/** RFC 6749 §5.1 plus OIDC's `id_token`. `expires_in` is seconds from the answer. */
export interface TokenSet {
  access_token:   string
  token_type:     string
  expires_in?:    number
  refresh_token?: string
  id_token?:      string
  scope?:         string
}

/** The claims an id_token carries after the verifier has read them (OIDC Core §2). */
export interface IdClaims {
  iss:        string
  sub:        string
  aud:        string | string[]
  exp:        number
  iat:        number
  nbf?:       number
  auth_time?: number
  nonce?:     string
  azp?:       string
  at_hash?:   string
  acr?:       string
  amr?:       string[]
  sid?:       string
  email?:     string
  email_verified?: boolean
  name?:      string
  [claim: string]: unknown
}

/** Back-Channel Logout 1.0 §2.4: a logout token has `events` and `sid` or `sub`, never a `nonce`. */
export interface LogoutClaims {
  iss:    string
  aud:    string | string[]
  iat:    number
  jti:    string
  exp?:   number
  sub?:   string
  sid?:   string
  events: Record<string, Record<string, never>>
  [claim: string]: unknown
}

/** OIDC Core §5.3.2. */
export interface UserInfo {
  sub:   string
  name?: string
  email?: string
  email_verified?: boolean
  [claim: string]: unknown
}

/** RFC 6749 §5.2 — what every OAuth refusal body looks like. */
export interface OAuthErrorBody {
  error?:             string
  error_description?: string
  error_uri?:         string
}
