---
namespace: cloudflare
description: Cloudflare account management — DNS, cache, Pages, Workers
requires:
  - CLOUDFLARE_TOKEN: https://dash.cloudflare.com/profile/api-tokens  Create Token, the Edit zone DNS template, then add Zone / Zone / Read
defaults:
  flags:
    zone:
      defaultValue: '${CLOUDFLARE_DEFAULT_ZONE}'
    account:
      defaultValue: '${CLOUDFLARE_ACCOUNT_ID}'
---

## Setup

You need a Cloudflare API Token to use any `cloudflare:` command.

1. Go to **dash.cloudflare.com → My Profile → API Tokens**
2. Click **Create Token** → use the **Edit zone DNS** template as a starting point
3. Add permissions for what you need:
   - Zone / DNS / Edit — for DNS commands
   - Zone / Zone / Read — for finding a zone by its name
   - Zone / Cache Purge / Purge — for cache commands
   - Account / Cloudflare Pages / Edit — for Pages commands
4. Add it to your global fli env:

```
fli eset CLOUDFLARE_TOKEN <your-token> --global
fli eset CLOUDFLARE_ACCOUNT_ID <your-account-id> --global
fli eset CLOUDFLARE_DEFAULT_ZONE example.com --global
```

## Account ID

Find your Account ID in the Cloudflare dashboard sidebar on any domain's overview page.

## Client work — switching accounts

For client projects, add a `.env` file to the project root — it overrides
the global config automatically:

```
CLOUDFLARE_TOKEN=<client-token>
CLOUDFLARE_ACCOUNT_ID=<client-account-id>
CLOUDFLARE_DEFAULT_ZONE=<client-domain.com>
```

Or pass `--profile` and `--zone` inline for a one-off override:

```
fli cloudflare:dns --zone clientdomain.com --profile client
```

## Environment variables

- `CLOUDFLARE_TOKEN` — required, API token with appropriate scopes; a first run at a terminal opens the token page and takes the paste
- `CLOUDFLARE_ACCOUNT_ID` — Pages and Workers only, which refuse without it
- `CLOUDFLARE_DEFAULT_ZONE` — default zone name or ID for DNS/cache commands
