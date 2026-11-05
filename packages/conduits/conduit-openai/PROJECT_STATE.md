# conduit-openai — state

**New, sink-only, drive green (23 rows). Fixtures UNPROVED.** 2026-10-11.

- Built by a sub-agent that was cut off by a rate limit after the drive; the drive's two leftover defects (a `for` over an async iterable; the target's 120 s timeout overriding the drive's) were fixed by the orchestrator, and the docs written then.
- Drive green against: the sink. **Not run against Ollama or llama.cpp** — neither installed, no model download. `FJS-D889` needs two; both are wired (`FIXTURE_URL`).
- Streaming runs through `conduit.stream()` (`FJS-2728` closed, `FJS-D934`). Conforms to `CONTRACT.md` otherwise; C1 (one target per implementation).
- FJS filed: none new (`FJS-2728` filed from anthropic covers it).
