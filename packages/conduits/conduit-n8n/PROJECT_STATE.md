# conduit-n8n — state

**New, Tier B, drive green: 52 rows against the sink, 72 with a real n8n (2.44.6 in docker, `test/fixture/start.sh`).** 2026-10-23.

- Built on the owner's override of `IDEAS/conduit-connectors.md`'s "not a connector" row — `FJS-D1489` holds what the decision-rules run found and why it was overridden.
- Conforms to `CONTRACT.md`; no amendment. `unpublishing` is C3's *not now* case with a wait the connector names, since the vendor names none.
- Found against the real thing, not in n8n's docs: `activate` is idempotent (so `replayable`); a delete right after a deactivate is refused with 409 "still being unpublished"; a webhook registers a beat after `activate` answers; a second stop is a 409, so `stopExecution` is not replayable; a tag name over 24 characters is refused as "Tag already exists"; a several-tag filter matches workflows carrying every tag named (2026-10-27); the `no_trigger` and `not_registered` sentences the sink answers are verbatim.
- Batch A built 2026-10-23: `waitForExecution`, `stopExecution`, `retryExecution`, the six tag calls, hook Basic Auth. No CONTRACT amendment; `conflict` is the Cloudflare connector's kind.
- Not built: Webhook node JWT auth, credentials/users/variables/projects endpoints, archive/publish/versions, audit, execution tags.
- Callers: none at runtime. Intake's `tools/n8n-deploy.mjs` (fjs-prototypes) is a deploy tool over the same API and stays a script; adopting the connector there is not owed.
- FJS filed: none.
