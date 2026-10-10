/*
 * audit-refusal-status.test.ts
 *
 * One owner per thrown-value → HTTP status (Invariant 4). A flow refusal
 * carries its own `status`, so junction's `toFrameworkError()` answers the same
 * code whether the runner threw it under a raw route or a service method.
 * A mapper beside the owner -- `instanceof` to 429/409 in one call site --
 * leaves every other call site a 500.
 */

import { describe, test, expect } from "bun:test"
import { toFrameworkError } from "../../junction/src/core/errors.ts"
import { FlowRateLimitedError, FlowNotRunnableError } from "../src/runner.ts"

describe("a flow refusal has one status, wherever it is thrown", () => {

  test("control: the owner honors a numeric status on any error class", () => {
    class Owned extends Error { status = 429 }
    expect(toFrameworkError(new Owned("x")).code).toBe(429)
  })

  test("FlowRateLimitedError is 429 through toFrameworkError", () => {
    const fe = toFrameworkError(new FlowRateLimitedError("flow-1", 5))
    expect(fe.code).toBe(429)
  })

  test("FlowNotRunnableError is 409 through toFrameworkError", () => {
    const fe = toFrameworkError(new FlowNotRunnableError("flow-1", "disabled"))
    expect(fe.code).toBe(409)
  })
})
