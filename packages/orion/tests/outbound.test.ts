/*
 * outbound.test.ts
 *
 * A flow's outside call, end to end below the node: `FlowCredential` rows in a
 * real litestone database, a real conduit instance resolving their secrets, and
 * a real HTTP server on an ephemeral port receiving what was sent.
 *
 * What the server records is the assertion surface, because the claim is about
 * the wire: the secret stored encrypted arrives in the header its auth names, a
 * public credential sends no auth at all, the idempotency key travels, and an
 * edited credential is what the next call uses.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"

import { createTestEnv } from "../../litestone/src/testing.js"
import { createConduit } from "../../conduit/src/index"
import { conduitOutbound, flowCredentialResolver, UnknownCredentialError } from "../src/outbound"
import type { IOutbound } from "../src/engine/ports"
import { litestoneHost } from "../src/tenancy"
import { SCHEMA, KEY } from "./fixtures/host"

interface Received { method: string; path: string; headers: Record<string, string>; body: string }

let env:      any
let server:   ReturnType<typeof Bun.serve>
let received: Received[] = []
let outbound: IOutbound

beforeAll(async () => {
  env = await createTestEnv({ schema: SCHEMA, encryptionKey: KEY, claims: [] })
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      received.push({ method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: await req.text() })
      if (url.pathname === "/refuse") return Response.json({ error: "no such lead" }, { status: 422 })
      return Response.json({ ok: true, path: url.pathname })
    },
  })
  outbound = conduitOutbound({
    conduit:       createConduit({ credentials: flowCredentialResolver(litestoneHost({ db: env.db })), retry_limit: 0 }) as never,
    credentialsOf: () => ({ db: env.system, tenant: null }),
  })
})

afterAll(() => server.stop(true))

const origin = () => `http://127.0.0.1:${server.port}`
const last   = () => received.at(-1)!

async function credential(data: Record<string, unknown>) {
  return env.system.flowCredential.create({ data: { provider: "suite", address: origin(), ...data } })
}

const call = (credentialName: string, over: object = {}) => outbound.send(undefined, {
  credential: credentialName, method: "POST", path: "/v1/leads", body: { name: "Ada" }, idempotencyKey: "run-1:node:1", ...over,
})

describe("a flow's outbound call", () => {
  test("a bearer credential's secret arrives as the Authorization header, and never sits on disk in plain text", async () => {
    await credential({ name: "crm", auth: "bearer", secret: "sk_live_bearer" })
    const res = await call("crm")

    expect(res).toMatchObject({ status: 200, body: { ok: true, path: "/v1/leads" } })
    expect(last().headers["authorization"]).toBe("Bearer sk_live_bearer")
    expect(last().headers["idempotency-key"]).toBe("run-1:node:1")
    expect(JSON.parse(last().body)).toEqual({ name: "Ada" })

    const { Database } = await import("bun:sqlite")
    const raw = new Database(env.path, { readonly: true })
    const row = raw.query("SELECT secret FROM flow_credential WHERE name = 'crm'").get() as { secret: string }
    raw.close()
    expect(row.secret).not.toContain("sk_live_bearer")
  })

  test("an api_key credential uses the header it names", async () => {
    await credential({ name: "mailer", auth: "api_key", header: "x-mailer-key", secret: "mk_123" })
    await call("mailer")
    expect(last().headers["x-mailer-key"]).toBe("mk_123")
    expect(last().headers["authorization"]).toBeUndefined()
  })

  test("a public credential sends no auth", async () => {
    await credential({ name: "public", auth: "none" })
    await call("public", { method: "GET", path: "/status", body: undefined })
    expect(last().method).toBe("GET")
    expect(last().headers["authorization"]).toBeUndefined()
  })

  test("a refusal from the target is an answer, with its status and body", async () => {
    await credential({ name: "refuser", auth: "none" })
    const res = await call("refuser", { path: "/refuse" })
    expect(res.status).toBe(422)
  })

  test("a credential that does not exist refuses by name and sends nothing", async () => {
    const before = received.length
    await expect(call("nowhere")).rejects.toBeInstanceOf(UnknownCredentialError)
    expect(received.length).toBe(before)
  })

  test("an edited credential is what the next call uses — address and secret alike", async () => {
    const row = await credential({ name: "rotating", auth: "bearer", secret: "old-secret" })
    await call("rotating")
    expect(last().headers["authorization"]).toBe("Bearer old-secret")

    await Bun.sleep(5)   // updatedAt is the clock's; two writes in one millisecond would read as no edit
    await env.system.flowCredential.update({ where: { id: row.id }, data: { secret: "new-secret", address: `${origin()}/v2` } })
    await call("rotating")
    expect(last().headers["authorization"]).toBe("Bearer new-secret")
    expect(last().path).toBe("/v2/v1/leads")
  })

  test("the secret is not readable by the administrator who wrote it", async () => {
    const admin = env.actingAs({ id: "admin", role: "admin", isAdmin: true })
    await admin.flowCredential.create({ data: { name: "admin-made", provider: "x", address: origin(), auth: "bearer", secret: "shh" } })
    const read = await admin.flowCredential.findFirst({ where: { name: "admin-made" } })
    expect(read.name).toBe("admin-made")
    expect("secret" in read).toBe(false)
  })
})
