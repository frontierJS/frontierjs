// plugins/scheduler/index.ts — COMPATIBILITY SHIM
// The scheduler is a core subsystem (it is not a Plugin — no name/register
// lifecycle; app.ts constructs it directly). It moved to src/scheduler/ so
// core no longer imports from the plugins tree. This shim preserves the old
// import path; prefer '@frontierjs/junction/scheduler' or src/scheduler.
export * from '../../scheduler/index.ts'
