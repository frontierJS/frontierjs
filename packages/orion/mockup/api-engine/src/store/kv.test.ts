import { describe, test, expect, beforeAll } from "vitest"
import { KVStore }      from "./kv"
import { WaitRegistry } from "./wait"
import { createSqlJsDatabase, runMigrations } from "./db"
import type { IDatabase } from "./db"

let db: IDatabase

beforeAll(async () => {
  db = await createSqlJsDatabase()
  runMigrations(db)
})

// ─────────────────────────────────────────────
// KV STORE
// ─────────────────────────────────────────────

describe("KVStore — workspace scope", () => {
  test("set and get a value", () => {
    const kv = new KVStore(db)
    kv.set("ws1", "workspace", "foo", 42)
    expect(kv.get("ws1", "workspace", "foo")).toBe(42)
  })

  test("returns undefined for missing key", () => {
    const kv = new KVStore(db)
    expect(kv.get("ws1", "workspace", "no-such-key")).toBeUndefined()
  })

  test("overwrites existing value", () => {
    const kv = new KVStore(db)
    kv.set("ws1", "workspace", "overwrite-me", "first")
    kv.set("ws1", "workspace", "overwrite-me", "second")
    expect(kv.get("ws1", "workspace", "overwrite-me")).toBe("second")
  })

  test("stores complex objects", () => {
    const kv  = new KVStore(db)
    const val = { name: "Alice", scores: [1, 2, 3] }
    kv.set("ws1", "workspace", "user", val)
    expect(kv.get("ws1", "workspace", "user")).toEqual(val)
  })

  test("workspace cache loaded once — subsequent instance reads from DB", () => {
    const kv1 = new KVStore(db)
    kv1.set("ws-cache", "workspace", "cached", "yes")
    // new instance — must load from DB
    const kv2 = new KVStore(db)
    expect(kv2.get("ws-cache", "workspace", "cached")).toBe("yes")
  })

  test("delete removes key", () => {
    const kv = new KVStore(db)
    kv.set("ws1", "workspace", "del-me", "bye")
    expect(kv.delete("ws1", "workspace", "del-me")).toBe(true)
    expect(kv.get("ws1", "workspace", "del-me")).toBeUndefined()
  })

  test("delete returns false for nonexistent key", () => {
    const kv = new KVStore(db)
    expect(kv.delete("ws1", "workspace", "ghost")).toBe(false)
  })

  test("TTL: expired key returns undefined", async () => {
    const kv = new KVStore(db)
    kv.set("ws1", "workspace", "ttl-key", "expires", 10)
    await new Promise(r => setTimeout(r, 30))
    expect(kv.get("ws1", "workspace", "ttl-key")).toBeUndefined()
  })

  test("TTL: non-expired key still accessible", async () => {
    const kv = new KVStore(db)
    kv.set("ws1", "workspace", "long-ttl", "alive", 60_000)
    await new Promise(r => setTimeout(r, 5))
    expect(kv.get("ws1", "workspace", "long-ttl")).toBe("alive")
  })

  test("workspaces are isolated", () => {
    const kv = new KVStore(db)
    kv.set("ws-A", "workspace", "shared-key", "from-A")
    kv.set("ws-B", "workspace", "shared-key", "from-B")
    expect(kv.get("ws-A", "workspace", "shared-key")).toBe("from-A")
    expect(kv.get("ws-B", "workspace", "shared-key")).toBe("from-B")
  })
})

describe("KVStore — execution scope", () => {
  test("execution scope bypasses workspace cache", () => {
    const kv = new KVStore(db)
    kv.set("ws1", "exec-123", "step", "result")
    expect(kv.get("ws1", "exec-123", "step")).toBe("result")
  })

  test("execution scopes are isolated", () => {
    const kv = new KVStore(db)
    kv.set("ws1", "exec-A", "x", "alpha")
    kv.set("ws1", "exec-B", "x", "beta")
    expect(kv.get("ws1", "exec-A", "x")).toBe("alpha")
    expect(kv.get("ws1", "exec-B", "x")).toBe("beta")
  })

  test("deleteExecutionScope removes all keys for that execution", () => {
    const kv = new KVStore(db)
    kv.set("ws1", "exec-cleanup", "a", 1)
    kv.set("ws1", "exec-cleanup", "b", 2)
    kv.deleteExecutionScope("ws1", "exec-cleanup")
    expect(kv.get("ws1", "exec-cleanup", "a")).toBeUndefined()
    expect(kv.get("ws1", "exec-cleanup", "b")).toBeUndefined()
  })
})

describe("KVStore — purgeExpired", () => {
  test("purges expired keys and returns count", async () => {
    const kv = new KVStore(db)
    kv.set("ws-purge", "workspace", "p1", "x", 10)
    kv.set("ws-purge", "workspace", "p2", "y", 10)
    kv.set("ws-purge", "workspace", "p3", "z", 60_000)
    await new Promise(r => setTimeout(r, 30))
    const count = kv.purgeExpired()
    expect(count).toBeGreaterThanOrEqual(2)
    expect(kv.get("ws-purge", "workspace", "p3")).toBe("z")
  })
})

// ─────────────────────────────────────────────
// WAIT REGISTRY
// ─────────────────────────────────────────────

describe("WaitRegistry", () => {
  test("register and getByKey", () => {
    const reg = new WaitRegistry(db)
    reg.register({
      resumeKey:    "key-abc",
      executionId:  "exec-1",
      flowId:       "flow-1",
      nodeId:       "wait-1",
      resumeCtxKey: "resumePayload",
      timeoutAt:    null,
      createdAt:    Date.now(),
    })
    const entry = reg.getByKey("key-abc")
    expect(entry).toBeDefined()
    expect(entry?.executionId).toBe("exec-1")
    expect(entry?.flowId).toBe("flow-1")
    expect(entry?.resumeCtxKey).toBe("resumePayload")
    expect(entry?.timeoutAt).toBeNull()
  })

  test("getByKey returns undefined for unknown key", () => {
    const reg = new WaitRegistry(db)
    expect(reg.getByKey("no-such-key")).toBeUndefined()
  })

  test("getByExecution returns entry for execution", () => {
    const reg = new WaitRegistry(db)
    reg.register({
      resumeKey: "key-exec", executionId: "exec-by-id",
      flowId: "f1", nodeId: "n1", resumeCtxKey: "payload",
      timeoutAt: null, createdAt: Date.now(),
    })
    const entry = reg.getByExecution("exec-by-id")
    expect(entry).toBeDefined()
    expect(entry?.resumeKey).toBe("key-exec")
  })

  test("getByExecution returns undefined for unknown execution", () => {
    const reg = new WaitRegistry(db)
    expect(reg.getByExecution("not-waiting")).toBeUndefined()
  })

  test("consume deletes the entry", () => {
    const reg = new WaitRegistry(db)
    reg.register({
      resumeKey: "key-consume", executionId: "exec-consume",
      flowId: "f1", nodeId: "n1", resumeCtxKey: "p",
      timeoutAt: null, createdAt: Date.now(),
    })
    reg.consume("key-consume")
    expect(reg.getByKey("key-consume")).toBeUndefined()
  })

  test("getExpired returns timed-out entries", async () => {
    const reg = new WaitRegistry(db)
    const past = Date.now() - 100
    reg.register({
      resumeKey: "key-expired", executionId: "exec-expired",
      flowId: "f1", nodeId: "n1", resumeCtxKey: "p",
      timeoutAt: past, createdAt: Date.now() - 200,
    })
    const expired = reg.getExpired()
    expect(expired.some(e => e.resumeKey === "key-expired")).toBe(true)
  })

  test("deleteExpired removes timed-out entries and returns count", async () => {
    const reg = new WaitRegistry(db)
    reg.register({
      resumeKey: "key-del-exp", executionId: "exec-del-exp",
      flowId: "f1", nodeId: "n1", resumeCtxKey: "p",
      timeoutAt: Date.now() - 50, createdAt: Date.now() - 100,
    })
    const count = reg.deleteExpired()
    expect(count).toBeGreaterThanOrEqual(1)
    expect(reg.getByKey("key-del-exp")).toBeUndefined()
  })

  test("non-expired entries are not deleted by deleteExpired", () => {
    const reg = new WaitRegistry(db)
    reg.register({
      resumeKey: "key-future", executionId: "exec-future",
      flowId: "f1", nodeId: "n1", resumeCtxKey: "p",
      timeoutAt: Date.now() + 60_000, createdAt: Date.now(),
    })
    reg.deleteExpired()
    expect(reg.getByKey("key-future")).toBeDefined()
  })

  test("null timeoutAt entries are never expired", () => {
    const reg = new WaitRegistry(db)
    reg.register({
      resumeKey: "key-forever", executionId: "exec-forever",
      flowId: "f1", nodeId: "n1", resumeCtxKey: "p",
      timeoutAt: null, createdAt: Date.now() - 1_000_000,
    })
    const expired = reg.getExpired()
    expect(expired.some(e => e.resumeKey === "key-forever")).toBe(false)
  })
})
