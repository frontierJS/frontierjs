import type {
  Flow,
  Edge,
  Expression,
  ExecutionPlan,
  ExecutionStage,
  ExecutionEdge,
  CompilationError,
  NodeDefinition,
  JSONSchema,
} from "../types"

// ─────────────────────────────────────────────
// PLUGIN REGISTRY INTERFACE
// ─────────────────────────────────────────────

export interface IPluginRegistry {
  has(type: string): boolean
  isTrigger(type: string): boolean
  isErrorHandler(type: string): boolean   // is this a flow.error node?
  isLoopNode(type: string): boolean       // is this a flow.loop node?
  isStoreNode(type: string): boolean      // is this a store node?
  isAiNode(type: string): boolean         // is this an ai node?
  getOutputSchema(type: string): JSONSchema | undefined
  getInputSchema(type: string):  JSONSchema | undefined
  getFunctionNames(): Set<string>
}

// ─────────────────────────────────────────────
// COMPILER RESULT
// ─────────────────────────────────────────────

export type CompilerResult =
  | { ok: true;  plan: ExecutionPlan }
  | { ok: false; errors: CompilationError[] }

// ─────────────────────────────────────────────
// PIPELINE CONTEXT
// ─────────────────────────────────────────────

interface PipelineContext {
  flow:        Flow
  registry:    IPluginRegistry
  errors:      CompilationError[]
  adjacency:   Map<string, string[]>
  inDegree:    Map<string, number>
  nodeStage:   Map<string, number>    // nodeId → stage index
  triggerIds:  string[]
  stages:      ExecutionStage[]
  routing:     Record<string, ExecutionEdge[]>
  statics:     Record<string, unknown>
}

// ─────────────────────────────────────────────
// COMPILER
// ─────────────────────────────────────────────

export class Compiler {

  constructor(private readonly registry: IPluginRegistry) {}

  compile(flow: Flow): CompilerResult {
    const ctx: PipelineContext = {
      flow,
      registry:   this.registry,
      errors:     [],
      adjacency:  new Map(),
      inDegree:   new Map(),
      nodeStage:  new Map(),
      triggerIds: [],
      stages:     [],
      routing:    {},
      statics:    {},
    }

    pipe(ctx,
      validateNodes,            // do nodes exist and have valid types?
      validateEdges,            // do edges reference real nodes?
      buildGraph,               // build adjacency + inDegree maps
      detectCycles,             // is this a DAG?
      buildStages,              // topological sort → parallel stages
      buildRoutingIndex,        // pre-compute O(1) edge routing
      detectTriggers,           // find entry nodes, validate trigger types
      validateErrorEdges,       // error edges → flow.error nodes; error nodes reachable?
      validateLoopNodes,        // flow.loop has required config + valid maxRuns
      validateNodeModes,        // store + ai nodes have valid mode config
      validateExpressions,      // do all $.refs point to real upstream data?
      validateExpressionForms,  // are all expressions structurally valid?
      validateSchemas,          // are declared input/output schemas compatible?
      preEvaluateStatics,       // resolve all literals at compile time
    )

    if (ctx.errors.length > 0) {
      return { ok: false, errors: ctx.errors }
    }

    return {
      ok: true,
      plan: {
        flowId:      flow.id,
        version:     flow.version,
        compiledAt:  Date.now(),
        stages:      ctx.stages,
        nodes:       flow.nodes,
        triggerIds:  ctx.triggerIds,
        statics:     ctx.statics,
        routing:     ctx.routing,
        nodeCount:   Object.keys(flow.nodes).length,
        stageCount:  ctx.stages.length,
        hasBranching: flow.edges.some(e => e.condition != null),
        hasFanOut:    flow.edges.some(e => e.fanOut    != null),
      },
    }
  }
}

// ─────────────────────────────────────────────
// PIPELINE RUNNER
// ─────────────────────────────────────────────

type PipelineStep = (ctx: PipelineContext) => void

function pipe(ctx: PipelineContext, ...steps: PipelineStep[]): void {
  for (const step of steps) {
    step(ctx)
    if (hasFatalError(ctx)) return
  }
}

function hasFatalError(ctx: PipelineContext): boolean {
  const fatal = new Set(["NO_NODES", "CYCLE_DETECTED"])
  return ctx.errors.some(e => fatal.has(e.code))
}

// ─────────────────────────────────────────────
// STEP 1 — VALIDATE NODES
// ─────────────────────────────────────────────

function validateNodes(ctx: PipelineContext): void {
  const { flow, registry, errors } = ctx
  const nodeIds = Object.keys(flow.nodes)

  if (nodeIds.length === 0) {
    errors.push({ code: "NO_NODES", message: "Flow has no nodes" })
    return
  }

  for (const [id, node] of Object.entries(flow.nodes)) {
    if (!registry.has(node.type)) {
      errors.push({
        code:    "UNKNOWN_NODE_TYPE",
        message: `Node "${id}" has unknown type: "${node.type}"`,
        nodeId:  id,
      })
    }
  }
}

// ─────────────────────────────────────────────
// STEP 2 — VALIDATE EDGES
// ─────────────────────────────────────────────

function validateEdges(ctx: PipelineContext): void {
  const { flow, errors } = ctx

  for (const edge of flow.edges) {
    if (!flow.nodes[edge.from]) {
      errors.push({
        code:    "INVALID_EDGE_SOURCE",
        message: `Edge "${edge.id}" references unknown source node: "${edge.from}"`,
        edgeId:  edge.id,
      })
    }
    if (!flow.nodes[edge.to]) {
      errors.push({
        code:    "INVALID_EDGE_TARGET",
        message: `Edge "${edge.id}" references unknown target node: "${edge.to}"`,
        edgeId:  edge.id,
      })
    }
  }
}

// ─────────────────────────────────────────────
// STEP 3 — BUILD GRAPH
// ─────────────────────────────────────────────

function buildGraph(ctx: PipelineContext): void {
  const { flow, adjacency, inDegree } = ctx

  for (const id of Object.keys(flow.nodes)) {
    adjacency.set(id, [])
    inDegree.set(id, 0)
  }

  for (const edge of flow.edges) {
    if (!flow.nodes[edge.from] || !flow.nodes[edge.to]) continue
    adjacency.get(edge.from)!.push(edge.to)
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1)
  }
}

// ─────────────────────────────────────────────
// STEP 4 — DETECT CYCLES
// DFS with visiting set — O(V + E)
// ─────────────────────────────────────────────

function detectCycles(ctx: PipelineContext): void {
  const { flow, adjacency, errors } = ctx
  const visited  = new Set<string>()
  const visiting = new Set<string>()

  function dfs(id: string): boolean {
    if (visiting.has(id)) return true
    if (visited.has(id))  return false

    visiting.add(id)
    for (const neighbor of adjacency.get(id) ?? []) {
      if (dfs(neighbor)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }

  for (const id of Object.keys(flow.nodes)) {
    if (dfs(id)) {
      errors.push({ code: "CYCLE_DETECTED", message: "Flow contains a cycle — must be a DAG" })
      return
    }
  }
}

// ─────────────────────────────────────────────
// STEP 5 — BUILD STAGES
// Kahn's algorithm — O(V + E)
// ─────────────────────────────────────────────

function buildStages(ctx: PipelineContext): void {
  const { flow, adjacency, inDegree, stages, nodeStage } = ctx
  const degree    = new Map(inDegree)
  const edgeIndex = buildEdgeIndex(flow.edges)

  while (degree.size > 0) {
    const ready = [...degree.entries()]
      .filter(([_, d]) => d === 0)
      .map(([id]) => id)

    if (ready.length === 0) break

    const stageIndex = stages.length

    stages.push({
      index: stageIndex,
      nodes: ready,
      edges: Object.fromEntries(
        ready.map(id => [id, edgeIndex.get(id) ?? []])
      ),
    })

    for (const id of ready) {
      nodeStage.set(id, stageIndex)
      degree.delete(id)
      for (const neighbor of adjacency.get(id) ?? []) {
        degree.set(neighbor, (degree.get(neighbor) ?? 0) - 1)
      }
    }
  }
}

function buildEdgeIndex(edges: Edge[]): Map<string, Edge[]> {
  const index = new Map<string, Edge[]>()
  for (const edge of edges) {
    if (!index.has(edge.from)) index.set(edge.from, [])
    index.get(edge.from)!.push(edge)
  }
  return index
}

// ─────────────────────────────────────────────
// STEP 6 — BUILD ROUTING INDEX
// Pre-compute O(1) edge routing — runtime never traverses the graph
// ─────────────────────────────────────────────

function buildRoutingIndex(ctx: PipelineContext): void {
  const { flow, nodeStage, routing } = ctx

  for (const edge of flow.edges) {
    if (!routing[edge.from]) routing[edge.from] = []

    routing[edge.from].push({
      edge,
      sourceStage: nodeStage.get(edge.from) ?? -1,
      targetStage: nodeStage.get(edge.to)   ?? -1,
    })
  }
}

// ─────────────────────────────────────────────
// STEP 7 — DETECT TRIGGERS
// ─────────────────────────────────────────────

function detectTriggers(ctx: PipelineContext): void {
  const { flow, inDegree, registry, triggerIds, errors } = ctx

  for (const [id, degree] of inDegree.entries()) {
    if (degree === 0) {
      const node = flow.nodes[id]
      if (!registry.isTrigger(node.type)) {
        errors.push({
          code:    "INVALID_ENTRY_NODE",
          message: `Node "${id}" has no incoming edges but is not a trigger type`,
          nodeId:  id,
        })
      } else {
        triggerIds.push(id)
      }
    }
  }
}

// ─────────────────────────────────────────────
// STEP 8 — VALIDATE EXPRESSIONS (ref paths)
// ─────────────────────────────────────────────

function validateExpressions(ctx: PipelineContext): void {
  const { flow, stages, registry, errors } = ctx
  const available = new Set<string>(["trigger"])

  for (const stage of stages) {
    for (const nodeId of stage.nodes) {
      const node = flow.nodes[nodeId]

      // Loop nodes expose their own runtime state (index, current, isFirst, isLast)
      // in breakWhen — so they are available to themselves for that field only
      const isLoop = registry.isLoopNode(node.type)

      for (const [field, expr] of Object.entries(node.config)) {
        const fieldAvailable = (isLoop && field === "breakWhen")
          ? new Set([...available, nodeId])
          : available

        const invalidRefs = findInvalidRefs(expr, fieldAvailable)
        for (const ref of invalidRefs) {
          errors.push({
            code:    "INVALID_REF",
            message: `Node "${nodeId}" config "${field}" references unknown path: "${ref}"`,
            nodeId,
          })
        }
      }
    }
    for (const nodeId of stage.nodes) available.add(nodeId)
  }
}

function findInvalidRefs(expr: Expression, available: Set<string>): string[] {
  const invalid: string[] = []

  switch (expr.type) {
    case "ref": {
      const root = expr.path.replace(/^\$\./, "").split(".")[0]
      if (!available.has(root)) invalid.push(expr.path)
      break
    }
    case "template":
      for (const part of expr.parts)    invalid.push(...findInvalidRefs(part, available))
      break
    case "array":
      for (const item of expr.items)    invalid.push(...findInvalidRefs(item, available))
      break
    case "object":
      for (const val of Object.values(expr.properties)) invalid.push(...findInvalidRefs(val, available))
      break
    case "fn":
      for (const arg of expr.args)      invalid.push(...findInvalidRefs(arg, available))
      break
    case "cond":
      // Guard: malformed cond may be missing branches — INVALID_EXPRESSION
      // catches the structural error, findInvalidRefs just skips undefined branches
      if (expr.if)   invalid.push(...findInvalidRefs(expr.if,   available))
      if (expr.then) invalid.push(...findInvalidRefs(expr.then, available))
      if (expr.else) invalid.push(...findInvalidRefs(expr.else, available))
      break
    case "pipe":
      for (const step of expr.steps) invalid.push(...findInvalidRefs(step, available))
      break
    case "map": {
      invalid.push(...findInvalidRefs(expr.over, available))
      // "as" binding is available inside body
      const mapAvailable = new Set([...available, expr.as])
      invalid.push(...findInvalidRefs(expr.body, mapAvailable))
      break
    }
    case "filter": {
      invalid.push(...findInvalidRefs(expr.over, available))
      const filterAvailable = new Set([...available, expr.as])
      invalid.push(...findInvalidRefs(expr.where, filterAvailable))
      break
    }
    case "reduce": {
      invalid.push(...findInvalidRefs(expr.over, available))
      invalid.push(...findInvalidRefs(expr.init, available))
      const reduceAvailable = new Set([...available, expr.as, expr.acc])
      invalid.push(...findInvalidRefs(expr.body, reduceAvailable))
      break
    }
    case "let": {
      const letAvailable = new Set(available)
      for (const [key, val] of Object.entries(expr.bindings)) {
        invalid.push(...findInvalidRefs(val, letAvailable))
        letAvailable.add(key)  // each binding available to subsequent ones
      }
      invalid.push(...findInvalidRefs(expr.body, letAvailable))
      break
    }
    case "literal":
      break
  }

  return invalid
}

// ─────────────────────────────────────────────
// STEP 9 — VALIDATE EXPRESSION FORMS
// Structural validity — are expressions well-formed?
// ─────────────────────────────────────────────

function validateExpressionForms(ctx: PipelineContext): void {
  const { flow, errors, registry } = ctx
  const knownFns = registry.getFunctionNames()

  function validate(expr: Expression, nodeId: string, field: string): void {
    switch (expr.type) {
      case "ref":
        if (!expr.path || !expr.path.startsWith("$.")) {
          errors.push({
            code:    "INVALID_EXPRESSION",
            message: `Node "${nodeId}" config "${field}": ref path must start with "$." — got "${expr.path}"`,
            nodeId,
          })
        }
        break

      case "template":
        if (!expr.parts || expr.parts.length === 0) {
          errors.push({
            code:    "INVALID_EXPRESSION",
            message: `Node "${nodeId}" config "${field}": template expression has no parts`,
            nodeId,
          })
        }
        for (const part of expr.parts ?? []) validate(part, nodeId, field)
        break

      case "array":
        for (const item of expr.items ?? []) validate(item, nodeId, field)
        break

      case "object":
        for (const val of Object.values(expr.properties ?? {})) validate(val, nodeId, field)
        break

      case "fn":
        if (!expr.name) {
          errors.push({
            code:    "INVALID_EXPRESSION",
            message: `Node "${nodeId}" config "${field}": fn expression missing name`,
            nodeId,
          })
        } else if (knownFns.size > 0 && !knownFns.has(expr.name)) {
          errors.push({
            code:    "INVALID_EXPRESSION",
            message: `Node "${nodeId}" config "${field}": unknown function "${expr.name}"`,
            nodeId,
          })
        }
        for (const arg of expr.args ?? []) validate(arg, nodeId, field)
        break

      case "cond":
        if (!expr.if || !expr.then || !expr.else) {
          errors.push({
            code:    "INVALID_EXPRESSION",
            message: `Node "${nodeId}" config "${field}": cond expression requires if, then, and else`,
            nodeId,
          })
        } else {
          validate(expr.if,   nodeId, field)
          validate(expr.then, nodeId, field)
          validate(expr.else, nodeId, field)
        }
        break

      case "pipe":
        if (!expr.steps || expr.steps.length === 0) {
          errors.push({
            code:    "INVALID_EXPRESSION",
            message: `Node "${nodeId}" config "${field}": pipe expression has no steps`,
            nodeId,
          })
        }
        for (const step of expr.steps ?? []) validate(step, nodeId, field)
        break

      case "map":
        if (!expr.as) {
          errors.push({
            code:    "INVALID_EXPRESSION",
            message: `Node "${nodeId}" config "${field}": map expression missing "as" binding`,
            nodeId,
          })
        }
        if (expr.over)  validate(expr.over,  nodeId, field)
        if (expr.body)  validate(expr.body,  nodeId, field)
        break

      case "filter":
        if (!expr.as) {
          errors.push({
            code:    "INVALID_EXPRESSION",
            message: `Node "${nodeId}" config "${field}": filter expression missing "as" binding`,
            nodeId,
          })
        }
        if (expr.over)  validate(expr.over,  nodeId, field)
        if (expr.where) validate(expr.where, nodeId, field)
        break

      case "reduce":
        if (!expr.as || !expr.acc) {
          errors.push({
            code:    "INVALID_EXPRESSION",
            message: `Node "${nodeId}" config "${field}": reduce expression requires "as" and "acc"`,
            nodeId,
          })
        }
        if (expr.over) validate(expr.over, nodeId, field)
        if (expr.init) validate(expr.init, nodeId, field)
        if (expr.body) validate(expr.body, nodeId, field)
        break

      case "let":
        if (!expr.bindings || Object.keys(expr.bindings).length === 0) {
          errors.push({
            code:    "INVALID_EXPRESSION",
            message: `Node "${nodeId}" config "${field}": let expression has no bindings`,
            nodeId,
          })
        }
        for (const val of Object.values(expr.bindings ?? {})) validate(val, nodeId, field)
        if (expr.body) validate(expr.body, nodeId, field)
        break

      case "literal":
        break
    }
  }

  for (const [nodeId, node] of Object.entries(flow.nodes)) {
    for (const [field, expr] of Object.entries(node.config)) {
      validate(expr, nodeId, field)
    }
  }
}

// ─────────────────────────────────────────────
// STEP 10 — VALIDATE SCHEMAS
// Check input/output compatibility across edges
// Only fires when both sides declare schemas — opt-in strictness
// ─────────────────────────────────────────────

function validateSchemas(ctx: PipelineContext): void {
  const { flow, registry, errors } = ctx

  for (const edge of flow.edges) {
    const sourceNode = flow.nodes[edge.from]
    const targetNode = flow.nodes[edge.to]

    if (!sourceNode || !targetNode) continue

    // Prefer instance-level outputSchema, fall back to plugin manifest
    const outputSchema = sourceNode.outputSchema
      ?? registry.getOutputSchema(sourceNode.type)

    const inputSchema = registry.getInputSchema(targetNode.type)

    // Only validate when both sides declare schemas
    if (!outputSchema || !inputSchema) continue

    if (!schemasCompatible(outputSchema, inputSchema)) {
      errors.push({
        code:    "SCHEMA_MISMATCH",
        message: `Edge "${edge.id}": output of "${edge.from}" (${outputSchema.type}) is incompatible with input of "${edge.to}" (${inputSchema.type})`,
        edgeId:  edge.id,
      })
    }
  }
}

function schemasCompatible(output: JSONSchema, input: JSONSchema): boolean {
  // Top-level type must match
  if (output.type !== input.type) return false

  // If input declares required properties, they must exist in output
  if (input.type === "object" && input.required && output.properties) {
    for (const key of input.required) {
      const outProp = output.properties[key]
      const inProp  = input.properties?.[key]

      if (!outProp) return false
      if (inProp && !schemasCompatible(outProp, inProp)) return false
    }
  }

  return true
}

// ─────────────────────────────────────────────
// STEP 8b — VALIDATE ERROR EDGES
// Error edges must point to flow.error nodes
// flow.error nodes must have at least one incoming error edge
// ─────────────────────────────────────────────

function validateErrorEdges(ctx: PipelineContext): void {
  const { flow, registry, errors } = ctx

  const errorEdges     = flow.edges.filter(e => e.kind === "error")
  const errorNodeIds   = new Set(
    Object.entries(flow.nodes)
      .filter(([_, n]) => registry.isErrorHandler(n.type))
      .map(([id]) => id)
  )
  const reachedByError = new Set<string>()

  for (const edge of errorEdges) {
    const target = flow.nodes[edge.to]
    if (!target) continue  // caught by validateEdges

    if (!registry.isErrorHandler(target.type)) {
      errors.push({
        code:    "INVALID_ERROR_EDGE",
        message: `Error edge "${edge.id}" points to "${edge.to}" which is not a flow.error node`,
        edgeId:  edge.id,
      })
    } else {
      reachedByError.add(edge.to)
    }
  }

  // Any flow.error node with no incoming error edge is unreachable
  for (const id of errorNodeIds) {
    if (!reachedByError.has(id)) {
      errors.push({
        code:    "UNREACHABLE_ERROR_NODE",
        message: `flow.error node "${id}" has no incoming error edges — it will never execute`,
        nodeId:  id,
      })
    }
  }
}

// ─────────────────────────────────────────────
// STEP 8c — VALIDATE LOOP NODES
// flow.loop must declare "over" and "as" config fields
// maxRuns must be a positive literal integer
// ─────────────────────────────────────────────

function validateLoopNodes(ctx: PipelineContext): void {
  const { flow, registry, errors } = ctx

  for (const [id, node] of Object.entries(flow.nodes)) {
    if (!registry.isLoopNode(node.type)) continue

    // Must have "over" config field
    if (!node.config["over"]) {
      errors.push({
        code:    "INVALID_LOOP_CONFIG",
        message: `flow.loop node "${id}" is missing required config field "over"`,
        nodeId:  id,
      })
    }

    // Must have "as" config field
    if (!node.config["as"]) {
      errors.push({
        code:    "INVALID_LOOP_CONFIG",
        message: `flow.loop node "${id}" is missing required config field "as"`,
        nodeId:  id,
      })
    }

    // If maxRuns is provided it must be a positive literal integer
    const maxRuns = node.config["maxRuns"]
    if (maxRuns) {
      if (maxRuns.type !== "literal") {
        errors.push({
          code:    "INVALID_LOOP_CONFIG",
          message: `flow.loop node "${id}" maxRuns must be a literal number — dynamic values not allowed`,
          nodeId:  id,
        })
      } else if (
        typeof maxRuns.value !== "number" ||
        !Number.isInteger(maxRuns.value) ||
        maxRuns.value < 1
      ) {
        errors.push({
          code:    "INVALID_LOOP_CONFIG",
          message: `flow.loop node "${id}" maxRuns must be a positive integer — got ${maxRuns.value}`,
          nodeId:  id,
        })
      }
    }
  }
}

// ─────────────────────────────────────────────
// STEP 9b — VALIDATE NODE MODES
// store and ai are mode-driven nodes — mode must be a valid literal
// ─────────────────────────────────────────────

const STORE_MODES = new Set(["get", "set", "delete"])
const AI_MODES    = new Set(["complete", "embed", "classify", "extract"])

function validateNodeModes(ctx: PipelineContext): void {
  const { flow, registry, errors } = ctx

  for (const [id, node] of Object.entries(flow.nodes)) {
    if (registry.isStoreNode(node.type)) {
      validateMode(id, node, STORE_MODES, errors)
    } else if (registry.isAiNode(node.type)) {
      validateMode(id, node, AI_MODES, errors)
    }
  }
}

function validateMode(
  nodeId: string,
  node:   NodeDefinition,
  valid:  Set<string>,
  errors: CompilationError[],
): void {
  const modeExpr = node.config["mode"]

  if (!modeExpr) {
    errors.push({
      code:    "INVALID_NODE_MODE",
      message: `Node "${nodeId}" (${node.type}) is missing required config field "mode"`,
      nodeId,
    })
    return
  }

  if (modeExpr.type !== "literal") {
    errors.push({
      code:    "INVALID_NODE_MODE",
      message: `Node "${nodeId}" (${node.type}) mode must be a literal — got expression type "${modeExpr.type}"`,
      nodeId,
    })
    return
  }

  if (!valid.has(modeExpr.value as string)) {
    errors.push({
      code:    "INVALID_NODE_MODE",
      message: `Node "${nodeId}" (${node.type}) has invalid mode "${modeExpr.value}" — valid: ${[...valid].join(", ")}`,
      nodeId,
    })
  }
}

// ─────────────────────────────────────────────
// STEP 11 — PRE-EVALUATE STATICS
// ─────────────────────────────────────────────

function preEvaluateStatics(ctx: PipelineContext): void {
  const { flow, statics } = ctx

  for (const [nodeId, node] of Object.entries(flow.nodes)) {
    for (const [field, expr] of Object.entries(node.config)) {
      if (expr.type === "literal") {
        statics[`${nodeId}.${field}`] = expr.value
      }
    }
  }
}
