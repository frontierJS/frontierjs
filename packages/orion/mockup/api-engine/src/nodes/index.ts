import type { INodeImplementation, NodeContext } from "../executor"
import type { KVStore }            from "../store/kv"
import type { WaitRegistry }       from "../store/wait"
import type { AIProviderRegistry } from "./providers"
import { CodeWorkerPool }          from "./code-worker-pool"

// ─────────────────────────────────────────────
// NODE DEPENDENCIES
// Injected once at startup — nodes that need infrastructure
// get it via closure rather than global state.
// ─────────────────────────────────────────────

export interface NodeDeps {
  kv:          KVStore
  waitReg:     WaitRegistry
  aiProviders: AIProviderRegistry
  workspaceId: string   // resolved from server config / auth context
  codePool?:   CodeWorkerPool
}

// ─────────────────────────────────────────────
// TRIGGER NODES
// Triggers don't "execute" — the trigger system fires them externally.
// Their execute() is a no-op that returns the trigger payload so it
// lands in context like any other node output.
// ─────────────────────────────────────────────

const triggerWebhook: INodeImplementation = {
  type: "trigger.webhook",
  async execute(ctx: NodeContext) {
    return { ok: true, data: ctx.trigger }
  },
}

const triggerCron: INodeImplementation = {
  type: "trigger.cron",
  async execute(ctx: NodeContext) {
    return { ok: true, data: ctx.trigger }
  },
}

const triggerManual: INodeImplementation = {
  type: "trigger.manual",
  async execute(ctx: NodeContext) {
    return { ok: true, data: ctx.trigger }
  },
}

const triggerEvent: INodeImplementation = {
  type: "trigger.event",
  async execute(ctx: NodeContext) {
    return { ok: true, data: ctx.trigger }
  },
}

// ─────────────────────────────────────────────
// TRANSFORM NODES
// ─────────────────────────────────────────────

// expr.pipeline — expressions already evaluated by the executor's config resolver.
// By the time execute() is called, `steps` is a resolved array and `result`
// is the final step's value (set by the compiler's preEvaluateStatics or runtime resolver).
// We simply pass through whatever the resolver produced.
const exprPipeline: INodeImplementation = {
  type: "expr.pipeline",
  async execute(ctx: NodeContext) {
    const { steps } = ctx.config
    if (!Array.isArray(steps) || steps.length === 0) {
      return { ok: false, error: "expr.pipeline: steps must be a non-empty array" }
    }
    // Steps are already resolved values — return the last one
    const result = steps[steps.length - 1]
    return { ok: true, data: { result } }
  },
}

// data.code — runs user JS in a sandboxed worker thread
function makeDataCode(pool: CodeWorkerPool): INodeImplementation {
  return {
    type: "data.code",
    async execute(ctx: NodeContext) {
      const code = ctx.config.code
      if (typeof code !== "string" || !code.trim()) {
        return { ok: false, error: "data.code: config.code must be a non-empty string" }
      }
      try {
        const result = await pool.run(code, { ...ctx.nodes, nodes: ctx.nodes, trigger: ctx.trigger }, 5_000)
        return { ok: true, data: { result } }
      } catch (err) {
        return { ok: false, error: errorMessage(err), retry: false }
      }
    },
  }
}

// data.template — Mustache-style {{variable}} interpolation
const dataTemplate: INodeImplementation = {
  type: "data.template",
  async execute(ctx: NodeContext) {
    const template = ctx.config.template
    if (typeof template !== "string") {
      return { ok: false, error: "data.template: config.template must be a string" }
    }
    const vars: Record<string, unknown> = { ...ctx.nodes, trigger: ctx.trigger }
    const rendered = template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
      const val = resolvePath(vars, path.trim())
      return val == null ? "" : String(val)
    })
    return { ok: true, data: { rendered } }
  },
}

// data.parse — parse string to structured data
const dataParse: INodeImplementation = {
  type: "data.parse",
  async execute(ctx: NodeContext) {
    const { input, format } = ctx.config
    if (typeof input !== "string") {
      return { ok: false, error: "data.parse: resolved input must be a string" }
    }
    try {
      let parsed: unknown
      if (format === "json") {
        parsed = JSON.parse(input)
      } else if (format === "csv") {
        parsed = parseCsv(input)
      } else if (format === "yaml") {
        parsed = parseYaml(input)
      } else if (format === "xml") {
        // Minimal XML → object (attributes + text nodes only)
        parsed = parseXml(input)
      } else {
        return { ok: false, error: `data.parse: unknown format "${format}"` }
      }
      return { ok: true, data: { parsed } }
    } catch (err) {
      return { ok: false, error: `data.parse: ${errorMessage(err)}` }
    }
  },
}

// ─────────────────────────────────────────────
// FLOW CONTROL NODES
// ─────────────────────────────────────────────

// flow.merge — waits for all incoming branches.
// Stage-based parallel execution already handles this:
// all nodes in a stage complete before the next stage starts.
// flow.merge is a DAG join point — it has no runtime work to do.
const flowMerge: INodeImplementation = {
  type: "flow.merge",
  async execute() {
    return { ok: true, data: { merged: true } }
  },
}

// flow.delay — sleep for configured ms
const flowDelay: INodeImplementation = {
  type: "flow.delay",
  async execute(ctx: NodeContext) {
    const ms = Number(ctx.config.ms)
    if (!Number.isFinite(ms) || ms < 0) {
      return { ok: false, error: `flow.delay: ms must be a non-negative number, got ${ctx.config.ms}` }
    }
    await sleep(ms)
    return { ok: true, data: { delayedMs: ms } }
  },
}

// flow.each — iteration is handled by the scheduler via a sentinel.
// This node signals how to iterate; actual looping is orchestrated outside.
// For now: executes inline sequentially / parallel via Promise.all.
// Full sub-DAG iteration is a v2 scheduler concern.
const flowEach: INodeImplementation = {
  type: "flow.each",
  async execute(ctx: NodeContext) {
    const { over, as = "item", index: indexKey = "index", mode = "parallel" } = ctx.config
    if (!Array.isArray(over)) {
      return { ok: false, error: `flow.each: resolved 'over' must be an array, got ${typeof over}` }
    }
    // Produce iteration metadata — downstream nodes access items via $.nodes.each.items[n]
    return {
      ok: true,
      data: {
        items:    over,
        count:    over.length,
        as,
        indexKey,
        mode,
      },
    }
  },
}

// flow.wait — suspends execution until an external resume
function makeFlowWait(waitReg: WaitRegistry): INodeImplementation {
  return {
    type: "flow.wait",
    async execute(ctx: NodeContext) {
      const { event, timeoutMs, resumeKey: configKey = "resumePayload" } = ctx.config
      if (typeof event !== "string") {
        return { ok: false, error: "flow.wait: config.event must be a string" }
      }

      // Generate opaque resume key
      const resumeKey = generateId(21)
      const timeoutAt = timeoutMs != null ? Date.now() + Number(timeoutMs) : null

      waitReg.register({
        resumeKey,
        executionId:  ctx.executionId,
        flowId:       (ctx.nodes as any).__flowId ?? "",
        nodeId:       event,  // store event name as nodeId for logging
        resumeCtxKey: configKey as string,
        timeoutAt,
        createdAt:    Date.now(),
      })

      // Return sentinel — scheduler sees __orion_wait and suspends
      return {
        ok:   true,
        data: { __orion_wait: true, resumeKey, event, timeoutAt },
      }
    },
  }
}

// flow.loop — condition evaluated by expression resolver upstream
// Returns loop metadata; actual loop control lives in the scheduler
const flowLoop: INodeImplementation = {
  type: "flow.loop",
  async execute(ctx: NodeContext) {
    const { condition, maxIter = 100 } = ctx.config
    return {
      ok:   true,
      data: { condition, maxIter, iteration: 0 },
    }
  },
}

// flow.error — error handler node, receives error info injected by scheduler
const flowError: INodeImplementation = {
  type: "flow.error",
  async execute(ctx: NodeContext) {
    const { capture = "error" } = ctx.config
    // The scheduler injects error info into nodes before this runs
    const errorInfo = (ctx.nodes as any).__error
    return {
      ok:   true,
      data: { [capture as string]: errorInfo?.message, nodeId: errorInfo?.nodeId },
    }
  },
}

// ─────────────────────────────────────────────
// HTTP NODES
// ─────────────────────────────────────────────

const httpRequest: INodeImplementation = {
  type: "http.request",
  async execute(ctx: NodeContext) {
    const { url, method = "GET", headers = {}, body: reqBody } = ctx.config
    if (typeof url !== "string" || !url) {
      return { ok: false, error: "http.request: config.url must resolve to a non-empty string" }
    }

    const fetchInit: RequestInit = {
      method:  String(method),
      headers: headers as HeadersInit,
      signal:  ctx.signal,
    }
    if (reqBody != null && method !== "GET" && method !== "HEAD") {
      fetchInit.body = typeof reqBody === "string" ? reqBody : JSON.stringify(reqBody)
      if (!(fetchInit.headers as Record<string, string>)["content-type"]) {
        (fetchInit.headers as Record<string, string>)["content-type"] = "application/json"
      }
    }

    let res: Response
    try {
      res = await ctx.fetch(url, fetchInit)
    } catch (err) {
      return { ok: false, error: `http.request: fetch failed — ${errorMessage(err)}` }
    }

    const contentType = res.headers.get("content-type") ?? ""
    let responseBody: unknown
    try {
      responseBody = contentType.includes("json") ? await res.json() : await res.text()
    } catch {
      responseBody = null
    }

    const outHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => { outHeaders[k] = v })

    return {
      ok: true,
      data: {
        status:  res.status,
        headers: outHeaders,
        body:    responseBody,
        ok:      res.ok,
      },
    }
  },
}

// http.respond — sends the held HTTP response for sync webhook flows
const httpRespond: INodeImplementation = {
  type: "http.respond",
  async execute(ctx: NodeContext) {
    const { status = 200, headers = {}, body: respBody = null } = ctx.config

    if (ctx.respond) {
      ctx.respond({
        status:  Number(status),
        headers: headers as Record<string, string>,
        body:    respBody,
      })
    }
    // No-op for async flows — just passes through
    return { ok: true, data: { sent: ctx.respond != null, status } }
  },
}

// ─────────────────────────────────────────────
// AI NODE
// ─────────────────────────────────────────────

function makeAiNode(providerRegistry: AIProviderRegistry): INodeImplementation {
  return {
    type: "ai",
    async execute(ctx: NodeContext) {
      const { model, mode = "complete", prompt, input, schema, options, __provider } = ctx.config

      if (!__provider || typeof __provider !== "object") {
        return { ok: false, error: "ai: credential must include a provider config object" }
      }

      const providerConfig = __provider as Record<string, unknown>
      const providerName   = providerConfig.provider as string
      if (!providerName) return { ok: false, error: "ai: credential.provider field is required" }

      let provider
      try {
        provider = providerRegistry.get(providerName)(providerConfig)
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }

      const modelStr = String(model ?? "")
      if (!modelStr) return { ok: false, error: "ai: config.model is required" }

      try {
        if (mode === "complete") {
          if (!prompt) return { ok: false, error: "ai: config.prompt required for complete mode" }
          const res = await provider.complete({ model: modelStr, prompt: String(prompt), options: options as any })
          return { ok: true, data: { result: res.text, finishReason: res.finishReason, model: modelStr, usage: res.usage } }
        }

        if (mode === "embed") {
          if (!input) return { ok: false, error: "ai: config.input required for embed mode" }
          const res = await provider.embed({ model: modelStr, input: input as any })
          return { ok: true, data: { result: res.embeddings, model: modelStr, usage: res.usage } }
        }

        if (mode === "classify") {
          const labels = (ctx.config.labels as string[] | undefined) ?? []
          if (!input) return { ok: false, error: "ai: config.input required for classify mode" }
          if (!labels.length) return { ok: false, error: "ai: config.labels required for classify mode" }
          const res = await provider.classify({ model: modelStr, input: String(input), labels, options: options as any })
          return { ok: true, data: { result: res.label, score: res.score, model: modelStr, usage: res.usage } }
        }

        if (mode === "extract") {
          if (!input)  return { ok: false, error: "ai: config.input required for extract mode" }
          if (!schema) return { ok: false, error: "ai: config.schema required for extract mode" }
          const res = await provider.extract({ model: modelStr, input: String(input), schema: schema as any, options: options as any })
          return { ok: true, data: { result: res.data, model: modelStr, usage: res.usage } }
        }

        return { ok: false, error: `ai: unknown mode "${mode}"` }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  }
}

// ─────────────────────────────────────────────
// STORE NODE
// ─────────────────────────────────────────────

function makeStoreNode(kv: KVStore, workspaceId: string): INodeImplementation {
  return {
    type: "store",
    async execute(ctx: NodeContext) {
      const { key, mode = "get", value, output = "value", ttlMs, scope = "workspace" } = ctx.config

      if (typeof key !== "string" || !key) {
        return { ok: false, error: "store: config.key must resolve to a non-empty string" }
      }

      const kvScope = scope === "execution" ? ctx.executionId : "workspace"

      if (mode === "get") {
        const found_val = kv.get(workspaceId, kvScope, key)
        const found = found_val !== undefined
        return { ok: true, data: { [output as string]: found_val, found, key } }
      }

      if (mode === "set") {
        kv.set(workspaceId, kvScope, key, value, ttlMs != null ? Number(ttlMs) : undefined)
        return { ok: true, data: { key, set: true } }
      }

      if (mode === "delete") {
        const deleted = kv.delete(workspaceId, kvScope, key)
        return { ok: true, data: { key, deleted } }
      }

      return { ok: false, error: `store: unknown mode "${mode}"` }
    },
  }
}

// ─────────────────────────────────────────────
// FACTORY — builds + registers all implementations
// ─────────────────────────────────────────────

export function createNodeImplementations(deps: NodeDeps): INodeImplementation[] {
  const pool = deps.codePool ?? new CodeWorkerPool(3)

  return [
    // Triggers
    triggerWebhook,
    triggerCron,
    triggerManual,
    triggerEvent,
    // Transform
    exprPipeline,
    makeDataCode(pool),
    dataTemplate,
    dataParse,
    // Flow control
    flowMerge,
    flowDelay,
    flowEach,
    makeFlowWait(deps.waitReg),
    flowLoop,
    flowError,
    // HTTP
    httpRequest,
    httpRespond,
    // AI
    makeAiNode(deps.aiProviders),
    // Storage
    makeStoreNode(deps.kv, deps.workspaceId),
  ]
}

// ─────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc != null && typeof acc === "object") return (acc as Record<string, unknown>)[key]
    return undefined
  }, obj)
}

function generateId(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let id = ""
  for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return id
}

// ── Minimal CSV parser (RFC 4180 subset) ─────
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const headers = splitCsvLine(lines[0]!)
  return lines.slice(1).map(line => {
    const vals = splitCsvLine(line)
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? "" })
    return row
  })
}

function splitCsvLine(line: string): string[] {
  const cols: string[] = []
  let cur = "", inQuote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '"') { inQuote = !inQuote }
    else if (c === "," && !inQuote) { cols.push(cur); cur = "" }
    else cur += c
  }
  cols.push(cur)
  return cols
}

// ── Minimal YAML → object (key: value lines only) ──
function parseYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\s*)([^:#]+):\s*(.*)$/)
    if (!m) continue
    const key = m[2]!.trim()
    const raw = m[3]!.trim()
    if (!key) continue
    result[key] = raw === "true" ? true
      : raw === "false" ? false
      : raw === "null" || raw === "~" ? null
      : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw)
      : raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1)
      : raw
  }
  return result
}

// ── Minimal XML → object (attributes + text nodes) ──
function parseXml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const tagRe = /<([a-zA-Z_][\w.-]*)([^>]*)>([\s\S]*?)<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(text)) !== null) {
    const tag   = m[1]!
    const inner = m[3]!.trim()
    result[tag] = inner.startsWith("<") ? parseXml(inner) : inner
  }
  return result
}
