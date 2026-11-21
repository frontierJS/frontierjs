# Signed-in state

`session` is the browser's idea of who is signed in: a reactive object with `user`, `level`, `checked` and `error`, next to `signIn`, `signUp` and `signOut`. Declaring `publicRoutes` in the `junction` config guards every other route, and a `401` from any call signs the page out.

```js
export default {
  junction: {
    url: 'http://localhost:8000',
    cookieAuth: true,   // only if the server issues a cookie
    auth: { publicRoutes: ['/login/', '/blog/*'], redirectTo: '/login/', returnPath: true },
  },
}
```

```html
<script>
  import { session, signOut } from '@frontierjs/sierra/resource'
  $: session.user
</script>

{#if session.user}<button onclick={signOut}>Sign out {session.user.email}</button>{/if}
```

This page has no running example: a sign-in needs a browser and a server that issues a credential.

## What else it can do

- `cookieAuth` is declared on the server as `auth(auth, { cookieAuth: true })` and here, and the two must agree
- A trailing `*` in `publicRoutes` covers the path and everything under it, so `/blog/*` leaves `/blogadmin` guarded
- `redirectTo` is where an unauthorized page goes, and `returnPath: true` brings it back after sign-in
- The guard checks that a credential is present, and the server decides whether it is valid
- `session.level` feeds `resource.can(op, level)`, and the server grades every call regardless

**In depth:** [Sierra README § Auth](../../../README.md#auth)
