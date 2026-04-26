/**
 * core/ports.js
 *
 * Port schema:  [ENV][CATEGORY][PROJECT][SERVICE]
 *
 *   ENV      7=test  8=dev  9=prod
 *   CATEGORY 0=fe  1=be  2=widgetDev  3=widgetServe  4=ext  5=tooling
 *   PROJECT  0-9  (assigned dynamically by lock manager)
 *   SERVICE  0-9  (per-project slot within a category)
 *
 * Examples:
 *   8000  →  dev / fe      / project 0 / service 0
 *   8010  →  dev / fe      / project 1 / service 0
 *   8100  →  dev / be      / project 0 / service 0
 *   8500  →  dev / tooling / project 0 / service 0  (prisma studio)
 *
 * Global tooling (not project-scoped, never dynamic):
 *   5000  →  fli gui
 *   5001  →  sql studio
 */

import net from 'net'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ─── Schema maps ──────────────────────────────────────────────────────────────

export const ENV = {
  test: 7,
  dev:  8,
  prod: 9,
}

export const CAT = {
  fe:          0,
  be:          1,
  widgetDev:   2,
  widgetServe: 3,
  ext:         4,
  tooling:     5,
}

export const GLOBAL = {
  gui:    8500,   // fli web GUI — project-local dev tooling
  pview:  8501,   // fli project:view (FJSChain) — project-local dev tooling
  studio: 8502,   // db studio — project-local dev tooling
}

// ─── Formula ─────────────────────────────────────────────────────────────────

/**
 * Derive a port from components.
 * port = (ENV * 1000) + (CAT * 100) + (PROJECT * 10) + SERVICE
 */
export function port(category, { env, projectId, serviceId = 0 }) {
  if (!ENV[env])      throw new Error(`Unknown env "${env}" — must be test|dev|prod`)
  if (CAT[category] === undefined) throw new Error(`Unknown category "${category}"`)
  if (projectId < 0 || projectId > 9) throw new Error(`projectId must be 0–9`)
  if (serviceId < 0 || serviceId > 9) throw new Error(`serviceId must be 0–9`)
  // Guard: project ports are 7xxx/8xxx/9xxx, global tooling ports are 85xx
  // Prevent accidental collision with global slots
  if (projectId === 0 && (CAT[category] === 5) && serviceId <= 2) {
    throw new Error(`Ports 8500–8502 are reserved for global tooling (gui, pview, studio)`)
  }
  return (ENV[env] * 1000) + (CAT[category] * 100) + (projectId * 10) + serviceId
}

/** Decode a port number back into its components */
export function decode(p) {
  const envDigit     = Math.floor(p / 1000)
  const catDigit     = Math.floor((p % 1000) / 100)
  const projectDigit = Math.floor((p % 100) / 10)
  const serviceDigit = p % 10
  const env      = Object.keys(ENV).find(k => ENV[k] === envDigit) ?? `unknown(${envDigit})`
  const category = Object.keys(CAT).find(k => CAT[k] === catDigit) ?? `unknown(${catDigit})`
  return { env, category, projectId: projectDigit, serviceId: serviceDigit }
}

export function isGlobalPort(p) {
  return Object.values(GLOBAL).includes(p)
}

// ─── Socket probe ─────────────────────────────────────────────────────────────

export function isPortInUse(p) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(true))
    server.once('listening', () => server.close(() => resolve(false)))
    server.listen(p, '127.0.0.1')
  })
}

/**
 * Find the first free port in a category for a given env + project,
 * scanning service slots 0–9.
 */
export async function findFreeServicePort(category, env, projectId) {
  for (let serviceId = 0; serviceId <= 9; serviceId++) {
    const p = port(category, { env, projectId, serviceId })
    if (!(await isPortInUse(p))) return p
  }
  return null
}

// ─── Lock manager ─────────────────────────────────────────────────────────────

const LOCK_DIR  = join(homedir(), '.fli')
const LOCK_FILE = join(LOCK_DIR, 'sessions.lock')

export function readLock() {
  if (!existsSync(LOCK_FILE)) return {}
  try   { return JSON.parse(readFileSync(LOCK_FILE, 'utf8')) }
  catch { return {} }
}

function writeLock(sessions) {
  if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true })
  // Atomic-ish write: temp file + rename avoids partial-write corruption
  const tmp = LOCK_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(sessions, null, 2))
  renameSync(tmp, LOCK_FILE)
}

function isProcessAlive(pid) {
  try   { process.kill(pid, 0); return true }
  catch { return false }
}

/**
 * Claim a project session — assigns a projectId and ports for each
 * requested category. Categories can be a simple array ['fe','be'] or
 * an object with counts { fe: 2, be: 1 } for multiple service slots.
 *
 * @param {string} projectName
 * @param {'test'|'dev'|'prod'} env
 * @param {string[]|Record<string,number>} categories
 * @returns {Promise<{ projectId: number, ports: Record<string, number[]> }>}
 */
export async function claimSession(projectName, env, categories) {
  const sessions = readLock()

  // Evict stale sessions (PID no longer alive)
  for (const [name, session] of Object.entries(sessions)) {
    if (!isProcessAlive(session.pid)) delete sessions[name]
  }

  // If this project is already registered, return existing session
  if (sessions[projectName]) {
    const s = sessions[projectName]
    return { projectId: s.projectId, ports: s.ports }
  }

  // Claim lowest unused project ID
  const usedIds  = new Set(Object.values(sessions).map(s => s.projectId))
  let   projectId = 0
  while (usedIds.has(projectId)) projectId++
  if (projectId > 9) throw new Error('Maximum concurrent projects (10) reached')

  // Normalise categories to { category: count }
  const catMap = Array.isArray(categories)
    ? Object.fromEntries(categories.map(c => [c, 1]))
    : categories

  // Assign ports — fall back to next service slot if somehow in use
  const ports = {}
  for (const [category, count] of Object.entries(catMap)) {
    ports[category] = []
    let serviceId = 0
    for (let i = 0; i < count; i++) {
      // Find a free slot
      while (serviceId <= 9) {
        const p = port(category, { env, projectId, serviceId })
        if (!(await isPortInUse(p))) { ports[category].push(p); serviceId++; break }
        serviceId++
      }
    }
  }

  sessions[projectName] = {
    projectId,
    pid:       process.pid,
    env,
    ports,
    startedAt: new Date().toISOString(),
  }

  writeLock(sessions)

  // Inject into process.env so child processes inherit
  for (const [category, ps] of Object.entries(ports)) {
    if (ps.length === 1) {
      process.env[`FLI_PORT_${category.toUpperCase()}`] = String(ps[0])
    } else {
      ps.forEach((p, i) =>
        process.env[`FLI_PORT_${category.toUpperCase()}_${i}`] = String(p)
      )
    }
  }

  return { projectId, ports }
}

export function releaseSession(projectName) {
  const sessions = readLock()
  delete sessions[projectName]
  writeLock(sessions)
}

export function autoRelease(projectName) {
  const cleanup = () => releaseSession(projectName)
  process.on('exit',   cleanup)
  process.on('SIGINT',  () => { cleanup(); process.exit(0) })
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
}

/**
 * Get enriched status of all sessions — adds alive/stale flag.
 */
export function getSessionStatus() {
  const sessions = readLock()
  return Object.entries(sessions).map(([name, s]) => ({
    name,
    ...s,
    alive: isProcessAlive(s.pid),
  }))
}
