# Changes — @frontierjs/conduit

## 2026-08-19 — the HMAC scheme has one owner (`FJS-349`)

193 tests, 0 fail.

`buildAuthHeaders`'s `hmac` branch built the canonical string, hashed the body
and named the three headers itself. It now calls `signRequest` from
`@frontierjs/toolbelt/signature`; the string on the wire is byte-identical, and
a spec in toolbelt pins that.

The reason is the other end. **Signing with no verifier reads as a scheme being
enforced**: basecamp's three Outpost endpoints took no credential at all while
every outbound call to an Outpost was signed. A receiver has to recompute this
exact string, and two implementations of one string is how it ends up not
being the same string.


## 2026-08-16 — `hooks:` is `observers:` (`FJS-287`, `FJS-D06` §1)

193/193 tests pass, junction integration included; `example`: `verify:notify`
green, so the rename was proven over a real outbound send and not only in types.

Nothing in this option could ever change a request, suppress an error or halt a
send — `safe()` catches a throw and drops a rejection precisely so a failed
metrics export is not a failed deployment. That is the **Observer** tier, and it
was wearing the Hook name. `ConduitHooks` → `ConduitObservers`, `HookResult` →
`ObserverResult`, `createTestConduit({ hooks })` → `{ observers }`.

Breaking for anyone who set it, with no alias: pre-alpha, and the two callers
are basecamp and this package's own suite. Basecamp is where the change proved
itself — its typecheck went red on the now-excess `hooks` property and green
again on the rename, which is what says an app cannot miss this silently.

**`management.hooks` keeps the word on purpose.** That one IS Junction's hook
pipeline: it runs before the management routes and can refuse the call. Two
options, two tiers, two words — where before one word covered both.

## 2026-08-16 — the metrics reach-in is a declared seam (`FJS-D06`)

193/193 tests pass, junction integration included.

`register()` used to write into `app._metricsProviders` behind an
`instanceof Map` guard — the private-field reach-in this package's own
`docs/AUDIT.md` flagged, with the exact failure named: *if Junction renames the
field, metrics silently disappear with no error*. It is now
`app.registerMetricsSource('conduit', …)`, and it is called **unguarded on
purpose**. This plugin imports Junction's `App` type, so a seam that is not
there is a compile error rather than a number that quietly stops being reported.

`app.provide('conduit', …)` is `app.claim('conduit', …)` for the same ruling:
a Provider is now a third party the app speaks to, which conduit already
believed — `'provider'` has been one of its target kinds all along.


## 2026-08-13 — `TargetKind`'s `'agent'` member is now `'outpost'`

`FJS-D29` retires *agent* for infrastructure across the repo, because the word
already meant two things here and one of them is going to be an AI. Conduit is
affected beyond prose: **`testing.ts` derives a target's kind from its id prefix**
(`agent:` → `'agent'`), so a caller that renamed its ids without renaming the union
would have had every target graded as the wrong kind, silently.

Breaking for anything constructing `kind: 'agent'` — which is Basecamp, renamed the
same day. 193/193 tests pass, junction integration included.

## 2026-08-08 — a non-JSON response is not a broken target

The HTTP transport refused every content type that was not JSON. The check was
written for one real case — a 200 carrying HTML is a captive portal, a proxy
interstitial or a provider error page — but spelled as "not JSON", which is a
far wider net: **a Slack incoming webhook answers `200 text/plain: ok`**, so
`app.conduit.send()` reported a `server_error` for a notification that had
already been delivered.

Now only markup fails — `text/html`, `application/xhtml+xml`. Anything else
non-JSON comes back as the text it is. A response with no content-type at all
and a body that does not parse is still a failure: nothing said what it was.

Found wiring basecamp's notification channels through the outbound boundary,
where the test delivery arrived at the sink and was reported as an error.
1 test; 193 pass.
