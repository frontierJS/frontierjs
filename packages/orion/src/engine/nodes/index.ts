import type { INodeImplementation, NodeContext } from "../executor"
import type { IKeyValueStore, IAIModels, IJobDispatcher, IModelActions, INotifier, IOutbound, IServiceCaller, Recipient } from "../ports"
import { RESERVED_JOB_PREFIX } from "../ports"
import { CodeWorkerPool }          from "./code-worker-pool"

// ─────────────────────────────────────────────
// NODE DEPENDENCIES
// Injected once at startup — nodes that need infrastructure
// get it via closure rather than global state.
// ─────────────────────────────────────────────

export interface NodeDeps {
  kv:          IKeyValueStore
  outbound?:   IOutbound
  ai?:         IAIModels
  models?:     IModelActions
  services?:   IServiceCaller
  jobs?:       IJobDispatcher
  notifier?:   INotifier
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

const triggerModel: INodeImplementation = {
  type: "trigger.model",
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
      // A script can reach anything the process can, so a dry run cannot vouch
      // for what it would do and does not run it.
      if (ctx.dryRun) return notSent(ctx, { code: "not run" })
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

// flow.wait — suspends execution until an external resume.
// The node only answers the sentinel. The host writes the Wait row in the same
// transaction as the checkpoint that suspends the run, so a resume key exists
// exactly while its run is waiting.
const flowWait: INodeImplementation = {
  type: "flow.wait",
  async execute(ctx: NodeContext) {
    const { event, timeoutMs, resumeKey: into = "resumePayload" } = ctx.config
    if (typeof event !== "string") {
      return { ok: false, error: "flow.wait: config.event must be a string" }
    }
    return {
      ok:   true,
      data: {
        __orion_wait: true,
        // The key is the credential that resumes the run, so it is random bytes
        // and not Math.random.
        resumeKey:    randomKey(),
        event,
        timeoutAt:    timeoutMs != null ? Date.now() + Number(timeoutMs) : null,
        into:         String(into),
      },
    }
  },
}

// model.* and service.call — the app's own data, through the host's ports.
// A refusal is the Data boundary's answer to this principal, and asking again
// cannot change it, so nothing here is retried.
function makeModelNode(type: "model.create" | "model.patch" | "model.remove", models?: IModelActions): INodeImplementation {
  return {
    type,
    async execute(ctx: NodeContext) {
      if (!models) return { ok: false, error: `${type}: this host supplies no model actions`, retry: false }
      const { model, id, data } = ctx.config
      if (typeof model !== "string") return { ok: false, error: `${type}: config.model must be a string`, retry: false }
      if (type !== "model.remove" && (data === null || typeof data !== "object" || Array.isArray(data))) {
        return { ok: false, error: `${type}: config.data must be an object`, retry: false }
      }
      if (type !== "model.create" && (id === undefined || id === null)) {
        return { ok: false, error: `${type}: config.id is required`, retry: false }
      }
      // Taken before the await, so parallel nodes in one stage cannot all pass a
      // check the last row would have failed; given back when nothing was written.
      if (ctx.writes) {
        if (ctx.writes.used >= ctx.writes.limit) {
          return { ok: false, error: `${type}: this run has written its ceiling of ${ctx.writes.limit} rows`, retry: false }
        }
        ctx.writes.used++
      }
      try {
        const row = type === "model.create" ? await models.create(ctx.actor, model, data as Record<string, unknown>)
                  : type === "model.patch"  ? await models.patch(ctx.actor, model, id, data as Record<string, unknown>)
                  :                           await models.remove(ctx.actor, model, id)
        return { ok: true, data: row ?? null }
      } catch (err) {
        if (ctx.writes) ctx.writes.used--
        return { ok: false, error: errorMessage(err), retry: false }
      }
    },
  }
}

function makeServiceCall(services?: IServiceCaller): INodeImplementation {
  return {
    type: "service.call",
    async execute(ctx: NodeContext) {
      const { service, method, id, data, query } = ctx.config
      if (typeof service !== "string" || typeof method !== "string") {
        return { ok: false, error: "service.call: config.service and config.method must be strings", retry: false }
      }
      if (ctx.dryRun) return notSent(ctx, { service, method, id, data, query })
      if (!services) return { ok: false, error: "service.call: this host supplies no services", retry: false }
      try {
        return { ok: true, data: (await services.call(ctx.actor, service, method, { id, data, query })) ?? null }
      } catch (err) {
        return { ok: false, error: errorMessage(err), retry: false }
      }
    },
  }
}

// The job id is the run and the node, so a stage run again after a crash
// dispatches the job it already dispatched rather than a second one.
function makeJobDispatch(jobs?: IJobDispatcher): INodeImplementation {
  return {
    type: "job.dispatch",
    async execute(ctx: NodeContext) {
      const { job, data } = ctx.config
      if (typeof job !== "string") return { ok: false, error: "job.dispatch: config.job must be a string", retry: false }
      if (job.startsWith(RESERVED_JOB_PREFIX)) {
        return { ok: false, error: `job.dispatch: "${job}" is orion's own job, and a flow cannot dispatch it`, retry: false }
      }
      const id = `orion:${ctx.executionId}:${ctx.nodeId}`
      if (ctx.dryRun) return notSent(ctx, { job, data: data ?? null, id })
      if (!jobs) return { ok: false, error: "job.dispatch: this host supplies no job queue", retry: false }
      try {
        return { ok: true, data: { jobId: await jobs.dispatch(ctx.actor, job, data ?? null, { id }) } }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  }
}

// Not idempotent: a notification has no delivery key, so a stage run again after
// a crash sends it again, and a failure is not retried because some transports
// may already have delivered.
function makeNotify(notifier?: INotifier): INodeImplementation {
  return {
    type: "notify",
    async execute(ctx: NodeContext) {
      const { notification, to, payload } = ctx.config
      if (typeof notification !== "string") {
        return { ok: false, error: "notify: config.notification must be a string", retry: false }
      }
      if (to === null || typeof to !== "object" || Array.isArray(to)) {
        return { ok: false, error: "notify: config.to must be a recipient — an object with an id, an email, or both", retry: false }
      }
      if (ctx.dryRun) return notSent(ctx, { notification, to, payload: payload ?? null })
      if (!notifier) return { ok: false, error: "notify: this host supplies no notifications", retry: false }
      try {
        await notifier.notify(ctx.actor, notification, to as Recipient, payload ?? null)
        return { ok: true, data: { sent: true } }
      } catch (err) {
        return { ok: false, error: errorMessage(err), retry: false }
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

function makeHttpRequest(outbound?: IOutbound): INodeImplementation {
  return {
    type: "http.request",
    async execute(ctx: NodeContext) {
      const { credential, method = "GET", path = "", query, headers, body } = ctx.config
      if (typeof credential !== "string" || !credential) {
        return { ok: false, error: "http.request: config.credential must name the credential the call goes through", retry: false }
      }
      const req = {
        credential,
        method:         String(method).toUpperCase(),
        path:           String(path),
        query:          query as Record<string, unknown> | undefined,
        headers:        headers as Record<string, string> | undefined,
        body:           body ?? undefined,
        idempotencyKey: `${ctx.executionId}:${ctx.nodeId}:${ctx.attempt}`,
      }
      if (ctx.dryRun) return notSent(ctx, req)
      if (!outbound) return { ok: false, error: "http.request: this host supplies no outbound calls", retry: false }

      try {
        const res = await outbound.send(ctx.actor, req)
        return { ok: true, data: { ...res, ok: res.status >= 200 && res.status < 300 } }
      } catch (err) {
        return { ok: false, error: `http.request: ${errorMessage(err)}` }
      }
    },
  }
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

function makeAiNode(models?: IAIModels): INodeImplementation {
  return {
    type: "ai",
    async execute(ctx: NodeContext) {
      const { model, mode = "complete", prompt, system, maxTokens, temperature } = ctx.config
      if (mode !== "complete") return { ok: false, error: `ai: unknown mode "${mode}"`, retry: false }
      if (typeof model !== "string" || !model) return { ok: false, error: "ai: config.model must name one of the app's AI models", retry: false }
      if (!prompt) return { ok: false, error: "ai: config.prompt is required", retry: false }

      const req = {
        messages:    [{ role: "user" as const, content: String(prompt) }],
        ...(system      != null ? { system:      String(system) }      : {}),
        ...(maxTokens   != null ? { maxTokens:   Number(maxTokens) }   : {}),
        ...(temperature != null ? { temperature: Number(temperature) } : {}),
      }
      if (ctx.dryRun) return notSent(ctx, { ai: model, ...req })
      if (!models) return { ok: false, error: "ai: this host supplies no AI models", retry: false }

      try {
        const res = await models.complete(ctx.actor, model, req)
        return {
          ok:   true,
          data: { result: res.content, model: res.model, usage: { inputTokens: res.inputTokens ?? null, outputTokens: res.outputTokens ?? null } },
        }
      } catch (err) {
        return { ok: false, error: `ai: ${errorMessage(err)}` }
      }
    },
  }
}

// ─────────────────────────────────────────────
// STORE NODE
// ─────────────────────────────────────────────

function makeStoreNode(kv: IKeyValueStore): INodeImplementation {
  return {
    type: "store",
    async execute(ctx: NodeContext) {
      const { key, mode = "get", value, output = "value", ttlMs, scope = "flow" } = ctx.config

      if (typeof key !== "string" || !key) {
        return { ok: false, error: "store: config.key must resolve to a non-empty string" }
      }
      const kvScope = scope === "global" ? "global"
                    : scope === "run"    ? `run:${ctx.executionId}`
                    : scope === "flow"   ? `flow:${ctx.flowId}`
                    : undefined
      if (!kvScope) return { ok: false, error: `store: unknown scope "${scope}" (global, flow or run)` }

      if (mode === "get") {
        const found_val = await kv.get(ctx.actor, kvScope, key)
        return { ok: true, data: { [output as string]: found_val, found: found_val !== undefined, key } }
      }

      if (ctx.dryRun && (mode === "set" || mode === "delete")) return notSent(ctx, { store: mode, scope: kvScope, key, value })

      if (mode === "set") {
        await kv.set(ctx.actor, kvScope, key, value, ttlMs != null ? Number(ttlMs) : undefined)
        return { ok: true, data: { key, set: true } }
      }

      if (mode === "delete") {
        return { ok: true, data: { key, deleted: await kv.delete(ctx.actor, kvScope, key) } }
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
    triggerModel,
    // Transform
    exprPipeline,
    makeDataCode(pool),
    dataTemplate,
    dataParse,
    // Flow control
    flowMerge,
    flowDelay,
    flowEach,
    flowWait,
    flowLoop,
    flowError,
    // HTTP
    makeHttpRequest(deps.outbound),
    httpRespond,
    // AI
    makeAiNode(deps.ai),
    // Storage
    makeStoreNode(deps.kv),
    // Data
    makeModelNode("model.create", deps.models),
    makeModelNode("model.patch",  deps.models),
    makeModelNode("model.remove", deps.models),
    makeServiceCall(deps.services),
    makeJobDispatch(deps.jobs),
    makeNotify(deps.notifier),
  ]
}

// ─────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────

// What a dry-run node answers: the effect it would have had, in its own output
// and its log, so the run record is the list of everything not sent.
function notSent(ctx: NodeContext, wouldSend: Record<string, unknown>) {
  ctx.logger.info("dry run: not sent", wouldSend)
  return { ok: true as const, data: { dryRun: true, wouldSend } }
}

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

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Buffer.from(bytes).toString("base64url")
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
