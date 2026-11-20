// island-registration.js — Harbor-side island registration.
//
// Wraps chrome.scripting.registerContentScripts with upsert semantics so
// calling registerAll() on every SW wake is safe and cheap. Chrome rejects
// duplicate IDs (DUPLICATE_ID error), so we unregister-then-register.
//
// Spec invariant: islands.registerAll(), islands.register(id), islands.unregister(id)
// are all idempotent. Harbor calls registerAll() during boot every wake.
//
// `inject: 'gesture'` islands are never registered: harbor injects them with
// chrome.scripting.executeScript on a user gesture (islands.inject), where
// activeTab grants the page, so no host permission is asked for.
//
// What gets registered:
//   - id           — the island id (filename stem)
//   - js           — `["islands/<id>.js"]`
//   - matches      — from islands.<id>.matches in jetty.config.js
//   - excludeMatches — from islands.<id>.excludeMatches (optional)
//   - runAt        — 'document_idle' | 'document_start' | 'document_end' (default: document_idle)
//   - allFrames    — boolean (default: false)
//   - world        — 'ISOLATED' (default) | 'MAIN'
//
// world: 'MAIN' means the script runs in the page's JS realm and can access
// page globals/window directly. We forbid combining MAIN with `app` in
// defineIsland (validated there) — UI mounting requires shadow DOM access
// which is cleaner from ISOLATED world.

const VALID_INJECT = ['matches', 'gesture']

/** An island injected on a gesture is never registered, so it never matches a page by itself. */
export function isGestureIsland(islandConfig) {
  return islandConfig?.inject === 'gesture'
}

/**
 * Build a content-script registration entry from an island config object.
 * Pure transform — no side effects. Caller passes results to the API.
 * Answers null for an `inject: 'gesture'` island, which has nothing to register.
 */
export function buildRegistration(islandId, islandConfig) {
  const inject = islandConfig?.inject ?? 'matches'
  if (!VALID_INJECT.includes(inject)) {
    throw new Error(`island "${islandId}": inject must be one of ${VALID_INJECT.join(', ')} (got "${inject}")`)
  }
  if (inject === 'gesture') return null
  if (!islandConfig?.matches?.length) {
    throw new Error(`island "${islandId}": matches[] is required (or inject: 'gesture')`)
  }

  const reg = {
    id:        islandId,
    js:        [`islands/${islandId}.js`],
    matches:   [...islandConfig.matches],
    runAt:     islandConfig.runAt    ?? 'document_idle',
    allFrames: islandConfig.allFrames ?? false,
    world:     islandConfig.world    ?? 'ISOLATED',
  }
  if (islandConfig.excludeMatches?.length) {
    reg.excludeMatches = [...islandConfig.excludeMatches]
  }
  if (islandConfig.css?.length) {
    reg.css = [...islandConfig.css]
  }
  return reg
}

/**
 * Register all islands. Upsert-safe: existing registrations w/ matching ids
 * are unregistered first to avoid Chrome's DUPLICATE_ID rejection.
 *
 * Errors per-island are logged but don't abort other registrations — one bad
 * island shouldn't break the rest. Returns array of { id, ok, error? }.
 *
 * @param {object} scriptingApi — chrome.scripting (or browser.scripting)
 * @param {object} islandsConfig — map of { [id]: islandConfig }
 */
export async function registerAllIslands(scriptingApi, islandsConfig) {
  if (!scriptingApi) {
    throw new Error('registerAllIslands: chrome.scripting unavailable (missing "scripting" permission?)')
  }

  // Build all registrations first; any config error throws synchronously.
  const entries = []
  // Spec: insertion order = config-key order (deterministic but undocumented in v1).
  for (const id of Object.keys(islandsConfig ?? {})) {
    try {
      const entry = buildRegistration(id, islandsConfig[id])
      if (entry) entries.push(entry)
    } catch (e) {
      console.error(`[harbor] island "${id}" config error:`, e.message)
    }
  }

  if (entries.length === 0) return []

  const ids = entries.map((e) => e.id)
  const results = []

  // Step 1: unregister any existing scripts with these ids. Chrome's
  // unregisterContentScripts throws if any id doesn't exist, so we filter by
  // current registrations first.
  try {
    const existing = await scriptingApi.getRegisteredContentScripts({ ids })
    const existingIds = (existing ?? []).map((s) => s.id)
    if (existingIds.length > 0) {
      await scriptingApi.unregisterContentScripts({ ids: existingIds })
    }
  } catch (e) {
    // getRegisteredContentScripts may throw if ids[] is empty in some Chrome
    // versions; fall through to register attempt.
    console.warn('[harbor] island unregister-step warning:', e.message)
  }

  // Step 2: register all islands as one call. If Chrome rejects the batch
  // (e.g. one bad match pattern), we fall back to per-island registration to
  // surface which one failed.
  try {
    await scriptingApi.registerContentScripts(entries)
    for (const e of entries) results.push({ id: e.id, ok: true })
    console.log(`[harbor] registered ${entries.length} island(s):`, ids.join(', '))
  } catch (batchErr) {
    console.warn('[harbor] batch registerContentScripts failed, retrying per-island:', batchErr.message)
    for (const entry of entries) {
      try {
        await scriptingApi.registerContentScripts([entry])
        results.push({ id: entry.id, ok: true })
      } catch (e) {
        results.push({ id: entry.id, ok: false, error: e.message })
        console.error(`[harbor] island "${entry.id}" registration failed:`, e.message)
      }
    }
  }

  return results
}

/** Register a single island (or replace existing registration). */
export async function registerIsland(scriptingApi, islandId, islandConfig) {
  const entry = buildRegistration(islandId, islandConfig)
  if (!entry) {
    throw new Error(`island "${islandId}": inject: 'gesture' is never registered — call islands.inject(id, tabId)`)
  }
  try {
    const existing = await scriptingApi.getRegisteredContentScripts({ ids: [islandId] })
    if (existing?.length) {
      await scriptingApi.unregisterContentScripts({ ids: [islandId] })
    }
  } catch {/* fall through */}
  await scriptingApi.registerContentScripts([entry])
  return { id: islandId, ok: true }
}

/** Unregister a single island. No-op if not currently registered. */
export async function unregisterIsland(scriptingApi, islandId) {
  try {
    const existing = await scriptingApi.getRegisteredContentScripts({ ids: [islandId] })
    if (!existing?.length) return { id: islandId, ok: true, note: 'not registered' }
    await scriptingApi.unregisterContentScripts({ ids: [islandId] })
    return { id: islandId, ok: true }
  } catch (e) {
    return { id: islandId, ok: false, error: e.message }
  }
}

/**
 * Reload all tabs matching an island's match patterns. Used when an island's
 * code changes (`runtime:reload-tab` from harbor) — pages need fresh JS.
 *
 * @param {object} tabsApi    — chrome.tabs
 * @param {string[]} matches  — match patterns from island config
 */
export async function reloadIslandTabs(tabsApi, matches) {
  // A gesture island has no matches, so there is no set of tabs that carries it.
  if (!tabsApi || !matches?.length) return 0
  let reloaded = 0
  try {
    // Combine all match patterns. tabs.query accepts arrays of url patterns
    // in the `url` field.
    const tabs = await tabsApi.query({ url: matches })
    for (const tab of tabs ?? []) {
      if (tab.id != null) {
        try { await tabsApi.reload(tab.id); reloaded++ }
        catch {/* tab may have closed; skip */}
      }
    }
  } catch (e) {
    console.warn('[harbor] reloadIslandTabs failed:', e.message)
  }
  return reloaded
}
