import type { IPluginRegistry }      from "../compiler"
import type { INodeImplementation, INodeRegistry } from "../executor"
import type { JSONSchema }            from "../types"
import type { NodeTypeDescriptor, PluginManifest, PluginEntry } from "./types"
import { BUILTIN_DESCRIPTORS, BUILTIN_FUNCTION_NAMES } from "./builtins"

export type { NodeTypeDescriptor, PluginManifest, PluginEntry } from "./types"

// ─────────────────────────────────────────────
// PLUGIN REGISTRY
// Central registry for all node types in the system.
//
// Implements two interfaces:
//   IPluginRegistry  — used by the Compiler for type validation, schema lookup,
//                      and category classification during compilation
//   INodeRegistry    — used by the NodeExecutor to retrieve live implementations
//
// At construction, all 18 built-in node descriptors are pre-loaded.
// Implementations for those types are registered separately (via registerImpl
// or the bulk register() call) once the core node modules are built.
//
// Third-party plugins provide a PluginManifest + implementations:
//   registry.register(manifest, implementations)
//
// Surface API:
//   register(manifest, impls)  → register a plugin's descriptors + implementations
//   registerImpl(impl)         → register a single implementation (no descriptor change)
//   get(type)                  → INodeImplementation | undefined  (executor path)
//   has(type)                  → boolean                          (compiler path)
//   descriptor(type)           → NodeTypeDescriptor | undefined
//   plugins()                  → PluginEntry[]                    (introspection)
//   types()                    → string[]                         (all known types)
// ─────────────────────────────────────────────

export class PluginRegistry implements IPluginRegistry, INodeRegistry {
  // type string → descriptor
  private readonly descriptors = new Map<string, NodeTypeDescriptor>()
  // type string → live implementation
  private readonly impls       = new Map<string, INodeImplementation>()
  // plugin id → entry
  private readonly plugins_    = new Map<string, PluginEntry>()
  // merged function name set (builtins + plugin-contributed)
  private fnNames              = new Set<string>(BUILTIN_FUNCTION_NAMES)

  constructor() {
    // Pre-load all 18 built-in descriptors
    for (const d of BUILTIN_DESCRIPTORS) {
      this.descriptors.set(d.type, d)
    }
  }

  // ─── REGISTRATION ────────────────────────────

  /**
   * Register a plugin — its descriptor metadata AND its implementations.
   * Impls must have a .type that matches one of the manifest's node descriptors.
   * Throws if an impl's type is not declared in the manifest.
   */
  register(manifest: PluginManifest, implementations: INodeImplementation[]): void {
    const declaredTypes = new Set(manifest.nodes.map(n => n.type))

    for (const impl of implementations) {
      if (!declaredTypes.has(impl.type)) {
        throw new PluginRegistrationError(
          manifest.id,
          `Implementation type "${impl.type}" is not declared in the manifest. ` +
          `Declared types: ${[...declaredTypes].join(", ")}`,
        )
      }
    }

    // Register descriptors
    for (const descriptor of manifest.nodes) {
      this.descriptors.set(descriptor.type, descriptor)
      // Merge any custom function names this node type exposes
      if (descriptor.functions) {
        for (const fn of descriptor.functions) this.fnNames.add(fn)
      }
    }

    // Register implementations
    for (const impl of implementations) {
      this.impls.set(impl.type, impl)
    }

    this.plugins_.set(manifest.id, {
      manifest,
      registeredAt: Date.now(),
    })
  }

  /**
   * Register a single implementation directly — used to wire in core node
   * implementations one by one without requiring a full plugin manifest.
   * The node type must already have a descriptor (built-in or previously registered).
   */
  registerImpl(impl: INodeImplementation): void {
    if (!this.descriptors.has(impl.type)) {
      throw new PluginRegistrationError(
        "core",
        `Cannot register implementation for unknown type "${impl.type}". ` +
        `Register a descriptor first via register() with a PluginManifest.`,
      )
    }
    this.impls.set(impl.type, impl)
  }

  // ─── INODE REGISTRY (executor) ───────────────

  get(type: string): INodeImplementation | undefined {
    return this.impls.get(type)
  }

  // ─── IPLUGIN REGISTRY (compiler) ─────────────

  has(type: string): boolean {
    return this.descriptors.has(type)
  }

  isTrigger(type: string): boolean {
    return this.descriptors.get(type)?.category === "trigger"
  }

  isErrorHandler(type: string): boolean {
    return type === "flow.error"
  }

  isLoopNode(type: string): boolean {
    return type === "flow.loop"
  }

  isStoreNode(type: string): boolean {
    return this.descriptors.get(type)?.category === "storage"
  }

  isAiNode(type: string): boolean {
    return this.descriptors.get(type)?.category === "ai"
  }

  getOutputSchema(type: string): JSONSchema | undefined {
    return this.descriptors.get(type)?.outputSchema
  }

  getInputSchema(type: string): JSONSchema | undefined {
    return this.descriptors.get(type)?.inputSchema
  }

  getFunctionNames(): Set<string> {
    return new Set(this.fnNames)
  }

  // ─── INTROSPECTION ───────────────────────────

  descriptor(type: string): NodeTypeDescriptor | undefined {
    return this.descriptors.get(type)
  }

  /** All registered node type strings */
  types(): string[] {
    return [...this.descriptors.keys()].sort()
  }

  /** All registered plugins */
  plugins(): PluginEntry[] {
    return [...this.plugins_.values()]
  }

  /** True if a live implementation is registered for this type */
  hasImpl(type: string): boolean {
    return this.impls.has(type)
  }

  /**
   * Summary of registry state — useful for health checks and admin endpoints.
   * Returns per-type status so operator can see which node types lack implementations.
   */
  status(): RegistryStatus {
    const types = this.types()
    const missing = types.filter(t => !this.impls.has(t))
    return {
      totalDescriptors:    types.length,
      totalImplementations: this.impls.size,
      totalPlugins:        this.plugins_.size,
      missingImplementations: missing,
      ready: missing.length === 0,
    }
  }
}

// ─────────────────────────────────────────────
// REGISTRY STATUS
// ─────────────────────────────────────────────

export interface RegistryStatus {
  totalDescriptors:        number
  totalImplementations:    number
  totalPlugins:            number
  missingImplementations:  string[]
  ready:                   boolean
}

// ─────────────────────────────────────────────
// ERRORS
// ─────────────────────────────────────────────

export class PluginRegistrationError extends Error {
  constructor(
    public readonly pluginId: string,
    message: string,
  ) {
    super(`[plugin:${pluginId}] ${message}`)
    this.name = "PluginRegistrationError"
  }
}
