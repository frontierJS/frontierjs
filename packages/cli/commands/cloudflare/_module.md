---
namespace: cloudflare
description: Cloudflare account management — DNS, cache, Pages, Workers
defaults:
  flags:
    zone:
      defaultValue: '${CLOUDFLARE_DEFAULT_ZONE}'
    account:
      defaultValue: '${CLOUDFLARE_ACCOUNT_ID}'
---

## Setup

Every `cloudflare:` command runs Cloudflare's own CLI, `cf`, and uses its login.
fli stores no Cloudflare credential.

```
npm i -g cf
cf auth login
```

`cf auth login` opens the browser and signs you in once. Every account that
login reaches is then reachable from fli.

## A client's login — `--profile`

Keep a second login as a named `cf` profile and name it on the run:

```
cf auth create client
fli cf:dns --zone clientdomain.com --profile client
```

## CI, or a token — `CLOUDFLARE_API_TOKEN`

Where nobody can sign in, set a token. `cf` reads it from the env, and it wins
over the login:

```
CLOUDFLARE_API_TOKEN=<token> fli cf:dns --zone example.com
```

Make one at **dash.cloudflare.com → My Profile → API Tokens → Create Token**,
with what the commands need:

- Zone / DNS / Edit — `cf:dns`
- Zone / Zone / Read — finding a zone by its name, `cf:zones`
- Zone / Cache Purge / Purge — `cf:purge`
- Account / Cloudflare Pages / Edit — `cf:pages`
- Account / Workers Scripts / Read — `cf:workers`

A `--profile` run never sees the token.

## Accounts

`--account` is needed only on `cf:pages` and `cf:workers`, and only when the
login reaches more than one account — `cf` then refuses and lists them. `fli
cf:zones` prints each zone with its account.

## Environment variables

- `CLOUDFLARE_API_TOKEN` — a token in place of the login; CI
- `CLOUDFLARE_ACCOUNT_ID` — the default `--account`
- `CLOUDFLARE_DEFAULT_ZONE` — the default `--zone`, a name or an id

`CLOUDFLARE_TOKEN` is not read here. It is Basecamp's own connector token, asked
for by `fli basecamp:dns`.
