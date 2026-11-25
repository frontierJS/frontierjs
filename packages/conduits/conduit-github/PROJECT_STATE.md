# conduit-github — state

**Extracted, sink-only, drive green (57 rows).** 2026-11-25. Held out of releases.

- Plan: `IDEAS/conduit-github.md`. Phases 1–3 built. Phase 4 built: Basecamp's `providers/source/github.ts` is an adapter over this package, `plugins/git-push.ts` verifies through it, and its own sink is deleted. Basecamp's browser drive of connect and Import from repository has not run (`FJS-4467`).
- First caller: basecamp `providers/source/github.ts` and `plugins/git-push.ts` `forgeDialect`.
- Drive green against: the sink. Fixture: none.
- **Unmeasured:** the missing-grant 403 (plan step 0.3). The sink answers it from GitHub's documented shape: 403, `x-ratelimit-remaining` above 0, message `Resource not accessible by personal access token`. The primary-limit 403 is shaped as measured on 2026-11-25.
- `translate` takes `(error, status?, headers?, { grant?, now? })`, C3's spelling, and answers `retryAfterMs`, as the sibling connectors do; the plan wrote `translate(error, meta)`.
- `verifyGithubSignature` is C8's spelling; the plan wrote `verifySignature`, which `ws:exports` refuses as a name conduit-oidc already exports. No clock: the scheme has no timestamp.
- Not built: `listAll` with `Link` paging and ETags, `advisories()` (`FJS-D2369`, waits for a runtime caller).
- FJS filed: none.
