# fullstack — the whole road, end to end

```
bun run example/fullstack/app.ts
open http://localhost:3400
```

Open it in two tabs. Create a post in one; it appears in the other. Delete it;
it disappears from both.

## The three files

Read them in this order. Each is short, and each is short *because* of the one
before it.

| file | lines that matter | what it establishes |
|---|---|---|
| [`db/schema.lite`](db/schema.lite) | 8 | the table, the gate, the field rules |
| [`services/posts.service.ts`](services/posts.service.ts) | 3 | the service |
| [`public/index.html`](public/index.html) | ~20 | the Resource |

The service is the whole point:

```ts
export function createPostsService() {
  return createBaseService({})
}
```

Nothing in it restates the schema. Its name comes from the filename
(`posts.service.ts` → `posts` → `/api/posts`), its model from the name
(`posts` → `db.post`), its db from `app.db` scoped to the caller, its CRUD from
the model, its 401s from `@@gate`, its 400s from the field rules.

The browser file names the service and nothing else — no field list, no URL, no
event wiring:

```js
const { service, store, load } = client.resource('posts')
store.subscribe(render)
await load()
```

`app.ts` is the only file with wiring in it, and most of that is demo
scaffolding — seed rows, a fake login, bundling the browser client — rather than
framework.

## What this example is for

It is a test that happens to be readable. Walking this road once found seven
defects that unit tests over fake clients could not, because each one lived in
the gap between two packages:

| | found |
|---|---|
| `@@gate` failed open under a plural model name | `posts` matched no model, which read as "no gate declared" |
| accessor probing died on the first miss | a real Litestone client is a Proxy that **throws** on an unknown accessor rather than returning `undefined` |
| optional fields were mandatory | `String?` is nullable, and the validator's absent-value branch was unreachable for nullable fields |
| `Object.keys()` on a client throws | duplicate `ownKeys` in the proxy — it replaced a diagnostic with a stack trace |
| every WS event name was present tense | `posts create` on the wire, `posts created` in every listener |
| `remove` re-added the deleted record | the client's `'*'` fallback upserted what the named handlers should have removed |
| `resource()` never opened its socket | it documents automatic real-time wiring and left `connect()` to the caller |

None of them broke a request. Six of the seven were silent.

## The seam, and how it closed

`@@gate` grades the caller on Litestone's 0–7 scale. Litestone's own default
resolver, `FrontierGateGetLevel`, grades a shape Junction does not produce — it
reads `verifiedAt → activatedAt → role → isAdmin/isOwner/isSystemAdmin`, while
`SessionContext` declares `{ userId, userType, email, name, accountId,
workspaceId, role, scopes, authMethod }`. The two overlap on `role` alone, and
`role` is tested third. So a session without `verifiedAt` graded as VISITOR (1)
whatever it carried, and a write from a *logged-in* user came back

```
403  "Post.create" requires level 4, user has level 1
```

*after* Junction's own `gateAuth` hook had already approved it — two gates
disagreeing about who the caller is.

The settlement: **Litestone owns the scale; each caller owns the mapping from
its own user shape onto it.** Junction ships that mapping, and `app.ts` passes
it in one line:

```ts
plugins: [new GatePlugin({ getLevel: sessionGateLevel })]
```

with the load-bearing rule that **absence is not an objection**:

| session carries | grades as | meaning |
|---|---|---|
| nothing | STRANGER (0) | not logged in |
| `verifiedAt: null` | VISITOR (1) | app models verification; user hasn't |
| `activatedAt: null` | READER (2) | app models activation; user hasn't |
| *nothing relevant* | **USER (4)** | authenticated, no lifecycle modelled |
| `isAdmin` | ADMINISTRATOR (5) | |
| `isOwner` | OWNER (6) | |
| `isSystemAdmin` | SYSADMIN (7) | |

`undefined` means the app does not model that stage; `null` means it does and
this user has not reached it. An app with no verification flow is not an app
whose users are all unverified — reading it that way is what made every write
403. Role strings are deliberately *not* interpreted: `'admin'` means whatever
an app decides, and matching on it would hand out level 5 on a string compare.
Apps that grade by role wrap the resolver:

```ts
getLevel: (u) => u?.role === 'staff' ? LEVELS.ADMINISTRATOR : sessionGateLevel(u)
```

This example now declares exactly one piece of standing — `isAdmin: true`, which
is what lifts the demo session to level 5 so the page's delete button works
against `@@gate("0.4.4.5")`. Everything else follows from having authenticated.

## Notes

- The client is bundled on boot by `Bun.build` and served at `/client.js`.
  Sierra's build does this for you in a real app.
- This example imports the **workspace** Litestone (1.0.6) by relative path,
  while Junction's own `package.json` pins `"latest"`, which resolves to the
  published 1.0.3. Keeping the example on the workspace copy is deliberate: it
  is the only place the two are exercised together.
- The database is `:memory:`, so every restart reseeds.
