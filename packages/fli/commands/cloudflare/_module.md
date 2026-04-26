---
namespace: cloudflare
description: Cloudflare account management — DNS, cache, Pages, Workers
requires:
  - CLOUDFLARE_TOKEN
  - CLOUDFLARE_ACCOUNT_ID
defaults:
  flags:
    zone:
      defaultValue: '${CLOUDFLARE_DEFAULT_ZONE}'
    account:
      defaultValue: '${CLOUDFLARE_ACCOUNT_ID}'
---

<script>
// ─── Cloudflare API helper ────────────────────────────────────────────────────
// Token resolution order:
//   1. flag.token (per-run override)
//   2. CLOUDFLARE_TOKEN in project .env  (client work)
//   3. CLOUDFLARE_TOKEN in ~/.config/fli/.env  (your default account)
const cfToken = (context) =>
  context?.flag?.token || process.env.CLOUDFLARE_TOKEN

const cfApi = async (context, method, path, body) => {
  const token = cfToken(context)
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!data.success) {
    const errs = (data.errors || []).map(e => `${e.code}: ${e.message}`).join(', ')
    throw new Error(errs || `Cloudflare API error ${res.status}`)
  }
  return data.result
}

// Resolve zone ID from a zone name or ID string
const resolveZone = async (context, zoneArg) => {
  if (!zoneArg) throw new Error('No zone specified — use --zone or set CLOUDFLARE_DEFAULT_ZONE')
  // If it looks like an ID (32 hex chars), use directly
  if (/^[a-f0-9]{32}$/i.test(zoneArg)) return zoneArg
  // Otherwise look it up by name
  const zones = await cfApi(context, 'GET', `/zones?name=${zoneArg}&per_page=1`)
  if (!zones.length) throw new Error(`Zone not found: ${zoneArg}`)
  return zones[0].id
}
</script>

## Setup

You need a Cloudflare API Token to use any `cloudflare:` command.

1. Go to **dash.cloudflare.com → My Profile → API Tokens**
2. Click **Create Token** → use the **Edit zone DNS** template as a starting point
3. Add permissions for what you need:
   - Zone / DNS / Edit — for DNS commands
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

Or pass `--token` and `--zone` inline for a one-off override:

```
fli cloudflare:dns --zone clientdomain.com --token cf_xxxxx
```

## Environment variables

- `CLOUDFLARE_TOKEN` — required, API token with appropriate scopes
- `CLOUDFLARE_ACCOUNT_ID` — required for Pages/Workers commands
- `CLOUDFLARE_DEFAULT_ZONE` — default zone name or ID for DNS/cache commands
