// plugins/ai/index.ts — COMPATIBILITY SHIM
// The AI registry is a core subsystem (not a Plugin). It moved to src/ai/
// so core no longer imports from the plugins tree. This shim preserves the
// old import path; prefer '@frontierjs/junction/ai' or src/ai.
export * from '../../ai/index.ts'
