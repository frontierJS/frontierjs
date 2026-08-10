import { useState, useEffect } from 'react'

// ─── API CLIENT ─────────────────────────────────────────────────────────────
// Thin fetch wrapper around the Orion REST API.
// Falls back gracefully — if the server isn't reachable, components keep
// showing mock data. Each hook returns { data, loading, error, refetch }.

export const API_BASE = ""  // same origin; change to "http://localhost:3000" for dev

export const apiFetch = async (path, opts = {}) => {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`${res.status} ${res.statusText}${text ? ": " + text : ""}`)
  }
  return res.json()
}

// ── Flow API ─────────────────────────────────────────────────────────────────
export const flowApi = {
  list:       ()         => apiFetch("/api/flows"),
  get:        (id)       => apiFetch(`/api/flows/${id}`),
  create:     (body)     => apiFetch("/api/flows",      { method:"POST", body }),
  update:     (id, body) => apiFetch(`/api/flows/${id}`, { method:"PUT",  body }),
  delete:     (id)       => apiFetch(`/api/flows/${id}`, { method:"DELETE" }),
  activate:   (id)       => apiFetch(`/api/flows/${id}/activate`,   { method:"POST" }),
  deactivate: (id)       => apiFetch(`/api/flows/${id}/deactivate`, { method:"POST" }),
  versions:   (id)       => apiFetch(`/api/flows/${id}/versions`),
  executions: (id, p)    => apiFetch(`/api/flows/${id}/executions?${new URLSearchParams(p ?? {})}`),
  metrics:    (id, p)    => apiFetch(`/api/flows/${id}/metrics?${new URLSearchParams(p ?? {})}`),
}

// ── Credential API ────────────────────────────────────────────────────────────
export const credentialApi = {
  list:   ()         => apiFetch("/api/credentials"),
  get:    (id)       => apiFetch(`/api/credentials/${id}`),
  create: (body)     => apiFetch("/api/credentials",      { method:"POST", body }),
  update: (id, body) => apiFetch(`/api/credentials/${id}`, { method:"PUT",  body }),
  delete: (id)       => apiFetch(`/api/credentials/${id}`, { method:"DELETE" }),
}

// ── Execution API ─────────────────────────────────────────────────────────────
export const executionApi = {
  list: (params) => apiFetch(`/api/executions?${new URLSearchParams(
    Object.fromEntries(Object.entries(params ?? {}).filter(([,v]) => v != null).map(([k,v]) => [k, String(v)]))
  )}`),
  get:    (id) => apiFetch(`/api/executions/${id}`),
  cancel: (id) => apiFetch(`/api/executions/${id}/cancel`, { method:"DELETE" }),
}

// ── Metrics API ───────────────────────────────────────────────────────────────
export const metricsApi = {
  get: (params) => apiFetch(`/api/metrics?${new URLSearchParams(params ?? {})}`),
}

// ── Admin API ─────────────────────────────────────────────────────────────────
export const adminApi = {
  health:   ()        => apiFetch("/admin/health"),
  triggers: ()        => apiFetch("/admin/triggers"),
  pause:    (nodeId)  => apiFetch(`/admin/triggers/${nodeId}/pause`,  { method:"POST" }),
  resume:   (nodeId)  => apiFetch(`/admin/triggers/${nodeId}/resume`, { method:"POST" }),
}

// ── useApi hook — data fetching with loading/error/refetch ───────────────────
export const useApi = (fetcher, deps = []) => {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [tick,    setTick]    = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    fetcher()
      .then(d  => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [...deps, tick])

  return { data, loading, error, refetch: () => setTick(t => t + 1) }
}

// ── useMutation hook — POST/PUT/DELETE with loading state ────────────────────
export const useMutation = (fn) => {
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const mutate = async (...args) => {
    setLoading(true); setError(null)
    try {
      const result = await fn(...args)
      setLoading(false)
      return { ok: true, data: result }
    } catch(e) {
      setError(e.message); setLoading(false)
      return { ok: false, error: e.message }
    }
  }
  return [mutate, { loading, error }]
}

// ── Connectivity indicator — shows when API is unreachable ───────────────────
// Components set this; ApiStatusBanner reads it.
export let _apiOnline = true
const _apiStatusSubs = new Set()
export const setApiOnline = (v) => {
  if (_apiOnline === v) return
  _apiOnline = v
  _apiStatusSubs.forEach(fn => fn(v))
}
export const useApiStatus = () => {
  const [online, setOnline] = useState(_apiOnline)
  useEffect(() => { _apiStatusSubs.add(setOnline); return () => _apiStatusSubs.delete(setOnline) }, [])
  return online
}

export const ApiStatusBanner = () => {
  const online = useApiStatus()
  if (online) return null
  return (
    <div style={{
      position:"fixed", top:0, left:0, right:0, zIndex:10000,
      background:"var(--amber)", color:"#000",
      padding:"6px 16px", fontSize:12, fontFamily:"var(--font-ui)",
      display:"flex", alignItems:"center", justifyContent:"center", gap:8,
    }}>
      <span>⚠</span>
      <span>Backend unreachable — showing cached data. Changes will not be saved until the server is back online.</span>
    </div>
  )
}

// ─── MOCK DATA ──────────────────────────────────────────────────────────────
