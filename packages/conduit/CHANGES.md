# Changes — @frontierjs/conduit

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
