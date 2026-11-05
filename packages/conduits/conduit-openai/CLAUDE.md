# conduit-openai — package map

`src/index.ts` target, calls, tool loop, `streamChatCompletion` (through `conduit.stream()`), `assemble` · `src/errors.ts` the one reader of `raw`, two dialects · `src/types.ts` · `sink.ts` · `test/openai.drive.ts` · `test/fixture/README.md`.

## What bites

- **The target carries its own 120 s timeout**, which overrides the conduit-wide one; a drive passes `timeoutMs`.
- **There is no `fetch` in the package.** `streamChatCompletion` takes `bindStream(conduit, id)`; a refusal before the first chunk is a `ConduitStreamError` whose `meta.status` goes to `translate()` (`FJS-D934`), and `stream.crossesTheSeam` counts conduit's `streams.opened`.
- **`translate` reads two error dialects.** A refusal that fits neither is `refused` with the vendor's sentence.
- **`embeddings` is replayable; `chatCompletion` never is.** The mutation check: making chat replayable fails the 429 and 5xx rows.

## Proving a change

`bun run drive` (sink). Fixtures: Ollama and llama.cpp, both unproved here.
