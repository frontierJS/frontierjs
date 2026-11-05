# Fixtures — two conforming servers (FJS-D889)

Neither is installed on the machine this was written on, and no model
download was permitted, so the fixture rows are **unproved**. Start one, then:

```sh
# Ollama
ollama serve &
ollama pull qwen2.5:0.5b
FIXTURE_URL=http://127.0.0.1:11434 FIXTURE_MODEL=qwen2.5:0.5b bun run drive

# llama.cpp — one binary, one GGUF
llama-server -m qwen2.5-0.5b-instruct-q4_k_m.gguf --port 8080 --embeddings &
FIXTURE_URL=http://127.0.0.1:8080 FIXTURE_MODEL=qwen2.5-0.5b bun run drive
```

`FIXTURE_KEY` is optional; both servers ignore the bearer and conduit still
needs a ref that resolves, so the drive hands them a dummy.
