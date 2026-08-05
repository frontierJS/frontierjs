# Conduit — Architecture & Production-Readiness Audit

_Audited: 2026-08-01 · Package: `@frontierjs/conduit` 0.1.0 (`conduit.zip`) · 2,516 lines across 17 files · Runtime: Bun 1.3.13_

---

> ## Status — updated 2026-08-01
>
> **This audit describes the pre-remediation tree. Most of it has since been addressed.** Read the findings for the reasoning; check here for what is still true.
>
> **Fixed** — every blocker in §1, every finding in §2 and §3, §4 and §5 in full, and most of §6. Specifically: §1.1 (auth on the WS upgrade), §1.2 (credentials behind a `CredentialResolver`, descriptors carry refs only, and management now *requires* an access decision at `configure()`), §1.3 (canonical `method\npath\ntimestamp\nnonce\nbody-hash` signing, always applied), §1.4 (auth headers win), §1.5 (timeout covers the body read; `max_response_bytes` cap), §2.1–§2.6, §2.7 (jitter, `deadline_ms`, per-target circuit breaker and concurrency cap), §2.8 (`req.validate`), §3.1 (`UnixTransport extends HttpTransport` — the divergence is gone), §3.2–§3.6, §4 (populated `stats()` incl. breaker state, `onRetry`, stream hooks, async hooks, W3C trace propagation), §5 (`StubTransport` can simulate failure; stubs register into the store; SQLite store tested).
>
> Test count went 46 → 189. Every source file is at 100% line coverage except `websocket.ts` (96.5%) and `router.ts` (93.9%).
>
> **Not fixed, by decision** — per-frame WebSocket signing. Auth is applied to the connection upgrade only; anything able to write to an established socket can issue any command on it. Documented in the README.
>
> **Still open** — the response cap and breaker are per-target, not global, so there is no process-wide memory or concurrency ceiling. `meta.duration_ms` still measures only the last attempt (the conduit-level counters measure the whole call correctly). No `tsconfig.json` — a repo-wide gap, not conduit's.
>
> **Corrections to this audit** — §1.6 ("does not install") was an artifact of auditing a zip outside the monorepo; the surviving parts were the false `peerDependenciesMeta.optional` and the missing `tsconfig.json` (the latter is a repo-wide gap, not conduit's). §1.2's "fails open" is softened by Junction's app-level hooks, which do reach this service — now covered by a test.
>
> **Found later, not in this audit** — `management: true` registered a service named `conduit/targets`, which Junction can never route (`{service}` matches one path segment), so the default management endpoint 404'd on every request. Found by integration-testing against a real Junction app rather than a fake one.

---

Every finding below was **reproduced by executing the code**, not inferred from reading it. Where a hypothesis failed under test it was discarded (noted in §8). File and line references are to the shipped tree.

---

## 0. Verdict

**Is it elegant? The interface is. The implementation behind it is not, and one structural flaw undermines the central promise.**

The public surface is genuinely well-designed, and better than most things in this category:

- Named targets instead of raw URLs is the right call — it moves credentials and addressing out of call sites entirely.
- `ConduitResult` as a discriminated union with a documented never-throw contract is a mature choice over exceptions.
- The plugin uses Junction's `register`/`boot`/`ready`/`shutdown` lifecycle correctly, with the right work in each phase — better lifecycle hygiene than several plugins in Junction core itself.
- Shipping a test double alongside the library shows the author was thinking about consumers.
- `NotImplementedTransport` failing loudly for `ssh`/`nats` instead of silently no-oping is exactly right.

But the tagline is *"One interface. Any protocol. Any direction."* and that promise does not hold. **Auth is declared per-target, but only one of the three implemented transports honours it.** A target declared `auth: { type: 'hmac', secret }` sends fully unauthenticated traffic over WebSocket and over Unix sockets — silently, with no warning and no error. The same `ConduitRequest` also means materially different things depending on which protocol the target happens to use: `headers` is honoured on HTTP and dropped on Unix; `method` is a real verb on HTTP and an arbitrary string wrapped into the body on Unix; `stream()` is real on WebSocket, a silent empty iterator on HTTP and Unix. The abstraction leaks at exactly the boundary it exists to hide.

That is a design problem, not just a bug list. Fixing it means pulling auth into `BaseTransport` as a mandatory step rather than an opt-in helper each transport may forget to call.

**Recommendation: do not put this in production yet.** Six blockers in §1, four of them security. None are deep — this is roughly one to two weeks of focused work, not a rewrite. The bones are good enough to be worth fixing rather than replacing.

**Counts:** 6 blockers · 8 high · 6 medium · 4 observability gaps · 4 testing gaps · 9 packaging/hygiene.

---

## 1. Blockers — do not ship

### 1.1 The WebSocket transport applies no authentication whatsoever

`src/transports/websocket.ts` (whole file) — `buildAuthHeaders` is never called.

`base.ts:74–108` builds auth headers, and `http.ts:80` uses them. `websocket.ts` never does. Verified against a live WS server with an `hmac` target:

```
upgrade request headers: {"auth":null,"sig":null}
frame sent on wire: {"id":"7c35…","type":"request","method":"POST","path":"/deploy","body":{"image":"v2"}}
```

No `Authorization` on the upgrade, no signature in the frame, no credential anywhere. WebSocket is the documented transport for *"persistent agent connections"* — the control plane that issues `deploy`, `pull`, `stop`. Any process that can reach the agent's WS port can drive it. The target descriptor cheerfully carries a secret that is never used, so the configuration reads as secured while the wire is not.

**Fix:** make auth a mandatory step in `BaseTransport` (a template method the subclass cannot skip) rather than a helper each transport opts into. Send credentials on the WS upgrade request and sign each frame.

### 1.2 The management service returns every target's credentials, and fails open

`src/plugin.ts:94–113`

`find()`, `get()` and `remove()` all return raw `TargetDescriptor` objects, and `TargetDescriptor.auth` holds the live secret. Verified:

```json
find() -> [{"id":"provider:hetzner", … "auth":{"type":"bearer","token":"HETZNER-LIVE-TOKEN-xyz"}},
           {"id":"agent:srv-1",      … "auth":{"type":"hmac","secret":"AGENT-HMAC-SECRET-abc"}}]
```

One `GET /api/conduit/targets` enumerates every provider token and every agent HMAC secret in the system.

Worse, nothing enforces the auth the design assumes. `types.ts:151` carries the author's own note — `// TODO: review auth + path config before enabling in prod` — and the registered service has no hooks of its own:

```
keys on service def: name, find, get, remove | hooks present: false
```

The README shows attaching `authenticate()` as a follow-up snippet the developer must remember. `management: true` therefore **fails open**: forget the hook and the endpoint is public. This is finding §1.2 of the Junction v6 audit reproduced verbatim in a new package.

**Fix:** strip `auth` from all read paths unconditionally; require an explicit auth hook in the options and refuse to register the service without one (fail closed, loudly, at configure time).

### 1.3 HMAC signing is silently skipped whenever there is no body

`src/transports/base.ts:85–89`

```ts
if (rawBody === undefined) return {}
```

The comment frames this as GET-only, but `rawBody` is undefined for *any* request without a body. Verified against an `hmac` target:

| request                    | `X-Hub-Signature` sent |
| -------------------------- | ---------------------- |
| `POST /deploy` with body   | `sha256=2017c787…`     |
| `POST /reboot` **no body** | `null`                 |
| `GET /status`              | `null`                 |

`POST /reboot`, `POST /stop`, `DELETE /servers/42` — every bodyless command reaches the agent unsigned. If the agent enforces signatures these fail confusingly at runtime; if it doesn't, they are unauthenticated. Either way the caller gets no signal.

Separately, the scheme signs **only the body** — no timestamp, no nonce, no method or path binding. A captured signature replays forever, and against any path on that target. That is below the standard of care for a control plane (compare GitHub/Stripe webhook signing, which bind a timestamp).

**Fix:** always sign a canonical string of `method + path + timestamp + nonce + body-hash`; never emit an empty header set for an `hmac` target.

### 1.4 Caller-supplied headers override auth headers

`src/transports/http.ts:77–82`

```ts
headers: { 'Content-Type': …, …await this.buildAuthHeaders(rawBody), ...req.headers }
```

`req.headers` is spread **last**, so it wins. Verified — a target holding `REAL-TOKEN` sent:

```
Authorization actually sent: Bearer ATTACKER
```

The README documents `headers` as *"merged with auth headers"* without saying which side wins. Any code path where a caller's or a user's data reaches `req.headers` becomes credential substitution or auth stripping. The header precedence should be the inverse and non-negotiable.

### 1.5 The timeout does not cover the response body — unbounded hang and OOM vector

`src/transports/http.ts:87` (`clearTimeout(timer)` fires as soon as headers arrive), then `119` reads the body.

The `AbortController` is cancelled the instant response headers land, so the body read is entirely untimed. Verified against a server that sends headers then dribbles a body forever, with `timeout_ms: 1500`:

```
elapsed_ms: 6001 | STILL HANGING after 6s (timeout did not apply to body read)
```

It hangs indefinitely. There is also **no response size limit** anywhere — `res.json()` and `res.text()` buffer without bound. For a layer whose entire job is talking to third parties you do not control, a slow-loris or oversized response from any provider will hang a request forever or exhaust memory. This is the most dangerous finding after the auth ones, because it needs no attacker — a degraded provider is enough.

**Fix:** keep the abort signal live through body consumption, and cap response size.

### 1.6 The package does not install, and the test suite does not run, as shipped

```
$ bun install
error: GET https://registry.npmjs.org/@frontierjs%2fjunction - 404
error: @frontierjs/junction@* failed to resolve

$ bun test
error: Cannot find module '@frontierjs/junction' from '/src/plugin.ts'
0 pass · 1 fail
```

`devDependencies` pins `"@frontierjs/junction": "*"` against a package that is not published, with no lockfile and no workspace/`file:` link. `bun run typecheck` also fails — there is no `tsconfig.json` and `typescript` is not a dependency.

Related packaging defect: `peerDependenciesMeta` marks Junction **optional**, but `src/index.ts:6` re-exports `plugin.ts`, which imports Junction at module top level. Verified — importing the main barrel without Junction present hard-fails. The optional peer dependency is a fiction.

*(Everything below §1.6 was verified after stubbing the peer dep locally: 46 tests then pass in 38 ms.)*

---

## 2. High — correctness

### 2.1 Concurrent sends open one socket per call and leak the extras

`src/transports/websocket.ts:164–199` — `getConnection()` has no in-flight promise dedup.

Four concurrent `send()` calls before the connection is established, verified:

```
4 concurrent sends opened 4 server-side sockets (expected 1)
```

Each `open` handler runs `this.ws = ws` and `startPing(ws)`, so `this.ws` and `this.pingTimer` are overwritten and the three earlier sockets become untracked — still open on both ends, each with **an orphaned `setInterval` that is never cleared**, pinging forever. `destroy()` clears only the one timer it still has a handle on. This leaks a socket and a timer per concurrent burst, permanently, and keeps the event loop alive at shutdown.

**Fix:** memoise the in-flight connect promise; clear any prior ping timer before starting a new one.

### 2.2 A stream consumer hangs forever if the socket drops mid-stream

`src/transports/websocket.ts:187–195` — the `close` handler rejects `pending` but never touches `streamListeners`.

Verified with an agent that sends one chunk then closes without `stream_end`:

```
chunks received: ["line-1"]
CONSUMER STILL HANGING 4s after socket closed
```

The `for await` never terminates. There is no stream timeout and no close propagation, so any network blip during a log tail wedges the caller indefinitely.

**Fix:** on close, push a terminal event (ideally an error) to every live stream listener.

### 2.3 `stream()` silently yields nothing when the target is unreachable

`src/transports/websocket.ts:106–107` — `if (!ws) return`.

The README states `stream()` *"throws a `ConduitStreamError` if the stream cannot be established (target not found, **connection failed before first chunk**)"*. Verified against an unreachable target:

```
NO THROW — stream yielded 0 chunks and ended silently
```

"The agent is unreachable" is indistinguishable from "the agent had no logs". The core layer gets this right for `target_not_found` (`conduit.ts:91`); the transport contradicts it.

### 2.4 `send()` throws on non-serialisable bodies, contradicting the never-throw contract

`src/transports/http.ts:67–69` — `JSON.stringify(req.body)` sits **outside** the `try` block. Verified:

```
circular body → THREW: TypeError - JSON.stringify cannot serialize cyclic structures.
BigInt body   → THREW: TypeError - JSON.stringify cannot serialize BigInt.
```

The README's headline guarantee is *"`send()` never throws."* Callers written against that contract have no `try/catch`, so a `BigInt` id or a cyclic object anywhere in a payload takes down the calling request. Unguarded user hooks (`conduit.ts:44`) throw out of `send()` for the same reason.

### 2.5 A 200 response with a non-JSON body is misclassified and retried

`src/transports/http.ts:119` — `res.json()` throws into the generic `catch`, which returns `connection_failed { retryable: true }`.

Verified with a provider returning an HTML error page under HTTP 200:

```
elapsed_ms: 3505 | attempts: 4
error kind: connection_failed | retryable: true | msg: Failed to parse JSON
```

Captive portals, proxy interstitials and provider error pages are common in exactly this layer. The result is a wrong error kind (the connection succeeded fine), four pointless attempts, and 3.5 s burned. `Content-Type` is never checked.

### 2.6 Blind retries of non-idempotent commands

`src/transports/http.ts:29–48`

Retries are driven purely by `retryable`, with no regard for the HTTP method. A `POST /servers` to Hetzner that times out (or returns 500 after committing) is re-sent up to four times. No idempotency key is generated or supported. For a control plane whose documented workload is `deploy`, `create server`, `pull`, this risks duplicate infrastructure and duplicate deployments.

**Fix:** retry only idempotent methods by default; support a caller-supplied idempotency key for the rest.

### 2.7 A single `send()` can occupy a request for ~43.5 s — and there is no circuit breaker

Default `retry_limit: 3` means **four** attempts (`attempt <= retries`), each with its own 10 s timeout, plus `[0, 500, 1500, 1500]` ms of backoff — verified at 4 attempts and 3,506 ms of pure backoff. Worst case 43.5 s, and unbounded once §1.5 is in play. Backoff has no jitter, so N callers hitting a degraded provider retry in lockstep.

There is no circuit breaker, no bulkhead and no concurrency cap, so a provider outage produces 4× amplification against the failing dependency while pinning your own request handlers. Junction core ships a `circuitBreaker` hook; Conduit neither uses nor exposes one.

### 2.8 A 204 response produces `data: null` while typed as `T`

Verified: `error: null | data: null | status: 204`. The union claims `ConduitResponse<T>.data: T`, so the compiler lets you write `result.data.id` after the `if (result.error)` guard and you get a runtime null dereference on every successful `DELETE`. `res.json() as T` (`http.ts:119`) is an unchecked cast generally — no response validation of any kind, so a provider returning `{"error":…}` under HTTP 200 is typed and treated as success. Junction has a schema system; Conduit does not use it.

---

## 3. Medium — where the abstraction leaks

### 3.1 The Unix transport ignores auth, headers, and the method

`src/transports/unix.ts:27–66`. Verified — a `bearer` target with a custom header sent:

```json
{"url":"http://localhost/deploy","method":"POST","auth":null,"sig":null,"custom":null,
 "body":"{\"method\":\"deploy\",\"body\":{\"image\":\"v2\"}}"}
```

No credential, `X-Custom` dropped, verb forced to `POST`, and the payload re-wrapped into `{method, body}` — a completely different wire contract from HTTP for the identical `ConduitRequest`. `url` is also built as `` `http://localhost/${req.path ?? req.method}` `` (`unix.ts:33`), which double-slashes on a leading-slash path and otherwise falls back to using the *method* as the path. Error handling diverges too: it checks `TimeoutError` while `http.ts` checks `AbortError`.

### 3.2 `buildUrl` produces malformed URLs

`src/transports/http.ts:138–155`. A path that already carries a query string, plus a GET body, verified:

```
server saw URL: /servers?page=2?status=running
```

Two `?` — the second parameter is silently mangled. Relatedly, GET parameters can only be supplied via `body`, which is surprising, and `params.set` (not `append`) means array values cannot produce repeated keys. `ConduitRequest` has no `query` field; it should.

### 3.3 Unknown methods are silently coerced to POST

`src/transports/http.ts:161–164`. Verified: `method: 'logs'` against an HTTP target issued `POST /logs`. Deliberate, and documented — but it means a typo (`'GTE'`) silently becomes a POST. For a control plane, an unroutable method should be an error, not a guess.

### 3.4 `ConduitStore` is synchronous, which forecloses every networked registry

`src/types.ts:40–47` — `get(id): TargetDescriptor | null`, not `Promise<…>`.

`IConduit.resolve()`/`list()` are async and the store is presented as the pluggable backend, but the synchronous signature makes Redis, Postgres or any HTTP-backed registry **impossible to implement**. The two shipped stores are in-memory and SQLite, both single-node. Conduit is therefore effectively single-instance for dynamically registered agents: run two Hub replicas and an agent that registers against one is invisible to the other. That is a significant constraint to discover after adoption, and it is not mentioned in the README.

Knock-on: `stats()` calls `store.list()` (`conduit.ts:118`), so every `/metrics` scrape does a full table scan and a `JSON.parse` per row, deserialising every secret into memory — while the interface comment advertises it as a cheap *"synchronous snapshot"*.

### 3.5 Stores return live references

`src/stores/memory.ts:18–20, 35–37`. Verified:

```
after mutating the returned object, store now holds secret = MUTATED
list() returns same object identity as get(): true
```

Any consumer can mutate the registry by accident, and the management service hands live secret-bearing objects to the response serializer. This is the same by-reference hazard flagged as §1.1 of the Junction v6 audit. Clone on read.

### 3.6 `destroy()` does not stick

`conduit.ts:130–132` only calls `router.evictAll()`; there is no `destroyed` flag. Verified — after `await c.destroy()`, a subsequent `send()` rebuilt the transport and made a real outbound call. Since the plugin wires `destroy()` to `shutdown()`, a late in-flight request during `app.stop()` can open fresh sockets after shutdown. Individual `WebSocketTransport` instances handle this correctly (§E of the repro); the conduit itself does not.

Also, secrets are persisted to SQLite in plaintext (`stores/sqlite.ts:54`), and there is no credential-rotation path short of re-`register()`ing a full descriptor.

---

## 4. Observability

The `/metrics` wiring exists but exposes almost nothing you would want at 3 a.m.

- **`stats()` returns target counts only** — verified: `{"targets":{"total":2,"byKind":{…},"byProtocol":{…}}}`. No request counts, error rates, latency, retry counts, or per-target health. For an outbound integration layer these are the primary signals.
- **`duration_ms` is `0` on every error** (`base.ts:56`) and, on success, measures only the *last* attempt (`http.ts:58`, timer created per attempt). Verified: a 3.5 s four-attempt failure reported `duration_ms: 0`. Latency telemetry is unusable for exactly the requests you care about.
- **Hooks are sync-only, unguarded, and incomplete** — `(req) => void` cannot export a span; a throwing hook takes down `send()`; there is no `onRetry`, so retries are invisible; and `stream()` fires only `onRequest`, never response, error or completion.
- **No correlation or trace context** is propagated to targets. Nothing ties a Hub request to the agent call it produced.

`register()` reaches into `app._metricsProviders` behind an `instanceof Map` guard (`plugin.ts:47`) — the same private-field reach-in the Junction audit flagged in §6. If Junction renames the field, metrics silently disappear with no error.

---

## 5. Testing story

Measured coverage (`bun test --coverage`), after stubbing the peer dep:

| File                                | % Funcs          | % Lines   |
| ----------------------------------- | ---------------- | --------- |
| `stores/memory.ts`                  | 100.00           | 100.00    |
| `testing.ts`                        | 100.00           | 100.00    |
| `conduit.ts`                        | 100.00           | 97.62     |
| `transports/stub.ts`                | 83.33            | 74.07     |
| `router.ts`                         | 80.00            | 59.18     |
| `plugin.ts`                         | 77.78            | 40.43     |
| **`transports/base.ts`**            | **40.00**        | **18.75** |
| **`transports/not_implemented.ts`** | **0.00**         | **12.50** |
| **`transports/unix.ts`**            | **0.00**         | **5.66**  |
| **`transports/websocket.ts`**       | **0.00**         | **4.46**  |
| **`transports/http.ts`**            | **0.00**         | **4.35**  |
| `stores/sqlite.ts`                  | *never imported* | —         |
| **All files**                       | **56.76**        | **51.42** |

**The 46 tests cover the plumbing and none of the risk.** Every network-touching line is untested. `buildAuthHeaders` — the security-critical HMAC path — is inside the uncovered 81% of `base.ts`. The SQLite store never loads. Every blocker in §1 and every finding in §2 lives in the 0%-covered files, which is precisely why they survived to this audit.

Three structural problems make that hard to fix with the shipped tooling:

- **`StubTransport` cannot simulate failure.** There is no `mockError()`, no status control on failure paths, no delay. The retry logic, the error taxonomy and the timeout behaviour — the things most likely to be wrong — are untestable with the provided double.
- **Stubs bypass the store entirely** (`router.ts:29–30`), so `resolve()`, `list()` and `stats()` return empty for stubbed targets. The test at `conduit.test.ts:230–247` **asserts this as correct behaviour** (`expect(provider).toBeNull()`), enshrining the divergence. You cannot integration-test any code that calls `send()` alongside `resolve()`.
- **Mocks are keyed on path only** (`stub.ts:73`), so `GET /servers/42` and `DELETE /servers/42` are indistinguishable.

`createTestConduit` also accepts only `hooks` (`testing.ts:43`), so there is no way to mix stubbed and real targets or to test with `opts.targets`.

---

## 6. Packaging & hygiene

- **Does not install; no lockfile** (§1.6). `"@frontierjs/junction": "*"` is unresolvable and unpinned.
- **`typecheck` fails** — no `tsconfig.json`, `typescript` not a dependency. Both shipped scripts are effectively broken.
- **Optional peer dependency is not optional** (§1.6) — the barrel hard-requires Junction.
- **Test doubles ship in the production entry point.** Verified: `import('src/index.ts')` exposes `StubTransport` and `createTestConduit`, despite `testing.ts:4` instructing consumers to import from `/testing`. `index.ts:9–15` also re-exports `createSQLiteStore` as a value, so the barrel pulls in `bun:sqlite` for everyone.
- **`declare module` makes `app.conduit` non-optional** on every Junction `App` project-wide (`plugin.ts:25–29`). Any project that has the package installed but not configured gets a type that claims `app.conduit` exists while it is `undefined` at runtime. It should be `conduit?: IConduit`.
- **The plugin factory creates one shared instance** (`plugin.ts:36`), so reusing a plugin object across two apps silently shares state. `boot()` also calls `app.conduit.init()` rather than `instance.init()`, so it initialises whatever was attached last.
- **`init()` re-applies `opts.targets` on every boot**, overwriting `last_seen_at` for static targets and wiping heartbeat state on restart.
- **README drift** — the file layout tree (`README.md:371–390`) shows `conduit/index.ts`; the actual tree is `src/index.ts`, and `package.json` is omitted. Same drift pattern as Junction §9.
- **Missing:** `files` field, `.gitignore`, `.npmignore`, LICENSE text (MIT is declared), CI config, `bin`/build step. Exports point at raw `.ts`, so the package is Bun-only for consumers — defensible given `engines.bun`, but the README never says so.

---

## 7. What is genuinely good

Worth protecting through the fixes:

- The **named-target model**. Credentials and addressing live in one registry, call sites stay clean, and swapping a provider endpoint touches one descriptor.
- The **discriminated-union result type**. `ConduitResult<T>` narrows correctly and the never-throw intent is right (it just needs §2.4 fixed to actually hold).
- **Plugin lifecycle discipline.** Sync work in `register()`, async in `boot()`, cleanup in `shutdown()`, with comments explaining why — cleaner than several first-party Junction plugins.
- **`NotImplementedTransport`.** Typed-but-unbuilt protocols fail immediately with a clear message instead of no-oping. Small thing, done right.
- **Store upsert preserves `registered_at`** consistently across both backends, and it is tested.
- **`ConduitStreamError` carrying structured detail** is a good pattern for the one place the API must throw.
- The **hook surface and `stats()` seam** are the right shapes — they are just underpopulated (§4), which is an additive fix.

---

## 8. Hypotheses tested and discarded

Recorded so they are not re-litigated:

- **204 / empty bodies do not break `res.json()` on Bun** — it returns `null` rather than throwing, so no spurious retry. (The *typing* is still wrong — §2.8 — and this would throw on Node/undici, so it remains a portability landmine.)
- **`Router.evictAll()` mutating the pool while iterating `keys()` is safe** — JS Map iterators tolerate deletion of the current entry.
- **`WebSocketTransport.destroy()` correctly blocks reuse** — a post-destroy `send()` returns `connection_failed`. Only the conduit-level `destroy()` is leaky (§3.6).
- **The stream buffer/notify handshake in `websocket.ts:129–144` has no lost-wakeup race** — the synchronous check-then-assign is sound. Its problem is missing termination (§2.2), not the handshake.
- **`registered_at` preservation on upsert works** in both stores, as documented.

---

## 9. Prioritized recommendations

**P0 — before any production use**

1. Move auth into `BaseTransport` as a mandatory, non-skippable step; implement it for WebSocket and Unix (§1.1, §3.1).
2. Strip `auth` from every management read path; refuse to register the service without an explicit auth hook (§1.2).
3. Always sign `hmac` targets, over a canonical `method + path + timestamp + nonce + body-hash` (§1.3).
4. Invert header precedence so auth headers always win (§1.4).
5. Keep the abort signal live through the body read and cap response size (§1.5).
6. Make the package install and test: vendor or publish Junction, add a lockfile and a `tsconfig.json` (§1.6).

**P1 — correctness**

Dedup the in-flight WS connect and clear stale ping timers (§2.1); propagate socket close to stream listeners (§2.2); throw `ConduitStreamError` on WS connect failure (§2.3); move body serialisation inside the `try` and guard hook invocations (§2.4); check `Content-Type` and classify parse failures as non-retryable `server_error` (§2.5); restrict retries to idempotent methods and add idempotency keys (§2.6); add jitter, a total-deadline budget and a circuit breaker (§2.7).

**P2 — close the test gap**

Add `mockError()`/status/delay to `StubTransport`; make stubs register into the store so `resolve()`/`list()`/`stats()` behave (and delete the test that enshrines the current divergence); key mocks on method + path; then write the transport tests — HTTP retry and status mapping, HMAC vectors, WS reconnect and framing, the SQLite store. Target the 0%-covered files first; that is where every §1 and §2 finding lives.

**P3 — architecture**

Decide on the store interface: make `ConduitStore` async so a shared registry is possible, or document Conduit as single-node explicitly (§3.4). Clone descriptors on read (§3.5). Add a `query` field to `ConduitRequest` and fix `buildUrl` (§3.2). Reject unknown methods instead of coercing (§3.3). Add a `destroyed` flag to the conduit (§3.6). Consider separating secret material from target metadata — a credential resolver fetched at send time would remove secrets from the registry, the hooks, `stats()` and the management surface in one move.

**P4 — observability & hygiene**

Populate `stats()` with request/error/latency/retry counters; fix `duration_ms` to measure total elapsed including failures; add `onRetry`, stream lifecycle hooks and async hook support; propagate trace context (§4). Then: make `app.conduit` optional in the module augmentation, move test doubles out of the production barrel, fix the README layout tree, and add `files`, `.gitignore`, LICENSE and CI (§6).