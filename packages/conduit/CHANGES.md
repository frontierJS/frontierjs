# Changes — @frontierjs/conduit

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
