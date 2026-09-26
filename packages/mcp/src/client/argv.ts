/*
 * src/client/argv.ts — a tool's input schema read as a command line.
 *
 * The CLI's commands are the tools `tools/list` answers at the caller's
 * standing (`FJS-D396`), spelled as the tool is (`FJS-D403`): `servers_reboot`
 * is `servers reboot`. This file is the pure half — no connection, no terminal —
 * so it is graded against every tool two real apps publish rather than against
 * a hand-written schema.
 *
 * The schema is the authority for what a value MEANS. A flag typed `string`
 * keeps `0012` as text; a flag typed `integer` refuses `12a` here, by name,
 * rather than letting the SDK's validator refuse a payload the person never
 * saw. Only a value the schema does not type falls back to
 * `@frontierjs/toolbelt/query`'s reading, which is what the same text would
 * mean on a URL.
 *
 * Nested input is a FILE, never a flag grammar: a `Json` column, an array, a
 * `$ref` and an undescribed payload take a JSON literal, `@path` or `-` for
 * stdin. The structure a flag does spell — a find filter's operator, an untyped
 * directive — is written in the wire's own bracket notation, `--total[gte] 5`
 * and `--orderBy[createdAt] desc`, so the command line and the URL are one
 * language (Invariant 10).
 *
 * Moves here once the CLI package is named; nothing below knows it lives in mcp.
 */

import { parseParams, parseValue, isNumericLiteral } from '@frontierjs/toolbelt/query'

// ─── the shape ───────────────────────────────────────────────────────────────

export interface ToolListing {
  name:         string
  description?: string
  inputSchema?: JsonSchema
}

type JsonSchema = Record<string, unknown>

/** Where a flag's value lands in the tool's arguments. */
export type Slot = 'args' | 'data' | 'query' | 'directives'

/** `any` is a value the schema does not type — a directive like `orderBy` — read as the URL reads it. */
export type FlagType = 'string' | 'integer' | 'number' | 'boolean' | 'json' | 'any'

export interface Flag {
  name:        string
  slot:        Slot
  type:        FlagType
  required:    boolean
  nullable:    boolean
  enum?:       string[]
  description?: string
  /** A find filter, which also takes `--name[op] value`. */
  filter:      boolean
  /** Takes bracket notation: a filter's operator, or an untyped value's structure. */
  brackets:    boolean
}

/**
 * What the command's payload is, for help and for the measurement:
 *   flags        every field is a flag
 *   flags+json   flags, and at least one field that takes JSON
 *   undescribed  the payload is `--data` only — the seed says nothing about it
 *   none         nothing beyond the id
 */
export type Payload = 'flags' | 'flags+json' | 'undescribed' | 'none'

export interface Command {
  tool:        string
  service:     string
  method:      string
  description: string
  /** `id`, taken as the first bare word — or null when the tool takes none. */
  id:          { required: boolean } | null
  flags:       Flag[]
  /** The flag that takes the whole payload object — `--data`, or `--query` on a find. */
  whole:       { name: 'data' | 'query'; slot: Slot } | null
  payload:     Payload
}

export class ArgvError extends Error {
  constructor(message: string, readonly flag?: string) {
    super(message)
    this.name = 'ArgvError'
  }
}

// ─── schema reading ──────────────────────────────────────────────────────────

const OPERATOR = 'An operator'

const props = (s: unknown): Record<string, JsonSchema> =>
  ((s as JsonSchema | undefined)?.properties ?? {}) as Record<string, JsonSchema>

const isOperator = (s: JsonSchema) =>
  s.type === 'object' && typeof s.description === 'string' && s.description.startsWith(OPERATOR)

/**
 * One property → its flag type. `anyOf [T, null]`, `type: [T, 'null']` and a
 * find column's `anyOf [T, operator]` all read as T; anything not a scalar is
 * JSON.
 */
function readScalar(s: JsonSchema): { type: FlagType; nullable: boolean; enum?: string[] } {
  if (Array.isArray(s.anyOf)) {
    const branches = (s.anyOf as JsonSchema[]).filter(b => b.type !== 'null' && !isOperator(b))
    const nullable = (s.anyOf as JsonSchema[]).some(b => b.type === 'null')
    if (branches.length !== 1) return { type: 'json', nullable }
    const inner = readScalar(branches[0])
    return { ...inner, nullable: nullable || inner.nullable }
  }
  if ('$ref' in s) return { type: 'json', nullable: false }

  if (s.type === undefined && !('enum' in s)) return { type: 'any', nullable: false }

  const types    = Array.isArray(s.type) ? s.type as string[] : [s.type as string]
  const nullable = types.includes('null')
  const real     = types.filter(t => t !== 'null')
  const enumVals = Array.isArray(s.enum) ? (s.enum as unknown[]).filter(v => v !== null).map(String) : undefined

  if (real.length !== 1) return { type: 'json', nullable }
  const t = real[0]
  if (t === 'string' || t === 'integer' || t === 'number' || t === 'boolean')
    return { type: t, nullable, ...(enumVals ? { enum: enumVals } : {}) }
  return { type: 'json', nullable }
}

function flagsOf(schema: JsonSchema | undefined, slot: Slot, filter = false): Flag[] {
  const required = new Set((schema?.required as string[] | undefined) ?? [])
  const out: Flag[] = []
  for (const [name, s] of Object.entries(props(schema))) {
    // A server-owned column is not the caller's to write. Refused as an unknown
    // flag, which is the honest answer, rather than sent and silently dropped.
    if (s.readOnly === true && !filter) continue
    const r = readScalar(s)
    out.push({
      name, slot, filter,
      brackets: filter || r.type === 'any',
      type:     r.type,
      nullable: r.nullable,
      required: required.has(name),
      ...(r.enum ? { enum: r.enum } : {}),
      ...(typeof s.description === 'string' ? { description: s.description } : {}),
    })
  }
  return out
}

function payloadOf(flags: Flag[], whole: Command['whole'], described: boolean): Payload {
  if (!described) return whole ? 'undescribed' : 'none'
  const own = flags.filter(f => f.slot !== 'directives')
  if (!own.length) return whole ? 'undescribed' : 'none'
  return own.some(f => f.type === 'json') ? 'flags+json' : 'flags'
}

/**
 * One tool → the command a person types.
 *
 * The service is everything before the LAST underscore: a method name is
 * camelCase and never carries one, while a service name can (`toolName` maps
 * any illegal character to `_`).
 */
export function commandFor(tool: ToolListing): Command {
  const cut     = tool.name.lastIndexOf('_')
  const service = cut > 0 ? tool.name.slice(0, cut) : tool.name
  const method  = cut > 0 ? tool.name.slice(cut + 1) : ''
  const schema  = tool.inputSchema ?? {}
  const top     = props(schema)
  const req     = new Set((schema.required as string[] | undefined) ?? [])

  const id = 'id' in top ? { required: req.has('id') } : null

  let flags: Flag[]
  let whole: Command['whole']
  let described: boolean

  if ('query' in top) {
    // A find. Filters and directives are two slots on the wire (Invariant 10)
    // and one namespace on a command line, so a column named `limit` would
    // silently become the directive. The directive keeps the flag; the column is
    // still reachable through `--query`.
    const directives = flagsOf(top.directives, 'directives')
    const taken      = new Set(directives.map(f => f.name))
    flags     = [...flagsOf(top.query, 'query', true).filter(f => !taken.has(f.name)), ...directives]
    whole     = { name: 'query', slot: 'query' }
    described = Object.keys(props(top.query)).length > 0
  } else if ('data' in top && Object.keys(top).every(k => k === 'id' || k === 'data')) {
    // `{ id, data }` is the shape the projection gives a patch and a custom
    // method. A create whose MODEL has a column named `data` (`secrets.create`)
    // has it among its other columns, and there it is a field like any other.
    flags     = flagsOf(top.data, 'data')
    whole     = { name: 'data', slot: 'data' }
    described = Object.keys(props(top.data)).length > 0
  } else {
    // An empty `properties` is the wire's placeholder for NO schema (`aggregate`),
    // which is *undescribed*, not *takes nothing*.
    const rest = Object.fromEntries(Object.entries(top).filter(([k]) => k !== 'id'))
    flags      = flagsOf({ ...schema, properties: rest }, 'args')
    whole      = Object.keys(top).length === 0 || Object.keys(rest).length > 0
      ? { name: 'data', slot: 'args' } : null
    described  = Object.keys(rest).length > 0
  }

  // A column named like the whole-payload flag keeps the flag — `Secret.data` is
  // `--data` on `secrets create` and `secrets patch` — and that command has no
  // whole-payload flag, rather than one flag meaning two things.
  if (whole && flags.some(f => f.name === whole!.name)) whole = null

  return {
    tool: tool.name, service, method,
    description: tool.description ?? '',
    id, flags, whole,
    payload: payloadOf(flags, whole, described),
  }
}

// ─── argv ────────────────────────────────────────────────────────────────────

export interface ParseOptions {
  /** `@path` — read a file. Injected so the parse stays pure. */
  readFile?: (path: string) => string
  /** `-` — read stdin. */
  readStdin?: () => string
}

/**
 * A command line → the tool's arguments.
 *
 * Refuses by name: an unknown flag, a value its type cannot hold, an enum value
 * the column does not have, and a missing id. Required fields are left to the
 * schema's own validator, which the caller runs next — a second copy of that
 * rule here would be a second place to get it wrong.
 */
export function parseArgs(cmd: Command, argv: string[], opts: ParseOptions = {}): Record<string, unknown> {
  const byName = new Map(cmd.flags.map(f => [f.name, f]))
  const slots: Record<Slot, Record<string, unknown>> = { args: {}, data: {}, query: {}, directives: {} }
  const bracketPairs: Array<[Flag, string, string]> = []
  let wholeValue: Record<string, unknown> | null = null
  let id: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]

    if (!tok.startsWith('--') || tok === '--') {
      if (tok === '--') continue
      if (cmd.id && id === undefined) { id = tok; continue }
      throw new ArgvError(`unexpected argument '${tok}' — ${cmd.service} ${cmd.method} takes ${cmd.id ? 'one id and ' : ''}flags`)
    }

    let key = tok.slice(2)
    let value: string | undefined
    const eq = key.indexOf('=')
    if (eq !== -1) { value = key.slice(eq + 1); key = key.slice(0, eq) }

    const bracket = key.indexOf('[')
    const base    = bracket === -1 ? key : key.slice(0, bracket)
    const negated = value === undefined && base.startsWith('no-') && byName.get(base.slice(3))?.type === 'boolean'
    const name    = negated ? base.slice(3) : base

    if (name === 'id' && cmd.id && bracket === -1) {
      id = value ?? argv[++i]
      if (id === undefined) throw new ArgvError('--id needs a value', 'id')
      continue
    }

    if (cmd.whole && name === cmd.whole.name && bracket === -1) {
      const raw = value ?? argv[++i]
      if (raw === undefined) throw new ArgvError(`--${name} needs JSON, @file or -`, name)
      const v = readJson(raw, name, opts)
      if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new ArgvError(`--${name} must be a JSON object`, name)
      wholeValue = v as Record<string, unknown>
      continue
    }

    const flag = byName.get(name)
    if (!flag) throw new ArgvError(unknownFlag(cmd, name), name)

    if (bracket !== -1) {
      if (!flag.brackets) throw new ArgvError(`--${name} is not a filter, so it takes no [operator]`, name)
      const raw = value ?? argv[++i]
      if (raw === undefined) throw new ArgvError(`--${key} needs a value`, name)
      bracketPairs.push([flag, key, raw])
      continue
    }

    if (flag.type === 'boolean') {
      if (negated) { slots[flag.slot][name] = false; continue }
      if (value === undefined && (argv[i + 1] === 'true' || argv[i + 1] === 'false')) value = argv[++i]
      slots[flag.slot][name] = value === undefined ? true : coerce(flag, value, opts)
      continue
    }

    const raw = value ?? argv[++i]
    if (raw === undefined) throw new ArgvError(`--${name} needs a value`, name)
    slots[flag.slot][name] = coerce(flag, raw, opts)
  }

  if (cmd.id?.required && id === undefined)
    throw new ArgvError(`${cmd.service} ${cmd.method} needs an id: ${cmd.service} ${cmd.method} <id>`, 'id')

  // Brackets go through the wire's own reader, then a filter's leaves are typed
  // by the column — `--status[in][] paid` is a list of that column's values.
  if (bracketPairs.length) {
    const parsed = parseParams(bracketPairs.map(([, k, v]) => [k, v])) as Record<string, unknown>
    for (const [name, v] of Object.entries(parsed)) {
      const flag = byName.get(name)!
      slots[flag.slot][name] = flag.filter && typeof v === 'object' && v !== null && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).map(([op, x]) => [op, typeLeaf(flag, x)]))
        : v
    }
  }

  const out: Record<string, unknown> = { ...slots.args }
  if (id !== undefined) out.id = id
  if (cmd.whole) {
    // Flags win over the object, so a file of defaults can be overridden inline.
    const into = cmd.whole.slot
    const base = wholeValue ?? {}
    if (into === 'args') Object.assign(out, base, slots.args)
    else if (Object.keys(base).length || Object.keys(slots[into]).length) out[into] = { ...base, ...slots[into] }
  }
  for (const s of ['data', 'query', 'directives'] as const) {
    if (s === cmd.whole?.slot) continue
    if (Object.keys(slots[s]).length) out[s] = slots[s]
  }
  return out
}

function unknownFlag(cmd: Command, name: string): string {
  const known = [
    ...(cmd.id ? ['id'] : []),
    ...(cmd.whole ? [cmd.whole.name] : []),
    ...cmd.flags.map(f => f.name),
  ]
  return `unknown flag --${name} for ${cmd.service} ${cmd.method}. It takes: ${known.map(k => `--${k}`).join(' ') || 'nothing'}`
}

/** One text value, typed by the flag it was given to. */
function coerce(flag: Flag, raw: string, opts: ParseOptions): unknown {
  if (flag.nullable && raw === 'null') return null

  switch (flag.type) {
    case 'string': {
      // The query kit's escape: `"null"` is the four letters, not a null.
      const text = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
      if (flag.enum && !flag.enum.includes(text))
        throw new ArgvError(`--${flag.name} is one of ${flag.enum.join(', ')} — not '${text}'`, flag.name)
      return text
    }
    case 'integer':
      if (!isNumericLiteral(raw) || !Number.isInteger(Number(raw)))
        throw new ArgvError(`--${flag.name} takes a whole number — not '${raw}'`, flag.name)
      return Number(raw)
    case 'number':
      if (!isNumericLiteral(raw))
        throw new ArgvError(`--${flag.name} takes a number — not '${raw}'`, flag.name)
      return Number(raw)
    case 'boolean':
      if (raw !== 'true' && raw !== 'false')
        throw new ArgvError(`--${flag.name} is true or false — not '${raw}'`, flag.name)
      return raw === 'true'
    case 'json':
      return readJson(raw, flag.name, opts)
    case 'any':
      return raw === '-' || raw.startsWith('@') || raw.startsWith('{') || raw.startsWith('[')
        ? readJson(raw, flag.name, opts)
        : parseValue(raw)
  }
}

/** An operator's leaf, typed by its column; untyped columns read as the wire would. */
function typeLeaf(flag: Flag, v: unknown): unknown {
  if (Array.isArray(v)) return v.map(x => typeLeaf(flag, x))
  if (flag.type === 'string') return typeof v === 'string' ? v : String(v)
  return parseValue(v)
}

function readJson(raw: string, name: string, opts: ParseOptions): unknown {
  let text = raw
  if (raw === '-') {
    if (!opts.readStdin) throw new ArgvError(`--${name} - reads stdin, which is not available here`, name)
    text = opts.readStdin()
  } else if (raw.startsWith('@')) {
    if (!opts.readFile) throw new ArgvError(`--${name} @file reads a file, which is not available here`, name)
    text = opts.readFile(raw.slice(1))
  }
  try { return JSON.parse(text) }
  catch { throw new ArgvError(`--${name} takes JSON, @file or - — '${raw.slice(0, 40)}' is not JSON`, name) }
}
