import type { JSONSchema } from "../types"

// ─────────────────────────────────────────────
// NODE CATEGORY
// Used to derive compiler classification flags
// (isTrigger, isErrorHandler, etc.) automatically.
// ─────────────────────────────────────────────

export type NodeCategory =
  | "trigger"       // trigger.*
  | "transform"     // expr.pipeline, data.*
  | "flow-control"  // flow.*
  | "http"          // http.request, http.respond
  | "ai"            // ai
  | "storage"       // store
  | "subflow"       // subflow.*

// ─────────────────────────────────────────────
// NODE TYPE DESCRIPTOR
// Everything the compiler and executor need to know about a node type —
// beyond the live implementation (which comes from INodeImplementation).
//
// Fields:
//   type          — matches NodeDefinition.type (e.g. "trigger.webhook")
//   category      — drives compiler classification
//   label         — human-readable name for UIs
//   description   — shown in the node picker
//   inputSchema   — JSON Schema for validated inputs (optional)
//   outputSchema  — JSON Schema for the node's output data (optional)
//   configSchema  — JSON Schema for the node's config fields (optional)
//   functions     — custom expression function names exposed by this node type
//   modes         — valid values for NodeDefinition.mode (if any)
// ─────────────────────────────────────────────

export interface NodeTypeDescriptor {
  type:          string
  category:      NodeCategory
  label:         string
  description:   string
  inputSchema?:  JSONSchema
  outputSchema?: JSONSchema
  configSchema?: JSONSchema
  functions?:    string[]
  modes?:        string[]
}

// ─────────────────────────────────────────────
// PLUGIN MANIFEST
// Describes a plugin package — the identity, version, and the node
// types it contributes. Third-party plugins provide this when they
// register with the PluginRegistry.
// ─────────────────────────────────────────────

export interface PluginManifest {
  id:           string
  name:         string
  version:      string
  author?:      string
  description?: string
  nodes:        NodeTypeDescriptor[]
}

// ─────────────────────────────────────────────
// PLUGIN REGISTRATION ENTRY
// Stored internally in the registry after a plugin is registered.
// ─────────────────────────────────────────────

export interface PluginEntry {
  manifest:    PluginManifest
  registeredAt: number
}
