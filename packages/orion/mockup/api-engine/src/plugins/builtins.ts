import type { NodeTypeDescriptor } from "./types"

// ─────────────────────────────────────────────
// BUILT-IN NODE TYPE DESCRIPTORS
// One entry per node in the final 18-node set.
// These are registered automatically on every PluginRegistry instance.
//
// Node set:
//   TRIGGERS (4)      trigger.webhook, trigger.cron, trigger.manual, trigger.event
//   TRANSFORM (4)     expr.pipeline, data.code, data.template, data.parse
//   FLOW CONTROL (6)  flow.merge, flow.delay, flow.each, flow.wait, flow.loop, flow.error
//   HTTP (2)          http.request, http.respond
//   AI (1)            ai
//   STORAGE (1)       store
// ─────────────────────────────────────────────

export const BUILTIN_DESCRIPTORS: NodeTypeDescriptor[] = [

  // ── TRIGGERS ───────────────────────────────

  {
    type:        "trigger.webhook",
    category:    "trigger",
    label:       "Webhook",
    description: "Starts a flow when an HTTP POST arrives at a configured path.",
    configSchema: {
      type: "object",
      properties: {
        path:   { type: "string" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      },
      required: ["path"],
    },
    outputSchema: {
      type: "object",
      properties: {
        body:    { type: "object" },
        headers: { type: "object" },
        query:   { type: "object" },
        method:  { type: "string" },
        path:    { type: "string" },
      },
    },
  },

  {
    type:        "trigger.cron",
    category:    "trigger",
    label:       "Cron",
    description: "Starts a flow on a cron schedule.",
    configSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Cron expression e.g. '0 * * * *'" },
        timezone:   { type: "string" },
      },
      required: ["expression"],
    },
    outputSchema: {
      type: "object",
      properties: {
        scheduledAt: { type: "number" },
        expression:  { type: "string" },
      },
    },
  },

  {
    type:        "trigger.manual",
    category:    "trigger",
    label:       "Manual",
    description: "Starts a flow via the POST /flows/:id/trigger API endpoint.",
    configSchema: {
      type: "object",
      properties: {
        schema: { type: "object", description: "Optional JSON Schema for the input payload" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        payload: { type: "object" },
      },
    },
  },

  {
    type:        "trigger.event",
    category:    "trigger",
    label:       "Event",
    description: "Starts a flow when a named event is emitted on the event bus.",
    configSchema: {
      type: "object",
      properties: {
        event: { type: "string", description: "Event name e.g. 'user.created'" },
      },
      required: ["event"],
    },
    outputSchema: {
      type: "object",
      properties: {
        event:   { type: "string" },
        payload: { type: "object" },
      },
    },
  },

  // ── TRANSFORM ──────────────────────────────

  {
    type:        "expr.pipeline",
    category:    "transform",
    label:       "Expression Pipeline",
    description: "Evaluates a sequence of expressions and writes the result to context.",
    configSchema: {
      type: "object",
      properties: {
        steps:  { type: "array",  description: "Array of Expression definitions" },
        output: { type: "string", description: "Context key to write result to" },
      },
      required: ["steps"],
    },
  },

  {
    type:        "data.code",
    category:    "transform",
    label:       "Code",
    description: "Runs an arbitrary JavaScript function with access to context data.",
    configSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript function body" },
      },
      required: ["code"],
    },
  },

  {
    type:        "data.template",
    category:    "transform",
    label:       "Template",
    description: "Renders a Mustache-style template string using context values.",
    configSchema: {
      type: "object",
      properties: {
        template: { type: "string" },
        output:   { type: "string" },
      },
      required: ["template"],
    },
    outputSchema: {
      type: "object",
      properties: {
        rendered: { type: "string" },
      },
    },
  },

  {
    type:        "data.parse",
    category:    "transform",
    label:       "Parse",
    description: "Parses a string value as JSON, CSV, XML, or YAML.",
    configSchema: {
      type: "object",
      properties: {
        input:  { type: "string", description: "Context ref to the string to parse" },
        format: { type: "string", enum: ["json", "csv", "xml", "yaml"] },
        output: { type: "string", description: "Context key to write parsed value to" },
      },
      required: ["input", "format"],
    },
    modes: ["json", "csv", "xml", "yaml"],
  },

  // ── FLOW CONTROL ───────────────────────────

  {
    type:        "flow.merge",
    category:    "flow-control",
    label:       "Merge",
    description: "Waits for all incoming branches to complete before continuing.",
  },

  {
    type:        "flow.delay",
    category:    "flow-control",
    label:       "Delay",
    description: "Pauses execution for a fixed or expression-defined duration.",
    configSchema: {
      type: "object",
      properties: {
        ms: { description: "Delay in milliseconds (Expression)" },
      },
      required: ["ms"],
    },
  },

  {
    type:        "flow.each",
    category:    "flow-control",
    label:       "Each",
    description: "Iterates over an array, executing the downstream subgraph for each item.",
    configSchema: {
      type: "object",
      properties: {
        over:   { description: "Expression that resolves to an array" },
        as:     { type: "string", description: "Context key for the current item (default: 'item')" },
        index:  { type: "string", description: "Context key for the current index (default: 'index')" },
        mode:   { type: "string", enum: ["parallel", "sequential"], description: "Default: parallel" },
      },
      required: ["over"],
    },
    modes: ["parallel", "sequential"],
  },

  {
    type:        "flow.wait",
    category:    "flow-control",
    label:       "Wait",
    description: "Pauses execution until an external event resumes it (long-running pause).",
    configSchema: {
      type: "object",
      properties: {
        event:      { type: "string", description: "Event name to wait for" },
        timeoutMs:  { description: "Maximum wait time in milliseconds" },
        resumeKey:  { type: "string", description: "Context key to write the resume payload to" },
      },
      required: ["event"],
    },
  },

  {
    type:        "flow.loop",
    category:    "flow-control",
    label:       "Loop",
    description: "Repeats a subgraph while a condition is true, up to a max iteration count.",
    configSchema: {
      type: "object",
      properties: {
        condition: { description: "Expression evaluated before each iteration" },
        maxIter:   { type: "number", description: "Safety limit (default: 100)" },
      },
      required: ["condition"],
    },
  },

  {
    type:        "flow.error",
    category:    "flow-control",
    label:       "Error Handler",
    description: "Catches errors from upstream nodes and routes them to a recovery path.",
    configSchema: {
      type: "object",
      properties: {
        from:    { type: "string", description: "nodeId of the node whose errors to catch" },
        capture: { type: "string", description: "Context key to write the error to" },
      },
      required: ["from"],
    },
    outputSchema: {
      type: "object",
      properties: {
        error:  { type: "string" },
        nodeId: { type: "string" },
      },
    },
  },

  // ── HTTP ───────────────────────────────────

  {
    type:        "http.request",
    category:    "http",
    label:       "HTTP Request",
    description: "Makes an outbound HTTP request.",
    configSchema: {
      type: "object",
      properties: {
        url:         { description: "Expression resolving to the URL string" },
        method:      { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] },
        headers:     { description: "Expression resolving to headers object" },
        body:        { description: "Expression resolving to the request body" },
        credential:  { type: "string", description: "Credential ID — headers injected automatically" },
        timeoutMs:   { type: "number" },
      },
      required: ["url"],
    },
    outputSchema: {
      type: "object",
      properties: {
        status:  { type: "number" },
        headers: { type: "object" },
        body:    { type: "object" },
        ok:      { type: "boolean" },
      },
    },
    modes: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
  },

  {
    type:        "http.respond",
    category:    "http",
    label:       "HTTP Respond",
    description: "Sends an HTTP response back to the webhook trigger that started the flow.",
    configSchema: {
      type: "object",
      properties: {
        status:  { description: "HTTP status code (Expression, default: 200)" },
        headers: { description: "Response headers (Expression)" },
        body:    { description: "Response body (Expression)" },
      },
    },
  },

  // ── AI ─────────────────────────────────────

  {
    type:        "ai",
    category:    "ai",
    label:       "AI",
    description: "Runs an AI model call — completion, embedding, classification, or extraction.",
    configSchema: {
      type: "object",
      properties: {
        credential: { type: "string", description: "Credential ID for the AI provider" },
        model:      { description: "Expression resolving to model identifier" },
        prompt:     { description: "Expression resolving to the prompt string (complete mode)" },
        input:      { description: "Expression resolving to input text (embed/classify/extract modes)" },
        schema:     { type: "object", description: "JSON Schema for structured extraction (extract mode)" },
        options:    { type: "object", description: "Additional model options (temperature, max_tokens, etc.)" },
      },
      required: ["credential", "model"],
    },
    outputSchema: {
      type: "object",
      properties: {
        result:     { description: "Model output — string (complete), number[] (embed), string (classify), object (extract)" },
        usage:      { type: "object", description: "Token usage stats" },
        model:      { type: "string" },
        finishReason: { type: "string" },
      },
    },
    modes: ["complete", "embed", "classify", "extract"],
  },

  // ── STORAGE ────────────────────────────────

  {
    type:        "store",
    category:    "storage",
    label:       "Store",
    description: "Reads, writes, or deletes a value from the key-value execution store.",
    configSchema: {
      type: "object",
      properties: {
        key:        { description: "Expression resolving to the store key" },
        value:      { description: "Expression resolving to the value to write (set mode)" },
        output:     { type: "string", description: "Context key to write retrieved value to (get mode)" },
        ttlMs:      { type: "number", description: "Time-to-live in milliseconds (set mode, optional)" },
      },
      required: ["key"],
    },
    outputSchema: {
      type: "object",
      properties: {
        value:  { description: "Retrieved value (get mode)" },
        found:  { type: "boolean" },
        key:    { type: "string" },
      },
    },
    modes: ["get", "set", "delete"],
  },

]

// ─────────────────────────────────────────────
// BUILT-IN EXPRESSION FUNCTION NAMES
// Returned by PluginRegistry.getFunctionNames() so the compiler
// can validate fn-type expressions against known functions.
// Mirrors the keys in ExpressionResolver's BUILTINS object.
// ─────────────────────────────────────────────

export const BUILTIN_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  // Comparison
  "gt", "lt", "gte", "lte", "eq", "neq",
  // Logic
  "and", "or", "not",
  // Math
  "add", "sub", "mul", "div", "round", "floor", "ceil", "abs", "min", "max",
  // String
  "concat", "upper", "lower", "trim", "length", "includes",
  "startsWith", "endsWith", "replace", "split", "slice",
  // Array
  "first", "last", "count", "join", "flatten", "uniq", "compact", "merge",
  // Aggregation
  "sum", "avg", "median", "product",
  // Object
  "pick", "omit", "keys", "values", "entries", "has", "get", "set",
  // Type
  "isNull", "isString", "isNumber", "isBoolean", "isArray", "isObject",
  // Coerce
  "toNumber", "toString", "toBoolean", "toArray",
  // Date/time
  "now", "dateFormat", "dateParse", "dateAdd",
])
