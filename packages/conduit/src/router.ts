// ============================================================
// Conduit — Router
// Resolves a target ID to the correct transport instance.
// Maintains a pool of live transport connections.
// ============================================================

import { HttpTransport }           from './transports/http.ts'
import { WebSocketTransport }      from './transports/websocket.ts'
import { UnixTransport }           from './transports/unix.ts'
import { NotImplementedTransport } from './transports/not_implemented.ts'
import { BaseTransport }           from './transports/base.ts'
import type { ConduitStore }       from './types.ts'
import type { TargetDescriptor, ConduitHooks } from './types.ts'

export class Router {
  private pool = new Map<string, BaseTransport>()

  constructor(
    private store:     ConduitStore,
    private opts:      { timeout_ms?: number; retry_limit?: number } = {},
    private hooks:     ConduitHooks = {},
    // Internal only — not part of ConduitOptions.
    // Use createTestConduit() to inject stubs; do not pass this directly.
    private overrides: Map<string, BaseTransport> = new Map()
  ) {}

  resolve(targetId: string): BaseTransport | null {
    // Overrides take priority — stubs bypass pool and store entirely
    const override = this.overrides.get(targetId)
    if (override) return override

    const pooled = this.pool.get(targetId)
    if (pooled) return pooled

    const descriptor = this.store.get(targetId)
    if (!descriptor) return null

    const transport = this.createTransport(descriptor)
    this.pool.set(targetId, transport)
    return transport
  }

  evict(targetId: string) {
    const transport = this.pool.get(targetId)
    if (transport instanceof WebSocketTransport) transport.destroy()
    this.pool.delete(targetId)
  }

  evictAll() {
    for (const id of this.pool.keys()) this.evict(id)
  }

  // ─── Private ─────────────────────────────────────────────

  private createTransport(descriptor: TargetDescriptor): BaseTransport {
    switch (descriptor.protocol) {
      case 'http':
        return new HttpTransport(descriptor, {
          timeout_ms:  this.opts.timeout_ms,
          retry_limit: this.opts.retry_limit
        })

      case 'websocket': {
        const ws = new WebSocketTransport(descriptor)
        ws.onReconnect = (target) => this.hooks.onReconnect?.(target)
        return ws
      }

      case 'unix':
        return new UnixTransport(descriptor, { timeout_ms: this.opts.timeout_ms })

      case 'ssh':
      case 'nats':
      default:
        return new NotImplementedTransport(descriptor, descriptor.protocol)
    }
  }
}
