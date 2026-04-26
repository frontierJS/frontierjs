# Why Litestone

There are good ORMs already. Here's why you'd choose Litestone specifically.

## Why SQLite for production?

SQLite gets dismissed as a "dev database." That reputation is outdated.

SQLite runs inside your process — no network hop, no connection pool, no serialization overhead. A query that hits Postgres in 2ms hits SQLite in 0.05ms. For most applications, the bottleneck isn't SQLite throughput, it's everything else.

The tradeoffs are real but manageable:

- **Single writer** — WAL mode + Litestone's dual read/write connections handle this. Reads and writes never block each other. Writes serialize naturally; for most web apps the write rate is low enough that this is never the bottleneck.
- **No horizontal scaling** — true. SQLite is one file, one machine. This is a constraint, but it's also why you have zero ops: no cluster, no replication lag, no split-brain. Litestream handles disaster recovery.
- **Backup complexity** — solved. `db.$backup()` is a single hot-backup call. Litestream streams WAL frames to S3 continuously.

SQLite is what Basecamp, Notion's early years, Shopify's single-store mode, and countless SaaS apps used to get to millions of users. The question isn't "can SQLite handle my app" — it's "what happens when I outgrow it." The answer is: you migrate. Most apps never get there.

If you need horizontal write scaling, multi-region replication, or Postgres-specific features (JSONB indexes, advanced CTEs, pg_vector), use Postgres. Litestone is not for those cases.

## Why Bun?

Bun has a native SQLite driver built in — `bun:sqlite`. It's significantly faster than `better-sqlite3` (Node's best SQLite driver) because it's implemented in Zig and runs synchronously inside the JS thread without going through libuv. No native addon compilation, no platform binary, no WASM.

Litestone uses Bun's native SQLite directly. This is why it has zero npm dependencies. A Litestone project installs in under a second.

Bun also has fast test runner, native TypeScript, native `.env`, and a built-in bundler. The whole toolchain is faster.

If you're on Node, use Prisma or Drizzle. They're great. Litestone is specifically built for Bun.

## Why schema-first?

Litestone's `.lite` schema is the single source of truth. DDL, migrations, TypeScript types, JSON Schema, Studio UI, test factories — all derived from it automatically.

The alternative (schema-as-code, Drizzle's approach) is excellent when you want full TypeScript inference and close-to-SQL control. It's a better fit when you have a complex existing SQL schema you want to express precisely.

Schema-first is better when:
- You want the schema to be readable by non-engineers (design review, audits)
- You want a visual ER diagram without extra tooling
- You want the schema to drive code generation beyond TypeScript (JSON Schema, form validation, API docs)
- You prefer a declarative DSL over TypeScript imports for model definitions

## Why zero dependencies?

Every npm dependency is a supply-chain risk, a breakage surface, and a source of version conflicts. Litestone ships one package that does everything: schema parsing, migrations, queries, encryption, file storage, FTS, access control.

There's no Rust binary to compile on your CI machine. No WASM bundle adding 500kb to your lambda. No `node_modules/prisma/query-engine-darwin-arm64` file that doesn't exist on Linux.

`bun add @frontierjs/litestone` — one package, runs immediately.

## Why row-level policies as SQL?

Most ORMs that have access control implement it in JavaScript: fetch the rows, filter them in the app layer. This has a serious failure mode — if you forget to apply the filter, you expose data. The filter is opt-in, not structural.

Litestone's `@@allow` and `@@deny` compile to SQL `WHERE` clauses at query time. The filter is injected into the SQL before it hits SQLite. If you're using a scoped client (`db.$setAuth(user)`), there is no path to unfilterd data except `asSystem()`, which is explicit. Forgetting to filter is not possible.

This is the same design as ZenStack (which is built on top of Prisma) — but it's built into Litestone natively, with no separate layer.

## When to choose something else

- **You need Postgres, MySQL, or multi-database** — use Drizzle or Prisma
- **You want auto-generated tRPC/REST APIs from your schema** — use ZenStack
- **You're on Node (not Bun)** — use Drizzle or Prisma
- **You need Prisma Accelerate (managed connection pooling + edge caching)** — use Prisma
- **You want the largest ecosystem and most tutorials** — use Prisma
- **Your team knows SQL and wants to stay close to it** — Drizzle is excellent
