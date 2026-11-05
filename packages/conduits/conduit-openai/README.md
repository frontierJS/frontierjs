# @frontierjs/conduit-openai

The OpenAI chat-completions PROTOCOL over `@frontierjs/conduit` (`FJS-D889`):
chat, embeddings, models, a tool loop, and SSE streaming. One target per
IMPLEMENTATION — OpenAI, Ollama, llama.cpp, Groq, vLLM — from one builder. New.

## What it covers

| Piece | Where |
| --- | --- |
| target builder | `openaiTarget({ name, ref?, address?, headers?, timeoutMs? })` — `provider:openai:<name>`, bearer, JSON, address WITHOUT `/v1` |
| calls | `chatCompletion` (unkeyed, unreplayable: billed per request), `embeddings` (`replayable`: deterministic, cheap), `listModels`, `runToolLoop(send, req, tools, { maxTurns })` |
| streaming | `streamChatCompletion(bindStream(conduit, id), req)` + `assemble(chunks)` — the protocol's chunks through `conduit.stream()` (`FJS-D934`) |
| error mapping | `translate(error, status)` reads BOTH dialects: OpenAI's `{ error: { message, type, code } }` and Ollama/llama.cpp's bare `{ error: "sentence" }` — the protocol-vs-vendor point |
| sink | `sink.ts` speaks both dialects (`{ ollamaErrors: true }` switches), streams real SSE |
| drive | `bun run drive` — 23 rows, sink only; `FIXTURE_URL` adds the protocol rows against a real server |
| fixtures | Ollama and llama.cpp, `test/fixture/README.md` — **unproved here** (not installed, no model download) |

## Errors

| vendor | HTTP | conduit kind | `OpenAIFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `invalid_request_error` | 400 | `client_error` | `refused` | no |
| `context_length_exceeded` | 400 | `client_error` | `too_long` | no |
| `invalid_api_key` | 401 | `auth_failed` | `auth_failed` | no |
| `model_not_found` / Ollama "not found" | 404 | `client_error` | `model_gone` | no |
| `insufficient_quota` | 429, no header | `rate_limited` | `quota` | no |
| `rate_limit_exceeded` | 429 | `rate_limited` | `rate_limited` + `retryAfterMs` | by the caller (chat); conduit (embeddings) |
| 500 / 503 | 5xx | `server_error` | `server_error` | chat: no, indeterminate |
| stream closes without `[DONE]` or dies | — | — | `stream_error` after what arrived | no |
| tool loop over `maxTurns` | — | — | `turn_limit`, resumable | — |

A vendor's extension (OpenAI `response_format`, Ollama `options`) rides
`extra` and is the app's (`FJS-D889`); an `extra` key that is a protocol field
(`stream`, `model`, `tools`) is refused before the send.
