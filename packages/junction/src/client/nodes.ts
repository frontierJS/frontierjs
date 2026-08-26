// ─── Nodes ────────────────────────────────────────────────────────────────────
// One node per row, keyed by MODEL and id — the synced truth for that row, and
// the thing every view of it points at (`FJS-D138`).
//
// Before this, a store was per-`resource()` call and held whole rows: two
// `createResource('orders')` in two route files were two copies kept in step
// only because both happened to subscribe to the same service, and a row read
// with `service.get(id)` was a plain object no announcement could reach at all
// — so every detail screen in the repo went stale the moment somebody else
// wrote the row (`FJS-518`).
//
// Three rules this file exists to keep, and each of them was a defect somewhere
// else first:
//
//   • Keyed by the MODEL, not by the service. Two services over one model are
//     one row. Junction holds no schema, so the model name is passed in — the
//     same reason `ResourceOptions.match` is passed in.
//
//   • A node holds the SYNCED truth and nothing else. It is not where an
//     optimistic value lives and it is emphatically not where a draft lives:
//     `FJS-341` was a live store moving a `@version` nobody had read, and the
//     fix was keeping the copies apart. A view remembers what it read.
//
//   • Lifetime is a TTL, not a reference count the application maintains.
//     Apollo and Relay both ship retain/release and it is the most-complained-
//     about part of either. A held node never expires; a released one lingers
//     for `ttlMs`, which is what makes list → detail → back warm rather than a
//     refetch.

/** What a caller may do with a node: read it now, or watch it. */
export interface NodeView<T = Record<string, unknown>> {
  /** The row as last synced, or `null` if nothing has been written yet. */
  get(): T | null
  /** Watch it. Emits the current value immediately. Returns unsubscribe. */
  subscribe(fn: (value: T | null) => void): () => void
}

export class Node<T extends Record<string, unknown> = Record<string, unknown>>
  implements NodeView<T> {
  readonly model: string
  readonly id:    unknown

  private _value:   T | null = null
  private _subs:    Set<(v: T | null) => void> = new Set()
  private _holds    = 0
  private _registry: NodeRegistry

  // Submitted mutations that have not come back yet, oldest first. Each one is
  // the INTENT — a partial, or `null` for a removal — never the value it
  // produced. Storing the value would make this a copy of the row again, and
  // it is what replaying a mutation on top of newer server state would need.
  private _overlays: Map<number, Partial<T> | null> = new Map()
  private _overlaySeq = 0
  // The folded view. Cached so repeated reads answer the same object — a Mesa
  // signal compares what it is handed, and `Store._replace` tells its own
  // materialised rows apart from incoming ones by reference.
  private _view: T | null = null
  private _viewFresh = false

  /** When the last hold went away — the clock the TTL is read against. */
  _releasedAt: number | null = null

  constructor(registry: NodeRegistry, model: string, id: unknown) {
    this._registry = registry
    this.model = model
    this.id = id
  }

  /**
   * The row as anyone looking at it should see it: the synced truth with every
   * unconfirmed mutation folded on top, in the order they were submitted.
   *
   * One read for every view — a list materialises through this and so does a
   * record view, which is why an optimistic patch that moves a sort key also
   * moves the row in an ordered list without anything being taught about it.
   */
  get(): T | null {
    if (this._overlays.size === 0) return this._value
    if (this._viewFresh) return this._view
    let out: T | null = this._value
    for (const intent of this._overlays.values()) {
      if (intent === null) { out = null; continue }
      out = { ...(out ?? {} as T), ...intent } as T
    }
    this._view = out
    this._viewFresh = true
    return out
  }

  /** The synced truth alone, with nothing pending folded in. */
  committed(): T | null { return this._value }

  /** Is anything about this row still in flight? */
  get pending(): boolean { return this._overlays.size > 0 }

  /**
   * Apply a submitted mutation on top of the truth, and answer the handle that
   * takes it off again.
   *
   * Keyed by the MUTATION and not by the row: another writer patching the same
   * row while this is in flight moves the truth underneath, and must not clear
   * an intent nobody has answered for yet.
   */
  overlay(intent: Partial<T> | null): { settle: (row?: T | null) => void } {
    const key = ++this._overlaySeq
    this._overlays.set(key, intent)
    this._invalidate()
    return {
      settle: (row?: T | null) => {
        if (!this._overlays.delete(key)) return
        // A row came back: it is the truth, and writing it here rather than
        // waiting for the announcement is what closes the gap where the
        // overlay is gone and the push has not landed.
        if (row != null) { this._value = row }
        this._invalidate()
      },
    }
  }

  private _invalidate(): void {
    this._viewFresh = false
    const v = this.get()
    for (const fn of this._subs) fn(v)
  }

  subscribe(fn: (value: T | null) => void): () => void {
    const release = this.hold()
    this._subs.add(fn)
    fn(this._value)
    return () => {
      this._subs.delete(fn)
      release()
    }
  }

  /**
   * Watch without receiving the current value.
   *
   * A view adding an id it already has rows for would otherwise re-enter its
   * own notify while it is still assembling the list.
   */
  watch(fn: (value: T | null) => void): () => void {
    const release = this.hold()
    this._subs.add(fn)
    return () => {
      this._subs.delete(fn)
      release()
    }
  }

  /**
   * Claim this node. While anything holds it, the TTL does not run.
   * Returns the release — call it once.
   */
  hold(): () => void {
    this._holds++
    this._releasedAt = null
    let done = false
    return () => {
      if (done) return
      done = true
      this._holds--
      if (this._holds <= 0) this._registry._released(this)
    }
  }

  get held(): boolean { return this._holds > 0 }

  /**
   * The synced truth moved. Called by the registry, never by a view.
   *
   * The SAME object is not a change. A push writes the node once on arrival —
   * so a view of the row hears about it whether or not any list holds it — and
   * the list it lands in then writes it back through as part of assembling
   * itself. Without this a watcher heard every push twice.
   */
  _write(value: T): void {
    if (this._value === value) return
    this._value = value
    this._viewFresh = false
    const v = this.get()
    for (const fn of this._subs) fn(v)
  }

}

/**
 * What the registry needs of a node to expire it.
 *
 * Structural rather than `Node<T>` because a generic class cannot hand `this`
 * to a method typed on the erased instantiation — and widening it to `any` in
 * a package whose typecheck baseline is zero is the wrong trade.
 */
interface Expirable {
  readonly model: string
  readonly id:    unknown
  readonly held:  boolean
  _releasedAt:    number | null
}

export interface NodeRegistryOptions {
  /** How long a released node lingers, ms. Default 30_000. `0` drops it at once. */
  ttlMs?: number
}

/**
 * The key a row is filed under.
 *
 * An id arrives as a number from the wire and as a STRING from a URL, and a
 * detail screen is reached by a URL — so `record(page.params.id)` and the list
 * that already holds `{ id: 5 }` would otherwise be two nodes, and the push
 * announcing that row would move exactly one of them. Identity, not filtering:
 * a table cannot hold both `5` and `'5'`, which is what makes this safe here
 * and wrong in a query string (`FJS-D125`).
 */
export function nodeKey(id: unknown): string {
  return typeof id === 'string' ? id : String(id)
}

export class NodeRegistry {
  private _models: Map<string, Map<string, Node>> = new Map()
  private _ttl:    number
  private _timer:  ReturnType<typeof setInterval> | null = null

  constructor(opts: NodeRegistryOptions = {}) {
    this._ttl = opts.ttlMs ?? 30_000
  }

  /** Get the node for this row, creating it if this is the first view to ask. */
  node<T extends Record<string, unknown> = Record<string, unknown>>(
    model: string,
    id: unknown
  ): Node<T> {
    let rows = this._models.get(model)
    if (!rows) { rows = new Map(); this._models.set(model, rows) }
    const key = nodeKey(id)
    let n = rows.get(key)
    if (!n) { n = new Node(this, model, id); rows.set(key, n) }
    return n as Node<T>
  }

  /** Is there a node for this row already? Never creates one. */
  peek(model: string, id: unknown): Node | undefined {
    return this._models.get(model)?.get(nodeKey(id))
  }

  /**
   * The synced truth for a row moved — from a load, a call result or a push.
   *
   * A record with no id cannot be a node: `findIndex` on `undefined` matches
   * nothing, which is how an id-less payload used to be appended as a phantom
   * row (`FJS-020`). Answers the node it wrote, or `null` if it refused.
   */
  write<T extends Record<string, unknown> = Record<string, unknown>>(
    model: string,
    record: T,
    idField = 'id'
  ): Node<T> | null {
    if (record == null || (record as Record<string, unknown>)[idField] == null) return null
    const n = this.node<T>(model, record[idField])
    n._write(record)
    return n
  }

  /** How many nodes exist right now. For tests and for the devtools panel. */
  get size(): number {
    let n = 0
    for (const rows of this._models.values()) n += rows.size
    return n
  }

  /** Drop everything, held or not. A sign-out is the caller that wants this. */
  clear(): void {
    this._models.clear()
    this._stopSweeping()
  }

  /** A node's last hold went away. */
  _released(node: Expirable): void {
    if (this._ttl <= 0) return this._drop(node)
    node._releasedAt = Date.now()
    this._startSweeping()
  }

  private _drop(node: Expirable): void {
    const rows = this._models.get(node.model)
    if (!rows) return
    rows.delete(nodeKey(node.id))
    if (rows.size === 0) this._models.delete(node.model)
  }

  /**
   * Drop what has been released for longer than the TTL.
   *
   * Public because a test cannot wait 30 seconds and must not be given a fake
   * clock to do it — this is the same call the timer makes.
   */
  sweep(now: number = Date.now()): number {
    let dropped = 0
    for (const rows of [...this._models.values()]) {
      for (const node of [...rows.values()]) {
        if (node.held || node._releasedAt === null) continue
        if (now - node._releasedAt < this._ttl) continue
        this._drop(node)
        dropped++
      }
    }
    if (this.size === 0) this._stopSweeping()
    return dropped
  }

  // The timer is armed on the first release and cleared the moment the registry
  // empties, because a live interval in a test suite is a run that never exits;
  // `unref` covers the same failure under node, where it exists.
  private _startSweeping(): void {
    if (this._timer) return
    const every = Math.max(1_000, Math.floor(this._ttl / 2))
    this._timer = setInterval(() => this.sweep(), every)
    ;(this._timer as unknown as { unref?: () => void }).unref?.()
  }

  private _stopSweeping(): void {
    if (!this._timer) return
    clearInterval(this._timer)
    this._timer = null
  }
}
