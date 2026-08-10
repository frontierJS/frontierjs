import { describe, test, expect, beforeEach } from "vitest"
import { EventBus, type WebhookMapper } from "./index"
import { InMemoryQueue, QueueFullError } from "../runtime/queue"

function makeQueue(capacity = 100) { return new InMemoryQueue(capacity) }

describe("EventBus — subscribe / unsubscribe", () => {
  test("subscribe registers a flow to an event", () => {
    const bus = new EventBus(makeQueue())
    bus.subscribe("user.created", "flow_welcome", "1.0.0")
    const subs = bus.subscribers("user.created")
    expect(subs["user.created"]).toHaveLength(1)
    expect(subs["user.created"]![0]!.flowId).toBe("flow_welcome")
  })

  test("multiple flows can subscribe to the same event", () => {
    const bus = new EventBus(makeQueue())
    bus.subscribe("payment.succeeded", "flow_a", "1.0.0")
    bus.subscribe("payment.succeeded", "flow_b", "1.0.0")
    expect(bus.subscribers("payment.succeeded")["payment.succeeded"]).toHaveLength(2)
  })

  test("same flow subscribing again replaces existing entry (hot reload)", () => {
    const bus = new EventBus(makeQueue())
    bus.subscribe("user.created", "flow_a", "1.0.0")
    bus.subscribe("user.created", "flow_a", "2.0.0")   // update version
    const subs = bus.subscribers("user.created")["user.created"]!
    expect(subs).toHaveLength(1)
    expect(subs[0]!.version).toBe("2.0.0")
  })

  test("unsubscribe removes all event subscriptions for a flow", () => {
    const bus = new EventBus(makeQueue())
    bus.subscribe("user.created",    "flow_a", "1.0.0")
    bus.subscribe("payment.failed",  "flow_a", "1.0.0")
    bus.subscribe("user.created",    "flow_b", "1.0.0")
    bus.unsubscribe("flow_a")
    // flow_a removed from both events
    expect(bus.subscribers("user.created")["user.created"]!.some(s => s.flowId === "flow_a")).toBe(false)
    expect(bus.subscribers("payment.failed")["payment.failed"]).toBeUndefined()
    // flow_b still subscribed
    expect(bus.subscribers("user.created")["user.created"]).toHaveLength(1)
  })

  test("unsubscribe removes empty event entries", () => {
    const bus = new EventBus(makeQueue())
    bus.subscribe("user.created", "flow_a", "1.0.0")
    bus.unsubscribe("flow_a")
    const all = bus.subscribers()
    expect(all["user.created"]).toBeUndefined()
  })

  test("subscribers() returns all events when no name given", () => {
    const bus = new EventBus(makeQueue())
    bus.subscribe("a.b", "flow_1", "1.0.0")
    bus.subscribe("c.d", "flow_2", "1.0.0")
    const all = bus.subscribers()
    expect(Object.keys(all)).toHaveLength(2)
  })
})

describe("EventBus — emit", () => {
  test("emit enqueues one job per subscriber", async () => {
    const queue = makeQueue()
    const bus   = new EventBus(queue)
    bus.subscribe("order.placed", "flow_a", "1.0.0")
    bus.subscribe("order.placed", "flow_b", "1.0.0")

    const result = await bus.emit("order.placed", { orderId: "ord_1" })

    expect(result.subscribers).toBe(2)
    expect(result.executionIds).toHaveLength(2)
    expect(queue.size()).toBe(2)
  })

  test("emit with no subscribers returns empty result", async () => {
    const bus    = new EventBus(makeQueue())
    const result = await bus.emit("unknown.event", {})
    expect(result.subscribers).toBe(0)
    expect(result.executionIds).toHaveLength(0)
  })

  test("emitted job trigger contains event name + payload", async () => {
    const queue = makeQueue()
    const bus   = new EventBus(queue)
    bus.subscribe("user.created", "flow_a", "1.0.0")
    await bus.emit("user.created", { userId: "u_123" })

    const job = await queue.dequeue()
    const trigger = job?.trigger as { event: string; payload: unknown }
    expect(trigger.event).toBe("user.created")
    expect(trigger.payload).toEqual({ userId: "u_123" })
  })

  test("emit result includes correct eventName", async () => {
    const bus    = new EventBus(makeQueue())
    const result = await bus.emit("stripe.payment.succeeded", { amount: 9900 })
    expect(result.eventName).toBe("stripe.payment.succeeded")
  })

  test("queue full for one subscriber does not prevent others", async () => {
    const queue = makeQueue(1)   // capacity 1
    const bus   = new EventBus(queue)
    bus.subscribe("evt", "flow_a", "1.0.0")
    bus.subscribe("evt", "flow_b", "1.0.0")

    // Should not throw even though second enqueue will fail
    const result = await bus.emit("evt", {})
    expect(result.subscribers).toBe(2)
  })

  test("each emission produces unique executionIds", async () => {
    const bus = new EventBus(makeQueue())
    bus.subscribe("evt", "flow_a", "1.0.0")
    const r1 = await bus.emit("evt", {})
    const r2 = await bus.emit("evt", {})
    expect(r1.executionIds[0]).not.toBe(r2.executionIds[0])
  })

  test("enqueued job has correct flowId and version", async () => {
    const queue = makeQueue()
    const bus   = new EventBus(queue)
    bus.subscribe("order.placed", "flow_orders", "3.0.0")
    await bus.emit("order.placed", {})

    const job = await queue.dequeue()
    expect(job?.flowId).toBe("flow_orders")
    expect(job?.version).toBe("3.0.0")
  })
})

describe("EventBus — schema", () => {
  test("defineSchema stores schema retrievable by getSchema", () => {
    const bus    = new EventBus(makeQueue())
    const schema = { type: "object" as const, properties: { userId: { type: "string" as const } } }
    bus.defineSchema("user.created", schema)
    expect(bus.getSchema("user.created")).toEqual(schema)
  })

  test("getSchema returns undefined for unknown events", () => {
    const bus = new EventBus(makeQueue())
    expect(bus.getSchema("unknown.event")).toBeUndefined()
  })

  test("defineSchema can be overwritten", () => {
    const bus = new EventBus(makeQueue())
    bus.defineSchema("evt", { type: "object" as const })
    bus.defineSchema("evt", { type: "string" as const })
    expect(bus.getSchema("evt")).toEqual({ type: "string" })
  })
})

describe("EventBus — webhook mapper", () => {
  test("registerMapper + mapRequest translates a request", () => {
    const bus: EventBus = new EventBus(makeQueue())

    const mapper: WebhookMapper = {
      path: "/webhooks/stripe",
      map:  (body: unknown) => {
        const b = body as { type: string; data: { object: unknown } }
        return { name: `stripe.${b.type}`, payload: b.data.object }
      },
    }

    bus.registerMapper(mapper)
    const result = bus.mapRequest(
      "/webhooks/stripe",
      { type: "payment_intent.succeeded", data: { object: { amount: 9900 } } },
      {},
    )

    expect(result).not.toBeNull()
    expect(result!.name).toBe("stripe.payment_intent.succeeded")
    expect(result!.payload).toEqual({ amount: 9900 })
  })

  test("mapRequest returns null for unknown path", () => {
    const bus    = new EventBus(makeQueue())
    const result = bus.mapRequest("/webhooks/unknown", {}, {})
    expect(result).toBeNull()
  })

  test("mapRequest returns null when mapper declines", () => {
    const bus: EventBus = new EventBus(makeQueue())
    bus.registerMapper({
      path: "/webhooks/github",
      map:  () => null,   // declines all
    })
    const result = bus.mapRequest("/webhooks/github", {}, {})
    expect(result).toBeNull()
  })

  test("mapper receives headers", () => {
    const bus: EventBus = new EventBus(makeQueue())
    let receivedHeaders: Record<string, string> = {}

    bus.registerMapper({
      path: "/webhooks/test",
      map:  (_, headers) => {
        receivedHeaders = headers
        return { name: "test.event", payload: {} }
      },
    })

    bus.mapRequest("/webhooks/test", {}, { "x-github-event": "push" })
    expect(receivedHeaders["x-github-event"]).toBe("push")
  })
})
