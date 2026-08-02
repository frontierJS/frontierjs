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
import type { ConduitStore, CredentialResolver } from './types.ts'
import type { TargetDescriptor, ConduitHooks } from './types.ts'

export class Router {
  private pool = new Map<string, BaseTransport>()

  constructor(
    private store:       ConduitStore,
    private credentials: CredentialResolver,
    private opts:        {
      timeout_ms?:         number
      retry_limit?:        number
      max_response_bytes?: number
    } = {},
    private hooks:       ConduitHooks = {},
    // Internal only — not part of ConduitOptions.
    // Use createTestConduit() to inject stubs; do not pass this directly.
    private overrides:   Map<string, BaseTransport> = new Map()
  ) {}

  // Async since the store may be networked.
  async resolve(targetId: string): Promise<BaseTransport | null> {
    // Overrides take priority — stubs bypass pool and store entirely
    const override = this.overrides.get(targetId)
    if (override) return override

    const pooled = this.pool.get(targetId)
    if (pooled) return pooled

    const descriptor = await this.store.get(targetId)
    if (!descriptor) return null

    // Another resolve() for the same target may have raced ahead while the
    // store read was in flight — keep whichever transport landed first so
    // the pool stays the single owner of a target's connection.
    const raced = this.pool.get(targetId)
    if (raced) return raced

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
        return new HttpTransport(descriptor, this.credentials, {
          timeout_ms:         this.opts.timeout_ms,
          retry_limit:        this.opts.retry_limit,
          max_response_bytes: this.opts.max_response_bytes
        })

      case 'websocket': {
        const ws = new WebSocketTransport(descriptor, this.credentials)
        // Guarded: this fires from a reconnect timer with no caller to
        // catch it, so a throwing hook would surface as an unhandled
        // rejection rather than a failed request.
        ws.onReconnect = (target) => {
          try {
            this.hooks.onReconnect?.(target)
          } catch (err) {
            console.error(`[conduit] hook 'onReconnect' threw:`, err)
          }
        }
        return ws
      }

      case 'unix':
        return new UnixTransport(descriptor, this.credentials, {
          timeout_ms: this.opts.timeout_ms
        })

      case 'ssh':
      case 'nats':
      default:
        return new NotImplementedTransport(
          descriptor, this.credentials, descriptor.protocol
        )
    }
  }
}
