# conduit-zapier — state

**New, Tier B, drive green: 17 rows against the sink.** 2026-10-26. Sink-only: Zapier is hosted and no test Zap exists here.

- Built on the owner's override of `IDEAS/conduit-connectors.md`'s "Zapier — not a connector" row, the same path as n8n's (`FJS-D1489`); `FJS-D1528` holds the decision-rules run and its reshaping: the run refused a host-pinned target and `parseHookUrl` (restating Zapier's path grammar) and sent the package onto slack's incoming-webhook shape, which is what was built.
- Conforms to `CONTRACT.md`; no amendment. C6's "no read exists" is slack's amendment; C9's local refusals are the URL's shape and the payload's size; C4's validator refuses a 200 whose `status` is not `success`.
- Callers: none at runtime yet. maid.tech's `Form.svelte` and ELA's `Integrations.svelte` post form responses to pasted hook URLs with a raw `fetch` and are the first two adopters when their ports reach that field; maid.tech's `third-party/zapier/` is a Zapier CLI integration (one action, *Submit to Form*) and stays one — Zapier calls the app's API, which is junction's.
- Unverified against Zapier: the receipt body's fields; that a URL without its trailing slash is taken; what a 404 or 410 body says; what a reverse unsubscribe answers.
- Not built: the Actions API (partner contract), the Partner/Workflow API, Zapier MCP (an MCP client, not a target).
- AI Actions, which Zapier MCP replaced, was sunset 2026-05-29; the README names it as a surface this package does not cover.
- FJS filed: none.
