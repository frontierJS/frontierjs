# Connection and another app

`initJunction()` is called for you whenever `junction.url` is set, and `status` tells a screen whether the socket is up. A header set once on the client rides every later call, which is how a multi-account app names the account a call is for.

```js
import { getClient, status } from '@frontierjs/sierra/resource'

getClient().setCallHeader('X-Account-Id', '42')   // carried over HTTP and the socket
getClient().setCallHeader('X-Account-Id', null)   // removed
if (typeof status.connected !== 'boolean') throw new Error('expected a connection flag')
```

```html
<script>
  import { status } from '@frontierjs/sierra/resource'
  $: status.connected
</script>

<span class:online={status.connected}></span>
{#if status.stale}<a href="/">A new version is available</a>{/if}
```

## What else it can do

- `status` is `{ connected, reconnecting, stale }`, and `stale` is `{ client, server }` once the server states a newer build, at most once per page
- A page calls its own origin, and `FRONTIER_PUBLIC_API_URL` names the API for a build with no proxy in front
- A header the principal resolver reads through `header()` needs no `callHeaders` entry, and any other goes in `middleware: { callHeaders }`
- `connectApp({ url, apiPrefix, schema, user })` makes a handle on another FrontierJS app, and `createResource('leads', { app: hosted })` reads it
- `whenReady` resolves once the socket is up, and calls made before it take the HTTP path

**In depth:** [Sierra README § A header on every call](../../../README.md#a-header-on-every-call--the-tenant-the-call-is-for), [§ Connection state](../../../README.md#connection-state), [§ Another app](../../../README.md#another-app)
