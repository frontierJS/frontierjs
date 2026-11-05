# Fixtures — two conforming providers (FJS-D889)

## panva `oidc-provider` — PROVED, in-process, no docker

A devDependency of this package only. `bun run drive:fixture` starts it on an
ephemeral port with client `drive:drive-secret` (client_secret_basic, PKCE
required), walks its dev login and consent pages by hand to obtain a code,
and runs the drive with `FIXTURE_URL`, `FIXTURE_CLIENT`, `FIXTURE_CODE`,
`FIXTURE_VERIFIER`, `FIXTURE_REDIRECT`, `FIXTURE_NONCE` set. 44 rows green on
Bun 1.4.2 (the provider warns Bun is unsupported; it served every row).

## Dex — UNPROVED (no docker on this machine)

```sh
cat > /tmp/dex.yaml <<'YAML'
issuer: http://127.0.0.1:5556
storage: { type: memory }
web: { http: 0.0.0.0:5556 }
oauth2: { skipApprovalScreen: true }
staticClients:
  - id: drive
    secret: drive-secret
    name: drive
    redirectURIs: ['http://app.test/callback']
enablePasswordDB: true
staticPasswords:
  - email: alice@example.test
    # bcrypt of "password"
    hash: "$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W"
    username: alice
    userID: alice
YAML
docker run --rm -p 5556:5556 -v /tmp/dex.yaml:/etc/dex/config.yaml ghcr.io/dexidp/dex:v2.41.1 dex serve /etc/dex/config.yaml

# discovery, JWKS and the refusal rows need no browser:
FIXTURE_URL=http://127.0.0.1:5556 FIXTURE_CLIENT=drive:drive-secret bun run drive

# the token rows need a code: open authorizationUrl(...) in a browser, sign in
# as alice, copy `code` off the callback, and pass the PKCE verifier you used:
FIXTURE_URL=http://127.0.0.1:5556 FIXTURE_CLIENT=drive:drive-secret \
FIXTURE_CODE=<code> FIXTURE_VERIFIER=<verifier> FIXTURE_REDIRECT=http://app.test/callback FIXTURE_NONCE=<nonce> bun run drive
```

Any other provider (Keycloak, Authentik, Auth0 dev tenant) runs the same way
through `FIXTURE_URL`; the fixture rows exclude the sink's chaos.
