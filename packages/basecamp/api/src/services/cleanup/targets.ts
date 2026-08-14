// src/services/cleanup/targets.ts
// What a reclaim sweep may delete — the whole vocabulary, in one place.
//
// This is the DECLARED half of the pair a recipe completes. A cleanup never
// carries a command: it names targets from this list, the API refuses anything
// else by name, and the outpost is asked for exactly these. So the destructive
// thing an operator does daily needs no arbitrary code, and the arbitrary path
// (`/recipes/`) needs a role.
//
// It is not an enum in db/schema.lite, and that is a limitation rather than a
// preference: `targets ReclaimTarget[]` does not parse — *array [] is only
// supported for Text, Integer, File, or a model name for many-to-many*. An enum
// declared there plus a `String[]` column here would be two homes with nothing
// joining them, which is the shape that let `AlertRule.severity` default to a
// value its own API refused. One home instead, and the screen fetches it
// through `cleanup.targets` rather than shipping a copy in the bundle.
//
// `estimate` names which of `DiskUsage`'s reclaimable figures this target
// frees. Those figures are `docker system df`'s own, because how much of an
// image store can actually go is a question about shared layers that only
// Docker can answer — the mock multiplied a count by an average and printed
// gigabytes.

/** Which reclaimable figure a target draws on. `volumes` comes from the Volume
 *  table rather than from DiskUsage, since that model already owns per-disk
 *  sizes and a second count would be a second answer. */
export type ReclaimEstimate = 'images' | 'containers' | 'volumes' | 'build_cache'

export interface ReclaimTargetSpec {
  /** The wire name — stored on `CleanupRun.targets` and sent to the outpost. */
  target:      string
  label:       string
  description: string
  estimate:    ReclaimEstimate
  /** True when this target frees a SUBSET of `estimate`'s figure and Docker
   *  reports no split. Two subsets of one number cannot be added together, so
   *  the screen shows "part of" rather than a total that overstates. */
  partial:     boolean
  /** Off by default. Every one of these deletes something a person might still
   *  want; the two that are off are the two nobody can rebuild from a registry. */
  defaultOn:   boolean
}

export const RECLAIM_TARGETS: ReclaimTargetSpec[] = [
  {
    target:      'dangling_images',
    label:       'Dangling layers',
    description: 'Image layers no tagged image references — the output of rebuilding.',
    estimate:    'images',
    // Docker reports one reclaimable figure for images. Dangling layers are
    // inside it and there is no second number, so this cannot be added to the
    // unused-images figure without counting the same bytes twice.
    partial:     true,
    defaultOn:   true,
  },
  {
    target:      'unused_images',
    label:       'Unused images',
    description: 'Every image no container is using, dangling layers included.',
    estimate:    'images',
    partial:     false,
    defaultOn:   true,
  },
  {
    target:      'stopped_containers',
    label:       'Stopped containers',
    description: 'Containers that have exited. Their logs and writable layers go with them.',
    estimate:    'containers',
    partial:     false,
    defaultOn:   true,
  },
  {
    target:      'unused_volumes',
    label:       'Unused volumes',
    description: 'Volumes nothing mounts. This is data, and it is not recoverable.',
    estimate:    'volumes',
    partial:     false,
    // Off by default, and the one target on this screen that destroys something
    // no registry can hand back. `/volumes/` is where a person deletes one
    // knowing its name; a checkbox that swept them all by default would make
    // that screen's care pointless.
    defaultOn:   false,
  },
  {
    target:      'build_cache',
    label:       'Build cache',
    description: 'Cached build steps. The next build is slower and produces the same image.',
    estimate:    'build_cache',
    partial:     false,
    defaultOn:   true,
  },
]

export const RECLAIM_TARGET_NAMES = RECLAIM_TARGETS.map(t => t.target)

export const RECLAIM_TARGET_BY_NAME: Record<string, ReclaimTargetSpec> =
  Object.fromEntries(RECLAIM_TARGETS.map(t => [t.target, t]))

/** The reclaimable figures a server has, in the units the outpost reported. */
export interface ReclaimFigures {
  images:      number
  containers:  number
  build_cache: number
  volumes:     number
}

/**
 * What one target would free on a server, and whether that number is a bound
 * rather than an amount.
 *
 * One owner: `cleanup.usage` answers this per target per server and the screen
 * adds up whatever is ticked. Computing it in the browser would mean the
 * estimate and the sweep disagreed the first time a figure was renamed.
 */
export function estimateTarget(
  target: string,
  figures: ReclaimFigures,
): { bytes: number; partial: boolean } {
  const spec = RECLAIM_TARGET_BY_NAME[target]
  if (!spec) return { bytes: 0, partial: false }
  return { bytes: figures[spec.estimate] ?? 0, partial: spec.partial }
}
