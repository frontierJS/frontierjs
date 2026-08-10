import type { NodeDefinition, RetryPolicy } from "../types"
import type { ResolutionContext } from "../expression"
import type { IExecutionCache } from "../cache"
import type { SyncHttpResponse } from "../runtime/context"
import { ExpressionResolver } from "../expression"

// ─────────────────────────────────────────────
// NODE INTERFACE
// What every node implementation must satisfy.
//
// Surface API:
//   implement INodeImplementation → register with INodeRegistry
//   NodeContext → what execute() receives
//   NodeResult  → what execute() returns
// ─────────────────────────────────────────────

export interface NodeContext {
  executionId: string
  config:  Record<string, unknown>  // fully resolved — no Expression types
  trigger: unknown
  nodes:   Record<string, unknown>
  logger:  NodeLogger
  fetch:   typeof fetch             // pre-wired with credential headers
  signal:  AbortSignal              // fires on timeout
  // Only present for sync webhook executions — used by http.respond
  respond?: (res: SyncHttpResponse) => void
}

export interface NodeLogger {
  info  (message: string, data?: unknown): void
  warn  (message: string, data?: unknown): void
  error (message: string, data?: unknown): void
  debug (message: string, data?: unknown): void
}

export type NodeResult =
  | { ok: true;  data: unknown }
  | { ok: false; error: string; retry?: boolean }

export interface INodeImplementation {
  type: string
  execute(ctx: NodeContext): Promise<NodeResult>
}

// ─────────────────────────────────────────────
// NODE REGISTRY INTERFACE
// ─────────────────────────────────────────────

export interface INodeRegistry {
  get(type: string): INodeImplementation | undefined
}

// ─────────────────────────────────────────────
// EXECUTOR RESULT
//   ok: true                     → write data to context, route success edges
//   ok: false, routable: true    → node ran, route error edges
//   ok: false, routable: false   → config/registry failure, stop flow
// ─────────────────────────────────────────────

export type ExecutorOutcome =
  | { ok: true;  data: unknown; durationMs: number; attempts: number; fromCache: boolean }
  | { ok: false; error: string; durationMs: number; attempts: number; routable: boolean }

// ─────────────────────────────────────────────
// LOG ENTRY
// ─────────────────────────────────────────────

export interface LogEntry {
  level:   "info" | "warn" | "error" | "debug"
  message: string
  data?:   unknown
  ts:      number
}

// ─────────────────────────────────────────────
// NODE EXECUTOR
// Runs a single node: resolve config → cache check → execute → retry → timeout
// Knows nothing about the DAG, stages, or routing.
//
// Surface API:
//   new NodeExecutor(registry, cache?, extraFns?)
//   executor.execute(node, ctx)   → { outcome, logs }
//   executor.resolve(expr, ctx)   → unknown   ← used by Scheduler for edge conditions
// ─────────────────────────────────────────────

export class NodeExecutor {
  private readonly resolver: ExpressionResolver

  constructor(
    private readonly nodeRegistry: INodeRegistry,
    private readonly cache?:       IExecutionCache,
    extraFns?: Record<string, (...args: unknown[]) => unknown>,
  ) {
    this.resolver = new ExpressionResolver(extraFns)
  }

  // Exposed so Scheduler can evaluate edge conditions + transforms
  // without breaching this class's private boundary
  resolve(expr: import("../types").Expression, ctx: ResolutionContext): unknown {
    return this.resolver.resolve(expr, ctx)
  }

  async execute(
    node: NodeDefinition,
    ctx:  ResolutionContext,
    extras?: { executionId?: string; respond?: (res: SyncHttpResponse) => void },
  ): Promise<{ outcome: ExecutorOutcome; logs: LogEntry[] }> {
    const logs   = [] as LogEntry[]
    const logger = this.makeLogger(logs)
    const start  = Date.now()

    // ── 1. Resolve config ──────────────────────────────────────────
    let config: Record<string, unknown>
    try {
      config = this.resolver.resolveConfig(node.config, ctx)
    } catch (err) {
      return { logs, outcome: { ok: false, routable: false, attempts: 0,
        error: `Config resolution failed: ${errorMessage(err)}`, durationMs: Date.now() - start } }
    }

    // ── 2. Lookup implementation ───────────────────────────────────
    const impl = this.nodeRegistry.get(node.type)
    if (!impl) {
      return { logs, outcome: { ok: false, routable: false, attempts: 0,
        error: `No implementation registered for node type "${node.type}"`, durationMs: Date.now() - start } }
    }

    // ── 3. Cache check ─────────────────────────────────────────────
    if (node.cache && this.cache) {
      try {
        const cacheKey = String(this.resolver.resolve(node.cache.key, ctx))
        const hit      = await this.cache.get(cacheKey)
        if (hit !== undefined) {
          logger.debug("Cache hit", { key: cacheKey })
          return { logs, outcome: { ok: true, fromCache: true, attempts: 0,
            data: hit, durationMs: Date.now() - start } }
        }
      } catch (err) {
        logger.warn("Cache lookup failed, proceeding without cache", { error: errorMessage(err) })
      }
    }

    // ── 4. Execute with retry + timeout ───────────────────────────
    const maxAttempts = node.retry?.maxAttempts ?? 1
    let   attempts    = 0
    let   lastError   = ""

    while (attempts < maxAttempts) {
      attempts++

      if (attempts > 1) {
        const delay = computeDelay(node.retry!, attempts)
        logger.info(`Retrying (attempt ${attempts}/${maxAttempts})`, { delay })
        await sleep(delay)
      }

      const controller = new AbortController()

      try {
        const nodeCtx: NodeContext = {
          executionId: extras?.executionId ?? "",
          config, trigger: ctx.trigger, nodes: ctx.nodes, logger,
          fetch:   makeScopedFetch(controller.signal),
          signal:  controller.signal,
          respond: extras?.respond,
        }

        const result = await (node.timeout
          ? Promise.race([impl.execute(nodeCtx), timeoutReject(node.timeout)])
          : impl.execute(nodeCtx))

        controller.abort()

        if (result.ok) {
          // ── 5. Write to cache ──────────────────────────────────
          if (node.cache && this.cache) {
            try {
              const cacheKey = String(this.resolver.resolve(node.cache.key, ctx))
              await this.cache.set(cacheKey, result.data, node.cache.ttlMs)
            } catch (err) {
              logger.warn("Cache write failed", { error: errorMessage(err) })
            }
          }
          return { logs, outcome: { ok: true, fromCache: false,
            data: result.data, durationMs: Date.now() - start, attempts } }
        }

        lastError = result.error
        logger.warn("Node returned error", { error: lastError, attempt: attempts })
        if (result.retry === false) break

      } catch (err) {
        controller.abort()
        if (err instanceof TimeoutError) {
          lastError = `Node timed out after ${node.timeout}ms`
          logger.error("Timeout", { attempt: attempts, timeoutMs: node.timeout })
          break   // timeouts are never retried
        }
        lastError = errorMessage(err)
        logger.error("Unexpected error", { error: lastError, attempt: attempts })
      }
    }

    return { logs, outcome: { ok: false, routable: true,
      error: lastError, durationMs: Date.now() - start, attempts } }
  }

  private makeLogger(logs: LogEntry[]): NodeLogger {
    const push = (level: LogEntry["level"]) =>
      (message: string, data?: unknown) => logs.push({ level, message, data, ts: Date.now() })
    return { info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug") }
  }
}

// ─────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────

class TimeoutError extends Error {
  constructor(ms: number) { super(`Node timed out after ${ms}ms`); this.name = "TimeoutError" }
}

function timeoutReject(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new TimeoutError(ms)), ms))
}

function computeDelay(retry: RetryPolicy, attempt: number): number {
  return retry.backoff === "exponential"
    ? Math.pow(2, attempt - 2) * retry.delayMs
    : retry.delayMs
}

function makeScopedFetch(signal: AbortSignal): typeof fetch {
  return (input, init) => fetch(input, { ...init, signal })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
