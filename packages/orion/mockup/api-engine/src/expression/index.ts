import type { Expression } from "../types"

// ─────────────────────────────────────────────
// RESOLUTION CONTEXT
// The live state available during a run
// ─────────────────────────────────────────────

export interface ResolutionContext {
  // Output from each completed node — keyed by nodeId
  nodes: Record<string, unknown>

  // The trigger payload that started the flow
  trigger: unknown
}

// ─────────────────────────────────────────────
// RESOLUTION ERROR
// ─────────────────────────────────────────────

export class ResolutionError extends Error {
  constructor(
    message: string,
    public readonly expression: Expression,
    public readonly path?: string,
  ) {
    super(message)
    this.name = "ResolutionError"
  }
}

// ─────────────────────────────────────────────
// BUILT-IN FUNCTIONS
// Registered by name — extensible by plugin system later
// ─────────────────────────────────────────────

type BuiltinFn = (...args: unknown[]) => unknown

const BUILTINS: Record<string, BuiltinFn> = {
  // Comparison
  gt:  (a, b) => (a as number)  >  (b as number),
  lt:  (a, b) => (a as number)  <  (b as number),
  gte: (a, b) => (a as number)  >= (b as number),
  lte: (a, b) => (a as number)  <= (b as number),
  eq:  (a, b) => a === b,
  neq: (a, b) => a !== b,

  // Logic
  and: (...args) => args.every(Boolean),
  or:  (...args) => args.some(Boolean),
  not: (a)      => !a,

  // Math
  add:   (a, b) => (a as number) + (b as number),
  sub:   (a, b) => (a as number) - (b as number),
  mul:   (a, b) => (a as number) * (b as number),
  div:   (a, b) => (a as number) / (b as number),
  round: (a)    => Math.round(a as number),
  floor: (a)    => Math.floor(a as number),
  ceil:  (a)    => Math.ceil(a  as number),
  abs:   (a)    => Math.abs(a   as number),
  min:   (...args) => Math.min(...(args as number[])),
  max:   (...args) => Math.max(...(args as number[])),

  // String
  concat:     (...args) => args.join(""),
  upper:      (a) => (a as string).toUpperCase(),
  lower:      (a) => (a as string).toLowerCase(),
  trim:       (a) => (a as string).trim(),
  length:     (a) => (a as string | unknown[]).length,
  includes:   (a, b) => (a as string).includes(b as string),
  startsWith: (a, b) => (a as string).startsWith(b as string),
  endsWith:   (a, b) => (a as string).endsWith(b as string),
  replace:    (a, b, c) => (a as string).replace(b as string, c as string),
  split:      (a, b) => (a as string).split(b as string),
  slice:      (a, b, c) => (a as string | unknown[]).slice(b as number, c as number | undefined),

  // Array
  first:    (a) => (a as unknown[])[0],
  last:     (a) => (a as unknown[])[(a as unknown[]).length - 1],
  count:    (a) => (a as unknown[]).length,
  join:     (a, b) => (a as unknown[]).join(b as string ?? ","),
  flatten:  (a) => (a as unknown[][]).flat(),
  uniq:     (a) => [...new Set(a as unknown[])],
  compact:  (a) => (a as unknown[]).filter(Boolean),
  merge:    (...args) => Object.assign({}, ...(args as object[])),

  // Aggregation
  sum:    (a) => (a as number[]).reduce((acc, n) => acc + n, 0),
  avg:    (a) => (a as number[]).reduce((acc, n) => acc + n, 0) / (a as number[]).length,
  median: (a) => {
    const sorted = [...(a as number[])].sort((x, y) => x - y)
    const mid    = Math.floor(sorted.length / 2)
    return sorted.length % 2 !== 0 ? sorted[mid]! : ((sorted[mid - 1]! + sorted[mid]!) / 2)
  },
  product: (a) => (a as number[]).reduce((acc, n) => acc * n, 1),

  // Object
  pick: (obj, ...keys) => {
    const o = obj as Record<string, unknown>
    return Object.fromEntries(
      (keys as string[]).map(k => [k, o[k]])
    )
  },
  omit: (obj, ...keys) => {
    const o   = obj  as Record<string, unknown>
    const set = new Set(keys as string[])
    return Object.fromEntries(
      Object.entries(o).filter(([k]) => !set.has(k))
    )
  },
  keys:   (a) => Object.keys(a   as object),
  values: (a) => Object.values(a as object),
  has:    (a, b) => Object.prototype.hasOwnProperty.call(a, b as string),

  // Type
  isNull:   (a) => a == null,
  isString: (a) => typeof a === "string",
  isNumber: (a) => typeof a === "number",
  isBool:   (a) => typeof a === "boolean",
  isArray:  (a) => Array.isArray(a),
  isObject: (a) => typeof a === "object" && a !== null && !Array.isArray(a),

  // Coerce
  toString: (a) => String(a),
  toNumber: (a) => Number(a),
  toBool:   (a) => Boolean(a),
  toJson:   (a) => JSON.stringify(a),
  fromJson: (a) => JSON.parse(a as string),

  // Null handling
  coalesce: (...args) => args.find(a => a != null),
  ifNull:   (a, b)    => a ?? b,
}

// ─────────────────────────────────────────────
// PATH RESOLVER
// Resolves "$.nodeId.field.nested" against context
// ─────────────────────────────────────────────

function resolvePath(path: string, ctx: ResolutionContext): unknown {
  // Strip leading "$."
  const normalized = path.startsWith("$.") ? path.slice(2) : path
  const parts      = normalized.split(".")
  const [root, ...rest] = parts

  if (!root) {
    throw new ResolutionError(`Empty path`, { type: "ref", path })
  }

  // Resolve root
  let current: unknown

  if (root === "trigger") {
    current = ctx.trigger
  } else if (root in ctx.nodes) {
    current = ctx.nodes[root]
  } else {
    throw new ResolutionError(
      `Cannot resolve root "${root}" — not found in context`,
      { type: "ref", path },
      path,
    )
  }

  // Traverse remaining segments
  for (const part of rest) {
    if (current == null) {
      throw new ResolutionError(
        `Cannot read "${part}" from null/undefined at path "${path}"`,
        { type: "ref", path },
        path,
      )
    }

    if (typeof current !== "object" && !Array.isArray(current)) {
      throw new ResolutionError(
        `Cannot traverse into non-object at "${part}" in path "${path}"`,
        { type: "ref", path },
        path,
      )
    }

    // Array index access — "items.0" or "items.2"
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[parseInt(part, 10)]
    } else {
      current = (current as Record<string, unknown>)[part]
    }
  }

  return current
}

// ─────────────────────────────────────────────
// EXPRESSION RESOLVER
// ─────────────────────────────────────────────

export class ExpressionResolver {

  private readonly fns: Record<string, BuiltinFn>

  constructor(extraFns?: Record<string, BuiltinFn>) {
    // Merge builtins with any plugin-registered functions
    this.fns = { ...BUILTINS, ...extraFns }
  }

  // ─── PRIMARY ENTRYPOINT ───────────────────

  resolve(expr: Expression, ctx: ResolutionContext): unknown {
    switch (expr.type) {

      // Static value — returned as-is
      case "literal":
        return expr.value

      // Path lookup — "$.nodeId.field.nested"
      case "ref":
        return resolvePath(expr.path, ctx)

      // String interpolation — concat all parts as strings
      case "template":
        return expr.parts
          .map(part => this.resolveAsString(part, ctx))
          .join("")

      // Build an array from expressions
      case "array":
        return expr.items.map(item => this.resolve(item, ctx))

      // Build an object from expressions
      case "object":
        return Object.fromEntries(
          Object.entries(expr.properties).map(([key, val]) => [
            key,
            this.resolve(val, ctx),
          ])
        )

      // Call a built-in (or plugin-registered) function
      case "fn": {
        const fn = this.fns[expr.name]
        if (!fn) {
          throw new ResolutionError(
            `Unknown function "${expr.name}"`,
            expr,
          )
        }
        const args = (expr.args ?? []).map(arg => this.resolve(arg, ctx))
        return fn(...args)
      }

      // Conditional — if → then | else
      case "cond": {
        const condition = this.resolve(expr.if, ctx)
        return condition
          ? this.resolve(expr.then, ctx)
          : this.resolve(expr.else, ctx)
      }

      // ── ITERATION & COMPOSITION ─────────────────────────────────────────

      // Pipe — chain expressions left-to-right
      // Each step receives the previous output as "$" in the context.
      //
      // Pipe-step conventions:
      //   fn   — if no args provided, current value is passed as implicit first arg
      //          e.g. .lower()  ≡  lower($)
      //          e.g. .split("@")  ≡  split($, "@")
      //   map/filter/reduce — "over" defaults to current value when omitted
      case "pipe": {
        if (expr.steps.length === 0) return undefined

        let current: unknown = undefined

        for (const [i, step] of expr.steps.entries()) {
          if (i === 0) {
            // First step — resolve normally against the flow context
            current = this.resolve(step, ctx)
          } else {
            const pipeCtx = this.withPipeValue(current, ctx)
            current = this.resolvePipeStep(step, current, pipeCtx)
          }
        }

        return current
      }

      // Map — transform every item in an array
      // "$.{as}" is available inside body
      case "map": {
        const arr = this.resolve(expr.over, ctx)
        if (!Array.isArray(arr)) {
          throw new ResolutionError(
            `map requires an array — got ${typeof arr}`,
            expr,
          )
        }
        return arr.map(item => {
          const itemCtx = this.withBinding(expr.as, item, ctx)
          return this.resolve(expr.body, itemCtx)
        })
      }

      // Filter — subset an array by condition
      // "$.{as}" is available inside where
      case "filter": {
        const arr = this.resolve(expr.over, ctx)
        if (!Array.isArray(arr)) {
          throw new ResolutionError(
            `filter requires an array — got ${typeof arr}`,
            expr,
          )
        }
        return arr.filter(item => {
          const itemCtx = this.withBinding(expr.as, item, ctx)
          return this.resolve(expr.where, itemCtx)
        })
      }

      // Reduce — fold an array into a single value
      // "$.{as}" is the current item, "$.{acc}" is the accumulator
      case "reduce": {
        const arr = this.resolve(expr.over, ctx)
        if (!Array.isArray(arr)) {
          throw new ResolutionError(
            `reduce requires an array — got ${typeof arr}`,
            expr,
          )
        }
        const init = this.resolve(expr.init, ctx)
        return arr.reduce((accumulator, item) => {
          const reduceCtx = this.withBindings(
            { [expr.as]: item, [expr.acc]: accumulator },
            ctx,
          )
          return this.resolve(expr.body, reduceCtx)
        }, init)
      }

      // Let — bind local variables scoped to body
      // Each binding is evaluated in order and available in body
      case "let": {
        const localBindings: Record<string, unknown> = {}
        for (const [key, valExpr] of Object.entries(expr.bindings)) {
          const letCtx = this.withBindings(localBindings, ctx)
          localBindings[key] = this.resolve(valExpr, letCtx)
        }
        const bodyCtx = this.withBindings(localBindings, ctx)
        return this.resolve(expr.body, bodyCtx)
      }
    }
  }

  // ─── RESOLVE ALL CONFIG FIELDS ───────────

  // Resolves an entire node config record at once
  // Returns plain values — the node never sees Expression types
  resolveConfig(
    config: Record<string, Expression>,
    ctx:    ResolutionContext,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(config).map(([key, expr]) => [
        key,
        this.resolve(expr, ctx),
      ])
    )
  }

  // ─── HELPERS ─────────────────────────────

  private resolveAsString(expr: Expression, ctx: ResolutionContext): string {
    const value = this.resolve(expr, ctx)
    if (value == null)            return ""
    if (typeof value === "object") return JSON.stringify(value)
    return String(value)
  }

  // ─── PIPE STEP RESOLVER ──────────────────────────────────────────

  // Resolves a single non-first pipe step with pipe-aware conventions:
  //   - fn with no args → current value injected as first arg
  //   - fn with args    → args resolved normally (current value in ctx as "$")
  //   - map/filter/reduce with no "over" → current value used as the array
  private resolvePipeStep(step: Expression, current: unknown, pipeCtx: ResolutionContext): unknown {
    switch (step.type) {

      // fn with no explicit args — pass current as implicit first arg
      // fn with explicit args    — resolve normally ($ still in context)
      case "fn": {
        const fn = this.fns[step.name]
        if (!fn) {
          throw new ResolutionError(`Unknown function "${step.name}"`, step)
        }
        if (!step.args || step.args.length === 0) {
          return fn(current)
        }
        const args = step.args.map(arg => this.resolve(arg, pipeCtx))
        return fn(current, ...args)
      }

      // map/filter/reduce — "over" is implicit (current array) when not provided
      case "map": {
        const arr = step.over ? this.resolve(step.over, pipeCtx) : current
        if (!Array.isArray(arr)) {
          throw new ResolutionError(`map requires an array — got ${typeof arr}`, step)
        }
        return arr.map(item => {
          const itemCtx = this.withBinding(step.as, item, pipeCtx)
          return this.resolve(step.body, itemCtx)
        })
      }

      case "filter": {
        const arr = step.over ? this.resolve(step.over, pipeCtx) : current
        if (!Array.isArray(arr)) {
          throw new ResolutionError(`filter requires an array — got ${typeof arr}`, step)
        }
        return arr.filter(item => {
          const itemCtx = this.withBinding(step.as, item, pipeCtx)
          return this.resolve(step.where, itemCtx)
        })
      }

      case "reduce": {
        const arr = step.over ? this.resolve(step.over, pipeCtx) : current
        if (!Array.isArray(arr)) {
          throw new ResolutionError(`reduce requires an array — got ${typeof arr}`, step)
        }
        const init = this.resolve(step.init, pipeCtx)
        return arr.reduce((accumulator, item) => {
          const reduceCtx = this.withBindings(
            { [step.as]: item, [step.acc]: accumulator },
            pipeCtx,
          )
          return this.resolve(step.body, reduceCtx)
        }, init)
      }

      // All other step types — resolve normally with $ in context
      default:
        return this.resolve(step, pipeCtx)
    }
  }

  // ─── CONTEXT HELPERS ─────────────────────────────────────────────

  // Returns a new context with "$" set to the pipe's current value
  private withPipeValue(value: unknown, ctx: ResolutionContext): ResolutionContext {
    return {
      ...ctx,
      nodes: { ...ctx.nodes, $: value },
    }
  }

  // Returns a new context with a single named binding added
  private withBinding(name: string, value: unknown, ctx: ResolutionContext): ResolutionContext {
    return {
      ...ctx,
      nodes: { ...ctx.nodes, [name]: value },
    }
  }

  // Returns a new context with multiple named bindings added
  private withBindings(bindings: Record<string, unknown>, ctx: ResolutionContext): ResolutionContext {
    return {
      ...ctx,
      nodes: { ...ctx.nodes, ...bindings },
    }
  }

  // Expose registered function names — used by compiler for validation
  getFunctionNames(): Set<string> {
    return new Set(Object.keys(this.fns))
  }
}
