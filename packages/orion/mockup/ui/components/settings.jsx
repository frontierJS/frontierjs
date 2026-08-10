import { useState, useEffect, useRef, useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { ACCOUNT_DATA, PLAN_LIMITS, CRED_TYPE_META, TRIGGER_REGISTRY, QUEUE_HEALTH,
         EVENT_BUS, SA_ACCOUNTS, PLAN_COLOR, ACCOUNT_STATUS_COLOR, fmt, now, FLOWS } from './mock.js'
import { Btn, Mono, StatusDot, StatusPill, Tag, Card, Stat, Table, Toggle, Avatar,
         PlanBadge, AccountStatus, MiniStatBar, SettingsSection, Divider,
         InputField, UsageBar, ROLE_COLORS, toast } from './primitives.jsx'
import { credentialApi, adminApi, setApiOnline } from './api.js'

// ── Create Account Modal ──────────────────────────────────────────────────
export const CreateAccountModal = ({ onClose, onCreate }) => {
  const [form, setForm] = useState({
    accountName: "",
    accountPlan: "starter",
    ownerName: "",
    ownerEmail: "",
    ownerPassword: "",
  })
  const [step, setStep]       = useState(1)   // 1 = account info, 2 = owner info, 3 = confirm
  const [creating, setCreating] = useState(false)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const valid1 = form.accountName.trim().length > 1
  const valid2 = form.ownerName.trim().length > 1 &&
                 form.ownerEmail.includes("@") &&
                 form.ownerPassword.length >= 8

  const handleCreate = () => {
    setCreating(true)
    setTimeout(() => {
      const accountId = `acc_${Date.now()}`
      const userId    = `usr_${Date.now()}_owner`
      const newAccount = {
        id: accountId,
        name: form.accountName.trim(),
        plan: form.accountPlan,
        status: "active",
        owner: {
          id: userId,
          name: form.ownerName.trim(),
          email: form.ownerEmail.trim().toLowerCase(),
          ownsAccount: accountId,
          role: "owner",
          createdAt: Date.now(),
        },
        workspaces: [{
          id: `ws_${accountId}_0`,
          name: "Default",
          flowCount: 0,
          createdAt: Date.now(),
        }],
        members: [{
          id: userId,
          name: form.ownerName.trim(),
          email: form.ownerEmail.trim().toLowerCase(),
          role: "owner",
          joinedAt: Date.now(),
        }],
        stats: { totalFlows:0, totalExecutions:0, activeFlows:0, failureRate:0, avgDurationMs:0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      onCreate(newAccount)
      setCreating(false)
    }, 800)
  }

  const Field = ({ label, value, onChange, type="text", placeholder, hint }) => (
    <div style={{ marginBottom:16 }}>
      <label style={{ display:"block", fontSize:12, color:"var(--muted)", textTransform:"uppercase",
        letterSpacing:"0.07em", marginBottom:6, fontFamily:"var(--font-ui)" }}>{label}</label>
      <input
        type={type} value={value}
        onChange={e=>onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width:"100%", background:"var(--surface)",
          border:"1px solid var(--border2)", borderRadius:5,
          padding:"8px 12px", fontSize:14,
          color:"var(--text)", outline:"none", fontFamily:"var(--font-ui)",
          transition:"border-color 0.12s",
        }}
        onFocus={e=>e.target.style.borderColor="var(--cyan)"}
        onBlur={e=>e.target.style.borderColor="var(--border2)"}
      />
      {hint && <div style={{ fontSize:12, color:"var(--muted)", marginTop:4 }}>{hint}</div>}
    </div>
  )

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:200,
      background:"rgba(8,10,15,0.82)", backdropFilter:"blur(4px)",
      display:"flex", alignItems:"center", justifyContent:"center",
    }} onClick={e => { if (e.target===e.currentTarget) onClose() }}>
      <div className="page-enter" style={{
        background:"var(--panel)", border:"1px solid var(--border2)",
        borderRadius:10, width:460, padding:"28px 28px 24px",
        boxShadow:"0 24px 64px rgba(0,0,0,0.6)",
      }}>
        {/* Header */}
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:24 }}>
          <div>
            <div style={{ fontFamily:"var(--font-head)", fontSize:17, fontWeight:700, color:"var(--text)", marginBottom:3 }}>
              Create Account
            </div>
            <div style={{ fontSize:12, color:"var(--muted)" }}>
              A new workspace and owner user will be provisioned automatically.
            </div>
          </div>
          <button onClick={onClose} style={{
            background:"none", border:"none", color:"var(--muted)",
            cursor:"pointer", fontSize:18, lineHeight:1, padding:"0 2px",
          }}>×</button>
        </div>

        {/* Step indicator */}
        <div style={{ display:"flex", gap:6, marginBottom:22 }}>
          {["Account","Owner","Review"].map((s,i) => (
            <div key={s} style={{ display:"flex", alignItems:"center", gap:6, flex:1 }}>
              <div style={{
                width:20, height:20, borderRadius:"50%", flexShrink:0,
                display:"flex", alignItems:"center", justifyContent:"center",
                background: step > i+1 ? "var(--green)" : step === i+1 ? "var(--cyan)" : "var(--surface)",
                border: `1px solid ${step > i+1 ? "var(--green)" : step === i+1 ? "var(--cyan)" : "var(--border2)"}`,
                fontSize:10, fontFamily:"var(--font-mono)", color: step >= i+1 ? "#000" : "var(--muted)",
                fontWeight:600,
              }}>{step > i+1 ? "✓" : i+1}</div>
              <span style={{ fontSize:12, color: step === i+1 ? "var(--text)" : "var(--muted)" }}>{s}</span>
              {i < 2 && <div style={{ flex:1, height:1, background: step > i+1 ? "var(--green)55" : "var(--border)" }} />}
            </div>
          ))}
        </div>

        {/* Step 1 — Account */}
        {step === 1 && (
          <div>
            <Field label="Account Name" value={form.accountName} onChange={v=>set("accountName",v)}
              placeholder="Acme Corp" />
            <div style={{ marginBottom:20 }}>
              <label style={{ display:"block", fontSize:12, color:"var(--muted)", textTransform:"uppercase",
                letterSpacing:"0.07em", marginBottom:8 }}>Plan</label>
              <div style={{ display:"flex", gap:8 }}>
                {["free","starter","pro","enterprise"].map(p => (
                  <button key={p} onClick={() => set("accountPlan",p)} style={{
                    flex:1, padding:"8px 0", borderRadius:5, cursor:"pointer",
                    border:`1px solid ${form.accountPlan===p ? PLAN_COLOR[p][1] : "var(--border)"}`,
                    background: form.accountPlan===p ? `${PLAN_COLOR[p][1]}18` : "var(--surface)",
                    color: form.accountPlan===p ? PLAN_COLOR[p][1] : "var(--muted)",
                    fontSize:12, fontFamily:"var(--font-mono)", textTransform:"uppercase",
                    letterSpacing:"0.05em",
                  }}>{p}</button>
                ))}
              </div>
            </div>
            <div style={{ display:"flex", justifyContent:"flex-end" }}>
              <Btn variant="primary" onClick={() => valid1 && setStep(2)}>Next →</Btn>
            </div>
          </div>
        )}

        {/* Step 2 — Owner */}
        {step === 2 && (
          <div>
            <div style={{
              background:"var(--cyan)0d", border:"1px solid var(--cyan)22",
              borderRadius:6, padding:"10px 12px", marginBottom:16, fontSize:12, color:"var(--cyan)",
            }}>
              This user will be created with <Mono size={11} color="var(--cyan)">role: owner</Mono> and{" "}
              <Mono size={11} color="var(--cyan)">ownsAccount: {"<new account id>"}</Mono>
            </div>
            <Field label="Full Name"  value={form.ownerName}     onChange={v=>set("ownerName",v)}   placeholder="Dan Harmon" />
            <Field label="Email"      value={form.ownerEmail}    onChange={v=>set("ownerEmail",v)}  placeholder="dan@acme.com" type="email" />
            <Field label="Password"   value={form.ownerPassword} onChange={v=>set("ownerPassword",v)} placeholder="min. 8 characters" type="password"
              hint="Temporary password — owner will be prompted to change on first login." />
            <div style={{ display:"flex", justifyContent:"space-between" }}>
              <Btn variant="ghost" onClick={() => setStep(1)}>← Back</Btn>
              <Btn variant="primary" onClick={() => valid2 && setStep(3)}>Review →</Btn>
            </div>
          </div>
        )}

        {/* Step 3 — Confirm */}
        {step === 3 && (
          <div>
            <div style={{
              background:"var(--surface)", border:"1px solid var(--border)",
              borderRadius:6, padding:"14px 16px", marginBottom:20,
              display:"flex", flexDirection:"column", gap:10,
            }}>
              {[
                ["Account",  form.accountName],
                ["Plan",     form.accountPlan.toUpperCase()],
                ["Workspace","Default (auto-created)"],
                ["Owner",    form.ownerName],
                ["Email",    form.ownerEmail],
                ["Password", "••••••••"],
              ].map(([k,v]) => (
                <div key={k} style={{ display:"flex", justifyContent:"space-between", fontSize:13 }}>
                  <span style={{ color:"var(--muted)" }}>{k}</span>
                  <Mono size={12} color="var(--text)">{v}</Mono>
                </div>
              ))}
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <Btn variant="ghost" onClick={() => setStep(2)}>← Back</Btn>
              <Btn variant="primary" onClick={handleCreate}>
                {creating ? "Creating…" : "✓ Create Account"}
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Account Detail Drawer ─────────────────────────────────────────────────
export const AccountDetail = ({ account, onClose, onSuspend, onReactivate }) => {
  const [subTab, setSubTab] = useState("overview")

  const SubTab = ({ id, label }) => (
    <button onClick={() => setSubTab(id)} style={{
      background:"none", border:"none", cursor:"pointer",
      padding:"6px 12px", borderRadius:5, fontSize:13,
      fontFamily:"var(--font-ui)",
      color: subTab===id ? "var(--cyan)" : "var(--muted)",
      background: subTab===id ? "var(--cyan)0d" : "transparent",
    }}>{label}</button>
  )

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:150,
      display:"flex", justifyContent:"flex-end",
    }}>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position:"absolute", inset:0, background:"rgba(8,10,15,0.5)" }} />

      {/* Drawer */}
      <div className="page-enter" style={{
        position:"relative", width:540,
        background:"var(--panel)", borderLeft:"1px solid var(--border2)",
        height:"100%", overflow:"auto",
        boxShadow:"-16px 0 48px rgba(0,0,0,0.4)",
        display:"flex", flexDirection:"column",
      }}>
        {/* Drawer header */}
        <div style={{
          padding:"20px 24px 16px",
          borderBottom:"1px solid var(--border)",
          display:"flex", flexDirection:"column", gap:10,
          position:"sticky", top:0, background:"var(--panel)", zIndex:1,
        }}>
          <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between" }}>
            <div>
              <div style={{ fontFamily:"var(--font-head)", fontSize:17, fontWeight:700, color:"var(--text)", marginBottom:4 }}>
                {account.name}
              </div>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                <Mono color="var(--muted)" size={11}>{account.id}</Mono>
                <PlanBadge plan={account.plan} />
                <AccountStatus status={account.status} />
              </div>
            </div>
            <div style={{ display:"flex", gap:6 }}>
              {account.status === "suspended"
                ? <Btn small variant="default" onClick={() => onReactivate(account.id)}>Reactivate</Btn>
                : <Btn small variant="danger"  onClick={() => onSuspend(account.id)}>Suspend</Btn>
              }
              <button onClick={onClose} style={{
                background:"none", border:"none", color:"var(--muted)",
                cursor:"pointer", fontSize:20, lineHeight:1, padding:"0 4px",
              }}>×</button>
            </div>
          </div>
          <div style={{ display:"flex", gap:4 }}>
            <SubTab id="overview"   label="Overview" />
            <SubTab id="workspaces" label={`Workspaces (${account.workspaces.length})`} />
            <SubTab id="members"    label={`Members (${account.members.length})`} />
          </div>
        </div>

        <div style={{ padding:"20px 24px", flex:1 }}>

          {/* Overview tab */}
          {subTab === "overview" && (
            <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
              {/* Stats grid */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                {[
                  ["Total Flows",      account.stats.totalFlows,      "var(--cyan)"],
                  ["Active Flows",     account.stats.activeFlows,     "var(--green)"],
                  ["Total Executions", account.stats.totalExecutions, "var(--text)"],
                  ["Failure Rate",     `${(account.stats.failureRate*100).toFixed(1)}%`, account.stats.failureRate > 0.05 ? "var(--red)" : "var(--green)"],
                ].map(([label, val, color]) => (
                  <div key={label} style={{
                    background:"var(--surface)", border:"1px solid var(--border)",
                    borderRadius:6, padding:"12px 14px",
                  }}>
                    <div style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:5 }}>{label}</div>
                    <div style={{ fontFamily:"var(--font-mono)", fontSize:20, color, fontWeight:500 }}>
                      {typeof val === "number" ? val.toLocaleString() : val}
                    </div>
                  </div>
                ))}
              </div>

              {/* Owner info */}
              <div style={{
                background:"var(--surface)", border:"1px solid var(--border)",
                borderRadius:6, padding:"14px 16px",
              }}>
                <div style={{ fontSize:12, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:10 }}>Account Owner</div>
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                  <div style={{
                    width:36, height:36, borderRadius:"50%",
                    background:"var(--cyan)22", border:"1px solid var(--cyan)44",
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontFamily:"var(--font-mono)", fontSize:14, color:"var(--cyan)", fontWeight:600,
                  }}>{account.owner.name.charAt(0)}</div>
                  <div>
                    <div style={{ fontSize:14, fontWeight:500, color:"var(--text)", marginBottom:2 }}>{account.owner.name}</div>
                    <Mono color="var(--muted)" size={11}>{account.owner.email}</Mono>
                  </div>
                  <div style={{ marginLeft:"auto" }}>
                    <span style={{
                      padding:"2px 8px", borderRadius:3, fontSize:11,
                      background:"var(--amber)18", color:"var(--amber)",
                      border:"1px solid var(--amber)33",
                      fontFamily:"var(--font-mono)",
                    }}>owner</span>
                  </div>
                </div>
              </div>

              {/* Metadata */}
              <div style={{
                background:"var(--surface)", border:"1px solid var(--border)",
                borderRadius:6, padding:"14px 16px",
              }}>
                <div style={{ fontSize:12, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:10 }}>Metadata</div>
                {[
                  ["Created",         new Date(account.createdAt).toLocaleDateString("en-US",{ year:"numeric",month:"short",day:"numeric"})],
                  ["Last Updated",    new Date(account.updatedAt).toLocaleDateString("en-US",{ year:"numeric",month:"short",day:"numeric"})],
                  ["Account ID",      account.id],
                  ["Avg Exec Duration", fmt.duration(account.stats.avgDurationMs)],
                ].map(([k,v]) => (
                  <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:7, fontSize:13 }}>
                    <span style={{ color:"var(--muted)" }}>{k}</span>
                    <Mono size={11} color="var(--text)">{v}</Mono>
                  </div>
                ))}
              </div>

              {/* Impersonation stub */}
              <div style={{
                background:"var(--amber)08", border:"1px solid var(--amber)22",
                borderRadius:6, padding:"14px 16px",
                display:"flex", alignItems:"center", justifyContent:"space-between",
              }}>
                <div>
                  <div style={{ fontSize:13, color:"var(--amber)", fontWeight:500, marginBottom:3 }}>Impersonate Account</div>
                  <div style={{ fontSize:12, color:"var(--muted)" }}>
                    Switch session context to this account for debugging.
                  </div>
                </div>
                <Btn small variant="default" onClick={() => toast.info("Impersonation — coming soon")}>
                  👤 Impersonate
                </Btn>
              </div>
            </div>
          )}

          {/* Workspaces tab */}
          {subTab === "workspaces" && (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {account.workspaces.map(ws => (
                <div key={ws.id} style={{
                  background:"var(--surface)", border:"1px solid var(--border)",
                  borderRadius:6, padding:"12px 16px",
                  display:"flex", alignItems:"center", justifyContent:"space-between",
                }}>
                  <div>
                    <div style={{ fontSize:14, color:"var(--text)", fontWeight:500, marginBottom:2 }}>{ws.name}</div>
                    <Mono color="var(--muted)" size={10}>{ws.id}</Mono>
                  </div>
                  <div style={{ display:"flex", gap:16, alignItems:"center" }}>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:11, color:"var(--muted)", marginBottom:2 }}>Flows</div>
                      <Mono size={13}>{ws.flowCount}</Mono>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:11, color:"var(--muted)", marginBottom:2 }}>Created</div>
                      <Mono size={10} color="var(--muted)">{new Date(ws.createdAt).toLocaleDateString()}</Mono>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Members tab */}
          {subTab === "members" && (
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {account.members.map(m => {
                const roleColor = m.role==="owner" ? "var(--amber)" : m.role==="admin" ? "var(--cyan)" : "var(--muted)"
                return (
                  <div key={m.id} style={{
                    background:"var(--surface)", border:"1px solid var(--border)",
                    borderRadius:6, padding:"10px 14px",
                    display:"flex", alignItems:"center", gap:12,
                  }}>
                    <div style={{
                      width:30, height:30, borderRadius:"50%", flexShrink:0,
                      background:`${roleColor}22`, border:`1px solid ${roleColor}44`,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontFamily:"var(--font-mono)", fontSize:12, color:roleColor,
                    }}>{m.name.charAt(0)}</div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, color:"var(--text)", marginBottom:1 }}>{m.name}</div>
                      <Mono color="var(--muted)" size={10}>{m.email}</Mono>
                    </div>
                    <span style={{
                      padding:"1px 8px", borderRadius:3, fontSize:11,
                      background:`${roleColor}18`, color:roleColor,
                      border:`1px solid ${roleColor}33`,
                      fontFamily:"var(--font-mono)",
                    }}>{m.role}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── System Admin Page ─────────────────────────────────────────────────────
export const SystemAdminPage = ({ setPage }) => {
  const [sysTab, setSysTab] = useState("accounts")
  const [accounts, setAccounts]   = useState(SA_ACCOUNTS)
  const [triggerRegistry, setTriggerRegistry] = useState(TRIGGER_REGISTRY)
  const [emitModalEvent, setEmitModalEvent] = useState(null)
  const [search, setSearch]       = useState("")
  const [planFilter, setPlanFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [sortBy, setSortBy] = useState("createdAt")

  // Fetch live trigger registry and health on mount and when switching to those tabs
  useEffect(() => {
    if (sysTab !== "triggers") return
    adminApi.triggers()
      .then(data => {
        if (data?.triggers?.length) {
          // Merge API data over mock — preserve UI-only fields (workspaceId, fireCount etc.)
          setTriggerRegistry(prev => {
            const byNodeId = Object.fromEntries(prev.map(t => [t.nodeId, t]))
            return data.triggers.map(t => ({
              ...(byNodeId[t.nodeId] ?? {}),
              ...t,
              // Normalise kind from API shape
              kind: t.kind ?? (t.path ? "webhook" : t.expression ? "cron" : t.eventName ? "event" : "manual"),
            }))
          })
          setApiOnline(true)
        }
      })
      .catch(() => setApiOnline(false))
  }, [sysTab])

  const filtered = useMemo(() => {
    let acc = [...accounts]
    if (search)            acc = acc.filter(a => a.name.toLowerCase().includes(search.toLowerCase()) || a.owner.email.toLowerCase().includes(search.toLowerCase()))
    if (planFilter!=="all")   acc = acc.filter(a => a.plan === planFilter)
    if (statusFilter!=="all") acc = acc.filter(a => a.status === statusFilter)
    if (sortBy === "executions") acc.sort((a,b) => b.stats.totalExecutions - a.stats.totalExecutions)
    else if (sortBy === "name")  acc.sort((a,b) => a.name.localeCompare(b.name))
    else                         acc.sort((a,b) => b.createdAt - a.createdAt)
    return acc
  }, [accounts, search, planFilter, statusFilter, sortBy])

  const systemTotals = useMemo(() => ({
    accounts:   accounts.length,
    active:     accounts.filter(a=>a.status==="active").length,
    users:      accounts.reduce((s,a)=>s+a.members.length,0),
    flows:      accounts.reduce((s,a)=>s+a.stats.totalFlows,0),
    executions: accounts.reduce((s,a)=>s+a.stats.totalExecutions,0),
  }), [accounts])

  const maxExec = Math.max(...accounts.map(a=>a.stats.totalExecutions))

  const handleCreate = (newAccount) => {
    setAccounts(prev => [newAccount, ...prev])
    SA_ACCOUNTS = [newAccount, ...SA_ACCOUNTS]
    setShowCreate(false)
    setSelectedAccount(newAccount)
  }

  const handleSuspend = (id) => {
    setAccounts(prev => prev.map(a => a.id===id ? {...a, status:"suspended"} : a))
    if (selectedAccount?.id === id) setSelectedAccount(a => ({...a, status:"suspended"}))
  }

  const handleReactivate = (id) => {
    setAccounts(prev => prev.map(a => a.id===id ? {...a, status:"active"} : a))
    if (selectedAccount?.id === id) setSelectedAccount(a => ({...a, status:"active"}))
  }

  const SysSubTab = ({ id, label, count }) => (
    <button onClick={() => setSysTab(id)} style={{
      background:"none", border:"none", cursor:"pointer",
      padding:"6px 14px", borderRadius:5, fontSize:13, fontFamily:"var(--font-ui)",
      display:"flex", alignItems:"center", gap:6,
      color: sysTab===id ? "var(--red)" : "var(--muted)",
      background: sysTab===id ? "var(--red)0d" : "transparent",
      border: `1px solid ${sysTab===id ? "var(--red)22" : "transparent"}`,
    }}>
      {label}
      {count != null && (
        <span style={{ fontFamily:"var(--font-mono)", fontSize:11,
          background: sysTab===id ? "var(--red)22" : "var(--border)",
          color: sysTab===id ? "var(--red)" : "var(--muted)",
          padding:"0 5px", borderRadius:3 }}>{count}</span>
      )}
    </button>
  )

  return (
    <div className="page-enter" style={{ padding:"32px 28px", maxWidth:1280 }}>
      {/* Page header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <span style={{
            fontSize:11, fontFamily:"var(--font-mono)",
            background:"var(--red)18", color:"var(--red)",
            border:"1px solid var(--red)33",
            padding:"2px 8px", borderRadius:3, letterSpacing:"0.06em",
            textTransform:"uppercase",
          }}>SUPERADMIN</span>
          <h2 style={{ fontFamily:"var(--font-head)", fontSize:18, fontWeight:700, color:"var(--text)", letterSpacing:"-0.02em" }}>
            System
          </h2>
        </div>
        {sysTab === "accounts" && <Btn variant="primary" onClick={() => setShowCreate(true)}>+ New Account</Btn>}
        {sysTab === "events"   && <Btn variant="default" onClick={() => setEmitModalEvent(EVENT_BUS.events[0] ?? {name:"",subscribers:[]})}>⚡ Emit Event</Btn>}
      </div>

      {/* Sub-nav */}
      <div style={{ display:"flex", gap:4, marginBottom:24, borderBottom:"1px solid var(--border)", paddingBottom:12 }}>
        <SysSubTab id="accounts" label="Accounts"         count={accounts.length} />
        <SysSubTab id="triggers" label="Trigger Registry" count={TRIGGER_REGISTRY.length} />
        <SysSubTab id="queue"    label="Queue & Scheduler" />
        <SysSubTab id="events"   label="Event Bus"        count={EVENT_BUS.events.length} />
      </div>

      {/* ── ACCOUNTS tab ─────────────────────────────────────────── */}
      {sysTab === "accounts" && (<>
      {/* System-wide totals */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:12, marginBottom:24 }}>
        <Stat label="Accounts"    value={systemTotals.accounts}              accent="var(--cyan)" />
        <Stat label="Active"      value={systemTotals.active}                accent="var(--green)" sub={`${accounts.filter(a=>a.status==="trial").length} trial  ·  ${accounts.filter(a=>a.status==="suspended").length} suspended`} />
        <Stat label="Total Users" value={systemTotals.users.toLocaleString()} />
        <Stat label="Total Flows" value={systemTotals.flows.toLocaleString()} />
        <Stat label="All-time Executions" value={(systemTotals.executions/1000).toFixed(1)+"k"} accent="var(--purple)" />
      </div>

      {/* Filters */}
      <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
        <input
          value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Search accounts or owner email…"
          style={{
            background:"var(--panel)", border:"1px solid var(--border2)",
            borderRadius:5, padding:"5px 12px",
            fontSize:13, color:"var(--text)", outline:"none",
            fontFamily:"var(--font-ui)", width:240,
          }}
        />
        <div style={{ display:"flex", gap:4 }}>
          {["all","free","starter","pro","enterprise"].map(p => (
            <Btn key={p} small variant={planFilter===p?"primary":"ghost"} onClick={()=>setPlanFilter(p)}>{p}</Btn>
          ))}
        </div>
        <div style={{ display:"flex", gap:4 }}>
          {["all","active","trial","suspended"].map(s => (
            <Btn key={s} small variant={statusFilter===s?"primary":"ghost"} onClick={()=>setStatusFilter(s)}>{s}</Btn>
          ))}
        </div>
        <div style={{ marginLeft:"auto", display:"flex", gap:4, alignItems:"center" }}>
          <span style={{ fontSize:12, color:"var(--muted)" }}>Sort:</span>
          {[["createdAt","Newest"],["executions","Executions"],["name","Name"]].map(([k,l]) => (
            <Btn key={k} small variant={sortBy===k?"default":"ghost"} onClick={()=>setSortBy(k)}>{l}</Btn>
          ))}
        </div>
      </div>

      {/* Accounts table */}
      <Table
        cols={[
          {
            key:"name", label:"Account",
            render: a => (
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3 }}>
                  <span style={{ fontSize:14, fontWeight:500, color:"var(--text)" }}>{a.name}</span>
                  {a.status === "suspended" && (
                    <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:"var(--red)", background:"var(--red)18", padding:"1px 5px", borderRadius:2 }}>SUSPENDED</span>
                  )}
                </div>
                <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                  <Mono color="var(--muted)" size={10}>{a.id}</Mono>
                  <span style={{ color:"var(--dim)" }}>·</span>
                  <Mono color="var(--muted)" size={10}>{a.owner.email}</Mono>
                </div>
              </div>
            )
          },
          {
            key:"plan", label:"Plan",
            render: a => <PlanBadge plan={a.plan} />
          },
          {
            key:"status", label:"Status",
            render: a => <AccountStatus status={a.status} />
          },
          {
            key:"workspaces", label:"Workspaces",
            render: a => <Mono>{a.workspaces.length}</Mono>
          },
          {
            key:"users", label:"Users",
            render: a => <Mono>{a.members.length}</Mono>
          },
          {
            key:"flows", label:"Flows",
            render: a => (
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <Mono>{a.stats.totalFlows}</Mono>
                <Mono color="var(--muted)" size={10}>({a.stats.activeFlows} active)</Mono>
              </div>
            )
          },
          {
            key:"executions", label:"Executions",
            render: a => <MiniStatBar value={a.stats.totalExecutions} max={maxExec} color="var(--cyan)88"/>
          },
          {
            key:"health", label:"Failure Rate",
            render: a => (
              <Mono color={a.stats.failureRate > 0.05 ? "var(--red)" : a.stats.failureRate > 0.02 ? "var(--amber)" : "var(--green)"}>
                {(a.stats.failureRate*100).toFixed(1)}%
              </Mono>
            )
          },
          {
            key:"created", label:"Created",
            render: a => <Mono color="var(--muted)" size={11}>{fmt.time(now - a.createdAt)}</Mono>
          },
          {
            key:"actions", label:"",
            render: a => (
              <div style={{ display:"flex", gap:6 }} onClick={e=>e.stopPropagation()}>
                <Btn small onClick={() => setSelectedAccount(a)}>View</Btn>
                {a.status !== "suspended"
                  ? <Btn small variant="danger"  onClick={() => handleSuspend(a.id)}>Suspend</Btn>
                  : <Btn small variant="default" onClick={() => handleReactivate(a.id)}>Reactivate</Btn>
                }
              </div>
            )
          },
        ]}
        rows={filtered}
        onRowClick={setSelectedAccount}
      />

      {filtered.length === 0 && (
        <div style={{ textAlign:"center", padding:"60px 20px", color:"var(--muted)", fontSize:14 }}>
          No accounts match the current filters.
        </div>
      )}
      </>)}

      {/* ── TRIGGERS tab ─────────────────────────────────────────── */}
      {sysTab === "triggers" && (<>
        {/* ── summary stats ── */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:24 }}>
          {[["webhook","⚡","var(--cyan)"],["cron","⏱","var(--amber)"],["event","◎","var(--purple)"],["manual","▶","var(--muted)"]].map(([kind,icon,color]) => {
            const count   = triggerRegistry.filter(t=>t.kind===kind).length
            const paused  = triggerRegistry.filter(t=>t.kind===kind&&t.status==="paused").length
            return (
              <div key={kind} style={{ background:"var(--panel)", border:`1px solid ${color}33`, borderRadius:8, padding:"14px 18px", borderLeft:`2px solid ${color}` }}>
                <div style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:6 }}>{icon} {kind}</div>
                <div style={{ fontFamily:"var(--font-mono)", fontSize:22, color, fontWeight:500 }}>{count}</div>
                {paused > 0 && <div style={{ fontSize:10, color:"var(--amber)", marginTop:4 }}>{paused} paused</div>}
              </div>
            )
          })}
        </div>

        {/* ── per-kind groups ── */}
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {["webhook","cron","event","manual"].map(kind => {
            const entries = triggerRegistry.filter(t=>t.kind===kind)
            if (!entries.length) return null
            const color = kind==="webhook"?"var(--cyan)":kind==="cron"?"var(--amber)":kind==="event"?"var(--purple)":"var(--muted)"
            const icon  = kind==="webhook"?"⚡":kind==="cron"?"⏱":kind==="event"?"◎":"▶"
            return (
              <div key={kind}>
                <div style={{ fontSize:12, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.08em", margin:"16px 0 8px" }}>
                  {icon} {kind} triggers
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {entries.map(t => {
                    const flow = FLOWS.find(f=>f.id===t.flowId)
                    const ws   = ACCOUNT_DATA.workspaces.find(w=>w.id===t.workspaceId)
                    const isPaused = t.status === "paused"
                    const hasMissed = (t.missedCount ?? 0) > 0
                    return (
                      <div key={t.nodeId} style={{
                        background:"var(--panel)", border:`1px solid ${isPaused ? "var(--amber)33" : "var(--border)"}`,
                        borderLeft:`2px solid ${isPaused ? "var(--amber)" : color}`,
                        borderRadius:7, padding:"11px 14px",
                        opacity: isPaused ? 0.75 : 1,
                        transition:"opacity 0.15s",
                      }}>
                        {/* Row 1: breadcrumb + status badge + actions */}
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                            {/* Account → Workspace → Flow breadcrumb */}
                            <span style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>Orion HQ</span>
                            <span style={{ fontSize:10, color:"var(--dim)" }}>›</span>
                            <span style={{ fontSize:11, color: ws?.color ?? "var(--muted)", fontFamily:"var(--font-ui)",
                              background:`${ws?.color ?? "#888"}18`, border:`1px solid ${ws?.color ?? "#888"}33`,
                              padding:"1px 6px", borderRadius:3 }}>{ws?.name ?? t.workspaceId}</span>
                            <span style={{ fontSize:10, color:"var(--dim)" }}>›</span>
                            <span style={{ fontSize:12, color:"var(--text)", fontWeight:500, fontFamily:"var(--font-ui)" }}>
                              {flow?.name ?? t.flowId}
                            </span>
                            <Mono size={10} color="var(--dim)">v{t.version}</Mono>

                            {isPaused && (
                              <span style={{ fontSize:10, color:"var(--amber)", background:"var(--amber)18", border:"1px solid var(--amber)33", padding:"1px 6px", borderRadius:3, fontFamily:"var(--font-mono)" }}>PAUSED</span>
                            )}
                            {hasMissed && (
                              <span style={{ fontSize:10, color:"var(--red)", background:"var(--red)14", border:"1px solid var(--red)33", padding:"1px 6px", borderRadius:3, fontFamily:"var(--font-mono)" }}>
                                {t.missedCount} missed
                              </span>
                            )}
                          </div>

                          {/* Action buttons */}
                          <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                            {/* Pause / Resume */}
                            <button
                              onClick={async () => {
                                const next = isPaused ? "active" : "paused"
                                // Optimistic
                                setTriggerRegistry(reg => reg.map(r => r.nodeId===t.nodeId ? {...r, status:next} : r))
                                try {
                                  if (isPaused) await adminApi.resume(t.nodeId)
                                  else          await adminApi.pause(t.nodeId)
                                  setApiOnline(true)
                                } catch(e) {
                                  // Revert
                                  setTriggerRegistry(reg => reg.map(r => r.nodeId===t.nodeId ? {...r, status:t.status} : r))
                                  toast.error("Failed to update trigger", { detail: e.message })
                                  setApiOnline(false)
                                }
                              }}
                              style={{
                                padding:"3px 10px", borderRadius:4, cursor:"pointer", fontSize:11,
                                fontFamily:"var(--font-ui)",
                                background: isPaused ? "var(--green)12" : "var(--amber)12",
                                border:`1px solid ${isPaused ? "var(--green)33" : "var(--amber)33"}`,
                                color: isPaused ? "var(--green)" : "var(--amber)",
                                transition:"all 0.1s",
                              }}
                              onMouseEnter={e=>e.currentTarget.style.opacity="0.8"}
                              onMouseLeave={e=>e.currentTarget.style.opacity="1"}
                            >{isPaused ? "▶ Resume" : "⏸ Pause"}</button>

                            {/* View executions cross-link */}
                            <button
                              onClick={() => setPage("Executions")}
                              title="View executions for this flow"
                              style={{
                                padding:"3px 10px", borderRadius:4, cursor:"pointer", fontSize:11,
                                fontFamily:"var(--font-ui)",
                                background:"var(--surface)", border:"1px solid var(--border)",
                                color:"var(--muted)", transition:"all 0.1s",
                              }}
                              onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--cyan)44";e.currentTarget.style.color="var(--cyan)"}}
                              onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.color="var(--muted)"}}
                            >executions →</button>
                          </div>
                        </div>

                        {/* Row 2: detail chip + timing info */}
                        <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
                          {/* Kind-specific detail */}
                          {kind === "webhook" && (
                            <span style={{ fontFamily:"var(--font-mono)", fontSize:12, color,
                              background:`${color}14`, border:`1px solid ${color}33`,
                              padding:"2px 8px", borderRadius:3 }}>
                              POST localhost:3000{t.path}
                            </span>
                          )}
                          {kind === "cron" && (
                            <span style={{ fontFamily:"var(--font-mono)", fontSize:12, color,
                              background:`${color}14`, border:`1px solid ${color}33`,
                              padding:"2px 8px", borderRadius:3 }}>
                              {t.expression}
                              {t.jitterMs > 0 && <span style={{color:"var(--muted)",marginLeft:6}}>+{t.jitterMs}ms jitter</span>}
                            </span>
                          )}
                          {kind === "event" && (
                            <span style={{ fontFamily:"var(--font-mono)", fontSize:12, color,
                              background:`${color}14`, border:`1px solid ${color}33`,
                              padding:"2px 8px", borderRadius:3 }}>
                              {t.eventName}
                            </span>
                          )}
                          {kind === "manual" && (
                            <span style={{ fontFamily:"var(--font-mono)", fontSize:12, color:"var(--muted)",
                              background:"var(--surface)", border:"1px solid var(--border)",
                              padding:"2px 8px", borderRadius:3 }}>manual</span>
                          )}

                          {/* Timing info */}
                          <span style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-mono)" }}>
                            last: <span style={{color:"var(--text)"}}>{t.lastFiredAt ? fmt.time(now - t.lastFiredAt) : "never"}</span>
                          </span>
                          {t.nextFireAt && (
                            <span style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-mono)" }}>
                              next: <span style={{color:"var(--green)"}}>{fmt.time(t.nextFireAt - now, true)}</span>
                            </span>
                          )}
                          <span style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-mono)" }}>
                            {(t.fireCount ?? 0).toLocaleString()} fires
                          </span>
                          <Mono size={10} color="var(--dim)">{t.nodeId}</Mono>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </>)}

      {/* ── QUEUE tab ─────────────────────────────────────────────── */}
      {sysTab === "queue" && <_QueueTab setPage={setPage} />}

      {/* ── EVENTS tab ────────────────────────────────────────────── */}
      {sysTab === "events" && <_EventBusTab emitModalEvent={emitModalEvent} setEmitModalEvent={setEmitModalEvent} setPage={setPage} />}

      {/* Modals / drawers */}
      {showCreate && (
        <CreateAccountModal onClose={() => setShowCreate(false)} onCreate={handleCreate} />
      )}
      {selectedAccount && (
        <AccountDetail
          account={accounts.find(a=>a.id===selectedAccount.id) ?? selectedAccount}
          onClose={() => setSelectedAccount(null)}
          onSuspend={handleSuspend}
          onReactivate={handleReactivate}
        />
      )}

    </div>
  )
}

// ── _QueueTab ──────────────────────────────────────────────────────────────
export const _QueueTab = ({ setPage }) => {
  const [concurrencyOverride, setConcurrencyOverride] = useState(null)
  const [dlq, setDlq]           = useState(QUEUE_HEALTH.deadLetterQueue)
  const [killedExecs, setKilledExecs] = useState(new Set())
  const [retriedIds, setRetriedIds]   = useState(new Set())
  const concurrency = concurrencyOverride ?? QUEUE_HEALTH.schedulerConcurrency
  const activeExecs = QUEUE_HEALTH.activeExecutions.filter(e => !killedExecs.has(e.executionId))

  return (<>
    {/* Health strip */}
    <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:24 }}>
      <Stat label="Queue Depth"    value={QUEUE_HEALTH.queueDepth}
        accent={QUEUE_HEALTH.queueDepth > 100 ? "var(--red)" : QUEUE_HEALTH.queueDepth > 20 ? "var(--amber)" : "var(--green)"}
        sub={`capacity: ${QUEUE_HEALTH.queueCapacity}`} />
      <Stat label="Active Jobs"    value={activeExecs.length}   accent="var(--cyan)"
        sub={`concurrency: ${concurrency}${concurrencyOverride !== null ? " (override)" : ""}`} />
      <Stat label="Plan Cache"     value={QUEUE_HEALTH.planCacheSize} sub="compiled flows cached" />
      <Stat label="Dead Letter"    value={dlq.length}
        accent={dlq.length > 0 ? "var(--red)" : "var(--green)"}
        sub="failed — all retries exhausted" />
    </div>

    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16 }}>
      {/* Throughput sparkline */}
      <Card>
        <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:14 }}>
          Executions / Minute (last 12 min)
        </div>
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={QUEUE_HEALTH.recentThroughput} barSize={14}>
            <XAxis dataKey="minute" tick={{fontSize:10,fill:"var(--muted)",fontFamily:"var(--font-mono)"}} tickLine={false} axisLine={false} interval={2}/>
            <YAxis tick={{fontSize:10,fill:"var(--muted)",fontFamily:"var(--font-mono)"}} tickLine={false} axisLine={false} width={28}/>
            <Tooltip content={({active,payload,label}) => active&&payload?.length ? (
              <div style={{background:"var(--panel)",border:"1px solid var(--border2)",borderRadius:5,padding:"7px 10px",fontFamily:"var(--font-mono)",fontSize:12}}>
                <div style={{color:"var(--muted)",marginBottom:3}}>{label}</div>
                <div style={{color:"var(--cyan)"}}>{payload[0].value} exec/min</div>
              </div>
            ) : null}/>
            <Bar dataKey="count" fill="var(--cyan)" opacity={0.6} radius={[2,2,0,0]}/>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      {/* Scheduler state + concurrency override */}
      <Card>
        <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:14 }}>
          Scheduler State
        </div>
        <div style={{ marginBottom:12 }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
            <span style={{fontSize:12,color:"var(--muted)"}}>Concurrency</span>
            <span style={{fontFamily:"var(--font-mono)",fontSize:12,color: concurrencyOverride !== null ? "var(--amber)" : "var(--text)"}}>{activeExecs.length} / {concurrency}</span>
          </div>
          <div style={{height:6,background:"var(--surface)",borderRadius:3}}>
            <div style={{height:"100%",width:`${Math.min(100,(activeExecs.length/concurrency)*100)}%`,background:"var(--cyan)",borderRadius:3}}/>
          </div>
        </div>
        <div style={{ marginBottom:12 }}>
          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
            <span style={{fontSize:12,color:"var(--muted)"}}>Queue Fill</span>
            <span style={{fontFamily:"var(--font-mono)",fontSize:12}}>{QUEUE_HEALTH.queueDepth} / {QUEUE_HEALTH.queueCapacity}</span>
          </div>
          <div style={{height:6,background:"var(--surface)",borderRadius:3}}>
            <div style={{height:"100%",width:`${(QUEUE_HEALTH.queueDepth/QUEUE_HEALTH.queueCapacity)*100}%`,background:"var(--green)",borderRadius:3}}/>
          </div>
        </div>
        {/* Concurrency override */}
        <div style={{padding:"10px 12px",background:"var(--surface)",border:"1px solid var(--border)",borderRadius:6}}>
          <div style={{fontSize:11,color:"var(--muted)",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.06em"}}>
            Concurrency Override {concurrencyOverride !== null && <span style={{color:"var(--amber)"}}> — active</span>}
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
            {[1, 2, 5, 10, 20].map(v => (
              <button key={v} onClick={() => setConcurrencyOverride(concurrencyOverride===v ? null : v)}
                style={{padding:"3px 10px", borderRadius:4, cursor:"pointer", fontSize:12,
                  fontFamily:"var(--font-mono)",
                  background: concurrencyOverride===v ? "var(--amber)22" : "var(--panel)",
                  border:`1px solid ${concurrencyOverride===v ? "var(--amber)55" : "var(--border)"}`,
                  color: concurrencyOverride===v ? "var(--amber)" : "var(--muted)",
                  transition:"all 0.1s"}}
              >{v}</button>
            ))}
            {concurrencyOverride !== null && (
              <button onClick={() => setConcurrencyOverride(null)}
                style={{padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:11,
                  background:"transparent",border:"1px solid var(--border)",color:"var(--dim)",fontFamily:"var(--font-ui)"}}>
                reset
              </button>
            )}
          </div>
          <div style={{fontSize:10,color:"var(--dim)",marginTop:6}}>Click to cap. Click again or reset to restore default ({QUEUE_HEALTH.schedulerConcurrency}).</div>
        </div>
      </Card>
    </div>

    {/* Active executions */}
    <Card style={{marginBottom:16}}>
      <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:14 }}>
        In-Flight Executions ({activeExecs.length})
      </div>
      {activeExecs.length === 0 ? (
        <div style={{textAlign:"center",padding:"20px 0",color:"var(--muted)",fontSize:13}}>No active executions</div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {activeExecs.map(e => {
            const flow    = FLOWS.find(f=>f.id===e.flowId)
            const pct     = Math.round((e.stage / e.totalStages) * 100)
            const elapsed = Date.now() - e.startedAt
            return (
              <div key={e.executionId} style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:6,padding:"11px 14px"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <StatusDot status="running" size={7}/>
                    <span style={{fontSize:13,color:"var(--text)",fontWeight:500}}>{flow?.name ?? e.flowId}</span>
                    <Mono size={10} color="var(--muted)">{e.executionId}</Mono>
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <Mono size={11} color="var(--muted)">stage {e.stage}/{e.totalStages}</Mono>
                    <Mono size={11} color="var(--cyan)">{fmt.duration(elapsed)}</Mono>
                    <button
                      onClick={() => setKilledExecs(s => new Set([...s, e.executionId]))}
                      style={{padding:"2px 9px",borderRadius:4,cursor:"pointer",fontSize:11,
                        background:"var(--red)12",border:"1px solid var(--red)33",color:"var(--red)",
                        fontFamily:"var(--font-ui)",transition:"all 0.1s"}}
                      onMouseEnter={ev=>ev.currentTarget.style.background="var(--red)22"}
                      onMouseLeave={ev=>ev.currentTarget.style.background="var(--red)12"}
                    >⏹ Kill</button>
                  </div>
                </div>
                <div style={{height:4,background:"var(--border)",borderRadius:2}}>
                  <div style={{height:"100%",width:`${pct}%`,background:"var(--cyan)",borderRadius:2,
                    boxShadow:"0 0 6px var(--cyan)",backgroundSize:"200% 100%",
                    backgroundImage:"linear-gradient(90deg, var(--cyan)88 0%, var(--cyan) 50%, var(--cyan)88 100%)"
                  }}/>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>

    {/* Dead Letter Queue */}
    <Card>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color: dlq.length > 0 ? "var(--red)" : "var(--muted)" }}>
          ☠ Dead Letter Queue ({dlq.length})
        </div>
        {dlq.length > 0 && (
          <button onClick={() => setDlq([])}
            style={{padding:"3px 10px",borderRadius:4,cursor:"pointer",fontSize:11,
              background:"var(--surface)",border:"1px solid var(--border)",color:"var(--muted)",fontFamily:"var(--font-ui)"}}>
            Dismiss all
          </button>
        )}
      </div>
      {dlq.length === 0 ? (
        <div style={{textAlign:"center",padding:"20px 0",color:"var(--muted)",fontSize:13}}>✓ No failed jobs</div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {dlq.map(job => {
            const flow    = FLOWS.find(f=>f.id===job.flowId)
            const retried = retriedIds.has(job.id)
            return (
              <div key={job.id} style={{background:"var(--surface)",border:"1px solid var(--red)22",borderLeft:"2px solid var(--red)",borderRadius:6,padding:"11px 14px"}}>
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5,flexWrap:"wrap"}}>
                      <span style={{fontSize:13,color:"var(--text)",fontWeight:500}}>{flow?.name ?? job.flowId}</span>
                      <Mono size={10} color="var(--dim)">{job.executionId}</Mono>
                      <span style={{fontSize:10,color:"var(--muted)",fontFamily:"var(--font-mono)",
                        background:"var(--panel)",border:"1px solid var(--border)",padding:"1px 5px",borderRadius:2}}>
                        {job.triggeredBy} · node: {job.nodeId}
                      </span>
                      <span style={{fontSize:10,color:"var(--red)",fontFamily:"var(--font-mono)"}}>
                        {job.attempts}/{job.maxAttempts} attempts
                      </span>
                    </div>
                    <div style={{fontFamily:"var(--font-mono)",fontSize:11,color:"var(--red)",
                      background:"var(--red)08",border:"1px solid var(--red)1a",borderRadius:4,
                      padding:"6px 9px",marginBottom:5,
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {job.error}
                    </div>
                    <Mono size={10} color="var(--dim)">failed {fmt.time(now - job.failedAt)}</Mono>
                  </div>
                  <div style={{display:"flex",gap:6,flexShrink:0}}>
                    {retried ? (
                      <span style={{fontSize:11,color:"var(--green)",padding:"3px 10px",fontFamily:"var(--font-ui)"}}>↺ Queued</span>
                    ) : (
                      <button onClick={() => setRetriedIds(s => new Set([...s, job.id]))}
                        style={{padding:"3px 10px",borderRadius:4,cursor:"pointer",fontSize:11,
                          background:"var(--cyan)12",border:"1px solid var(--cyan)33",color:"var(--cyan)",
                          fontFamily:"var(--font-ui)",transition:"all 0.1s"}}
                        onMouseEnter={e=>e.currentTarget.style.background="var(--cyan)22"}
                        onMouseLeave={e=>e.currentTarget.style.background="var(--cyan)12"}
                      >↺ Retry</button>
                    )}
                    <button onClick={() => setDlq(q => q.filter(j=>j.id!==job.id))}
                      style={{padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:13,lineHeight:1,
                        background:"transparent",border:"1px solid var(--border)",color:"var(--dim)",
                        fontFamily:"var(--font-ui)",transition:"all 0.1s"}}
                      onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--red)44";e.currentTarget.style.color="var(--red)"}}
                      onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.color="var(--dim)"}}
                    >×</button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  </>)
}

// ── _EventBusTab ──────────────────────────────────────────────────────────────
export const _EventBusTab = ({ emitModalEvent, setEmitModalEvent, setPage }) => {
  const emitModal    = emitModalEvent
  const setEmitModal = setEmitModalEvent
  const [emitPayload,  setEmitPayload]  = useState("{}")
  const [emitResult,   setEmitResult]   = useState(null)
  const [emitting,     setEmitting]     = useState(false)
  const [events,       setEvents]       = useState(EVENT_BUS.events)
  const [expandedHist, setExpandedHist] = useState(new Set())

  const toggleHist = (name) => setExpandedHist(s => {
    const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n
  })

  const pruneOrphans = () => setEvents(evs => evs.filter(e => e.subscribers.length > 0))

  const fireEmit = (event) => {
    setEmitting(true)
    setTimeout(() => {
      setEmitResult({ event: event.name, subscribers: event.subscribers.length, executionIds: event.subscribers.map((_,i) => `exec_emit_${Date.now()}_${i}`) })
      setEmitting(false)
    }, 500)
  }

  const orphanCount = events.filter(e=>e.subscribers.length===0).length

  return (<>
          {emitModal && (
            <div style={{position:"fixed",inset:0,zIndex:200,background:"rgba(8,10,15,0.8)",backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center"}}
              onClick={e=>{if(e.target===e.currentTarget){setEmitModal(null);setEmitResult(null)}}}>
              <div className="page-enter" style={{background:"var(--panel)",border:"1px solid var(--border2)",borderRadius:10,width:480,padding:"26px 28px",boxShadow:"0 24px 64px rgba(0,0,0,0.6)"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
                  <div>
                    <div style={{fontFamily:"var(--font-head)",fontSize:16,fontWeight:700,color:"var(--text)",marginBottom:3}}>Emit Event</div>
                    <Mono size={12} color="var(--purple)">{emitModal.name}</Mono>
                  </div>
                  <button onClick={()=>{setEmitModal(null);setEmitResult(null)}} style={{background:"none",border:"none",color:"var(--muted)",cursor:"pointer",fontSize:20}}>×</button>
                </div>

                {!emitResult ? (<>
                  <div style={{marginBottom:6,fontSize:12,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.07em"}}>Payload (JSON)</div>
                  <textarea value={emitPayload} onChange={e=>setEmitPayload(e.target.value)}
                    style={{width:"100%",height:140,background:"var(--bg)",border:"1px solid var(--border2)",borderRadius:5,
                      padding:"10px 12px",fontFamily:"var(--font-mono)",fontSize:12,color:"var(--text)",
                      outline:"none",resize:"vertical",lineHeight:1.6}}
                    onFocus={e=>e.target.style.borderColor="var(--purple)"}
                    onBlur={e=>e.target.style.borderColor="var(--border2)"}
                  />
                  <div style={{fontSize:12,color:"var(--muted)",margin:"8px 0 16px"}}>
                    Will fan-out to <strong style={{color:"var(--text)"}}>{emitModal.subscribers.length}</strong> subscriber{emitModal.subscribers.length!==1?"s":""}.
                  </div>
                  <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
                    <Btn variant="ghost" onClick={()=>{setEmitModal(null);setEmitResult(null)}}>Cancel</Btn>
                    <Btn variant="primary" onClick={()=>fireEmit(emitModal)}>{emitting?"Emitting…":"⚡ Emit"}</Btn>
                  </div>
                </>) : (
                  <div>
                    <div style={{background:"var(--green)0d",border:"1px solid var(--green)33",borderRadius:6,padding:"14px 16px",marginBottom:16}}>
                      <div style={{fontSize:13,color:"var(--green)",fontWeight:600,marginBottom:8}}>✓ Event emitted</div>
                      <div style={{display:"flex",gap:20,fontSize:12,color:"var(--muted)"}}>
                        <span>Subscribers triggered: <strong style={{color:"var(--text)"}}>{emitResult.subscribers}</strong></span>
                      </div>
                    </div>
                    <div style={{fontSize:12,color:"var(--muted)",marginBottom:8}}>Execution IDs</div>
                    {emitResult.executionIds.map(id => (
                      <div key={id} style={{fontFamily:"var(--font-mono)",fontSize:12,color:"var(--cyan)",marginBottom:3}}>{id}</div>
                    ))}
                    <div style={{display:"flex",justifyContent:"flex-end",marginTop:16}}>
                      <Btn variant="ghost" onClick={()=>{setEmitModal(null);setEmitResult(null)}}>Close</Btn>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Stats */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12, marginBottom:16 }}>
            <Stat label="Registered Events"   value={events.length} accent="var(--purple)" />
            <Stat label="Total Subscribers"   value={events.reduce((s,e)=>s+e.subscribers.length,0)} />
            <Stat label="Orphaned Events"     value={orphanCount}
              accent={orphanCount > 0 ? "var(--amber)" : "var(--green)"}
              sub="events with no listeners" />
          </div>

          {/* Prune orphans banner */}
          {orphanCount > 0 && (
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
              padding:"10px 14px",marginBottom:16,
              background:"var(--amber)0a",border:"1px solid var(--amber)33",borderRadius:7}}>
              <span style={{fontSize:12,color:"var(--amber)"}}>
                ⚠ {orphanCount} event{orphanCount!==1?"s":""} with no subscribers — these fire but nothing listens
              </span>
              <button onClick={pruneOrphans}
                style={{padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:11,
                  background:"var(--amber)18",border:"1px solid var(--amber)44",color:"var(--amber)",
                  fontFamily:"var(--font-ui)",transition:"all 0.1s"}}
                onMouseEnter={e=>e.currentTarget.style.background="var(--amber)28"}
                onMouseLeave={e=>e.currentTarget.style.background="var(--amber)18"}
              >Prune orphans</button>
            </div>
          )}

          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {events.map(event => {
              const histOpen = expandedHist.has(event.name)
              return (
                <Card key={event.name} style={{ borderLeft: event.subscribers.length===0 ? "2px solid var(--amber)" : "2px solid var(--purple)", padding:0, overflow:"hidden" }}>
                  <div style={{padding:"14px 16px"}}>
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between"}}>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                          <span style={{fontFamily:"var(--font-mono)",fontSize:14,color:"var(--purple)",fontWeight:500}}>{event.name}</span>
                          {event.subscribers.length===0 && (
                            <span style={{fontSize:10,fontFamily:"var(--font-mono)",color:"var(--amber)",background:"var(--amber)18",border:"1px solid var(--amber)33",padding:"1px 5px",borderRadius:2}}>NO SUBSCRIBERS</span>
                          )}
                        </div>

                        {/* Schema fields */}
                        <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:10}}>
                          {Object.entries(event.schema.properties ?? {}).map(([k,v]) => (
                            <span key={k} style={{fontFamily:"var(--font-mono)",fontSize:10,
                              color: event.schema.required?.includes(k) ? "var(--cyan)" : "var(--muted)",
                              background: event.schema.required?.includes(k) ? "var(--cyan)14" : "var(--border)",
                              border:`1px solid ${event.schema.required?.includes(k)?"var(--cyan)33":"transparent"}`,
                              padding:"1px 6px",borderRadius:3}}>
                              {k}: {v.type}{event.schema.required?.includes(k) ? "" : "?"}
                            </span>
                          ))}
                        </div>

                        {/* Subscribers with cross-link */}
                        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                          <span style={{fontSize:11,color:"var(--muted)"}}>Subscribers:</span>
                          {event.subscribers.length === 0
                            ? <span style={{fontSize:11,color:"var(--dim)"}}>none</span>
                            : event.subscribers.map(s => (
                                <button key={s.flowId}
                                  onClick={() => setPage && setPage("Flows")}
                                  style={{fontSize:11,fontFamily:"var(--font-mono)",cursor:"pointer",
                                    color:"var(--text)",background:"var(--surface)",border:"1px solid var(--border)",
                                    padding:"1px 7px",borderRadius:3,transition:"all 0.1s"}}
                                  onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--cyan)44";e.currentTarget.style.color="var(--cyan)"}}
                                  onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border)";e.currentTarget.style.color="var(--text)"}}
                                >
                                  {FLOWS.find(f=>f.id===s.flowId)?.name ?? s.flowId}
                                  <span style={{color:"var(--muted)",marginLeft:4}}>v{s.version} ↗</span>
                                </button>
                              ))
                          }
                        </div>
                      </div>

                      <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8,flexShrink:0,marginLeft:16}}>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:11,color:"var(--muted)",marginBottom:2}}>Emit count</div>
                          <Mono size={13}>{event.emitCount.toLocaleString()}</Mono>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:11,color:"var(--muted)",marginBottom:2}}>Last emitted</div>
                          <Mono size={11} color="var(--muted)">{fmt.time(now - event.lastEmittedAt)}</Mono>
                        </div>
                        <div style={{display:"flex",gap:6}}>
                          <button onClick={() => toggleHist(event.name)}
                            style={{padding:"3px 9px",borderRadius:4,cursor:"pointer",fontSize:11,
                              background: histOpen ? "var(--purple)18" : "var(--surface)",
                              border:`1px solid ${histOpen ? "var(--purple)44" : "var(--border)"}`,
                              color: histOpen ? "var(--purple)" : "var(--muted)",
                              fontFamily:"var(--font-ui)",transition:"all 0.1s"}}>
                            {histOpen ? "▴ history" : "▾ history"}
                          </button>
                          <Btn small variant="default" onClick={()=>{setEmitPayload(JSON.stringify(Object.fromEntries(Object.keys(event.schema.properties??{}).map(k=>[k,""])),null,2));setEmitModal(event)}}>
                            ⚡ Emit
                          </Btn>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Emission history drawer */}
                  {histOpen && (
                    <div style={{borderTop:"1px solid var(--border)",background:"var(--bg)",padding:"10px 16px"}}>
                      <div style={{fontSize:11,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>
                        Recent emissions
                      </div>
                      {(event.recentEmissions ?? []).length === 0 ? (
                        <div style={{fontSize:12,color:"var(--dim)",padding:"6px 0"}}>No emissions recorded</div>
                      ) : (
                        <div style={{display:"flex",flexDirection:"column",gap:4}}>
                          {event.recentEmissions.map((em, i) => (
                            <div key={i} style={{display:"flex",alignItems:"center",gap:12,
                              padding:"6px 10px",borderRadius:5,background:"var(--panel)",border:"1px solid var(--border)"}}>
                              <Mono size={10} color="var(--muted)" style={{flexShrink:0}}>{fmt.time(now - em.at)}</Mono>
                              <span style={{fontFamily:"var(--font-mono)",fontSize:11,color:"var(--dim)",
                                flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                                {em.payloadSummary}
                              </span>
                              {em.executionIds.length > 0 ? (
                                <button onClick={() => setPage && setPage("Executions")}
                                  style={{fontSize:10,fontFamily:"var(--font-mono)",cursor:"pointer",
                                    color:"var(--cyan)",background:"var(--cyan)0a",border:"1px solid var(--cyan)22",
                                    padding:"1px 6px",borderRadius:3,flexShrink:0,transition:"all 0.1s",whiteSpace:"nowrap"}}
                                  onMouseEnter={e=>e.currentTarget.style.background="var(--cyan)18"}
                                  onMouseLeave={e=>e.currentTarget.style.background="var(--cyan)0a"}
                                >{em.executionIds.length} exec →</button>
                              ) : (
                                <span style={{fontSize:10,fontFamily:"var(--font-mono)",color:"var(--dim)"}}>no listeners</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              )
            })}
          </div>
        </>)
}


// ─── SETTINGS PAGE ──────────────────────────────────────────────────────────
export const WorkspaceCard = ({ ws, members, isOnlyWorkspace, onEdit, onDelete, onManageMembers }) => {
  const wsMembers = members.filter(m => ws.memberIds.includes(m.id))
  return (
    <div style={{
      background:"var(--surface)", border:"1px solid var(--border)",
      borderRadius:8, padding:"16px 18px",
      borderLeft:`3px solid ${ws.color}`,
      transition:"border-color 0.12s",
    }}
    onMouseEnter={e=>e.currentTarget.style.borderColor="var(--border2)"}
    onMouseLeave={e=>e.currentTarget.style.borderColor="var(--border)"}
    >
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:10, height:10, borderRadius:"50%", background:ws.color, flexShrink:0 }} />
          <div>
            <div style={{ fontSize:14, fontWeight:600, color:"var(--text)", marginBottom:2 }}>{ws.name}</div>
            {ws.description && <div style={{ fontSize:12, color:"var(--muted)" }}>{ws.description}</div>}
          </div>
        </div>
        <div style={{ display:"flex", gap:5 }}>
          <Btn small variant="ghost" onClick={() => onManageMembers(ws)}>Members</Btn>
          <Btn small variant="ghost" onClick={() => onEdit(ws)}>Edit</Btn>
          {!isOnlyWorkspace && (
            <Btn small variant="danger" onClick={() => onDelete(ws.id)}>Delete</Btn>
          )}
        </div>
      </div>
      <div style={{ display:"flex", gap:20, alignItems:"center" }}>
        <div>
          <div style={{ fontSize:11, color:"var(--muted)", marginBottom:2 }}>Flows</div>
          {ws.flowCount > 0
            ? <Mono size={13}>{ws.flowCount}</Mono>
            : <span style={{ fontSize:12, color:"var(--dim)", fontFamily:"var(--font-ui)", fontStyle:"italic" }}>none yet</span>
          }
        </div>
        <div>
          <div style={{ fontSize:11, color:"var(--muted)", marginBottom:2 }}>Members</div>
          <div style={{ display:"flex", gap:-4 }}>
            {wsMembers.slice(0,5).map(m => (
              <div key={m.id} title={m.name} style={{
                width:22, height:22, borderRadius:"50%",
                background:"var(--border2)", border:"1px solid var(--surface)",
                display:"flex", alignItems:"center", justifyContent:"center",
                fontFamily:"var(--font-mono)", fontSize:10, color:"var(--text)",
                marginLeft:-4,
              }}>{m.name.charAt(0)}</div>
            ))}
            {wsMembers.length > 5 && (
              <div style={{
                width:22, height:22, borderRadius:"50%",
                background:"var(--border)", border:"1px solid var(--surface)",
                display:"flex", alignItems:"center", justifyContent:"center",
                fontFamily:"var(--font-mono)", fontSize:10, color:"var(--muted)",
                marginLeft:-4,
              }}>+{wsMembers.length-5}</div>
            )}
          </div>
        </div>
        <div style={{ marginLeft:"auto" }}>
          <Mono color="var(--muted)" size={10}>{ws.id}</Mono>
        </div>
      </div>
    </div>
  )
}

// ── Workspace modal (create / edit) ──────────────────────────────────────
export const WorkspaceModal = ({ workspace, allMembers, onClose, onSave }) => {
  const isEdit = !!workspace
  const COLORS = ["#00d4ff","#a78bfa","#00e599","#ffaa00","#ff4757","#fb923c","#f472b6","#60a5fa"]
  const [form, setForm] = useState(workspace ? {
    name: workspace.name, description: workspace.description ?? "", color: workspace.color,
    memberIds: [...workspace.memberIds],
  } : { name:"", description:"", color:COLORS[0], memberIds:[] })

  const set = (k,v) => setForm(f=>({...f,[k]:v}))
  const toggleMember = (id) => set("memberIds", form.memberIds.includes(id)
    ? form.memberIds.filter(x=>x!==id) : [...form.memberIds, id])

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:200,
      background:"rgba(8,10,15,0.8)", backdropFilter:"blur(4px)",
      display:"flex", alignItems:"center", justifyContent:"center",
    }} onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="page-enter" style={{
        background:"var(--panel)", border:"1px solid var(--border2)",
        borderRadius:10, width:480, padding:"26px 28px",
        boxShadow:"0 24px 64px rgba(0,0,0,0.6)",
      }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <span style={{ fontFamily:"var(--font-head)", fontSize:16, fontWeight:700, color:"var(--text)" }}>
            {isEdit ? "Edit Workspace" : "New Workspace"}
          </span>
          <button onClick={onClose} style={{ background:"none",border:"none",color:"var(--muted)",cursor:"pointer",fontSize:20 }}>×</button>
        </div>

        <InputField label="Workspace Name" value={form.name} onChange={v=>set("name",v)} placeholder="e.g. Data Engineering" />
        <InputField label="Description" value={form.description} onChange={v=>set("description",v)} placeholder="What runs here?" />

        <div style={{ marginBottom:16 }}>
          <label style={{ display:"block", fontSize:12, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8 }}>Color</label>
          <div style={{ display:"flex", gap:8 }}>
            {COLORS.map(c => (
              <div key={c} onClick={()=>set("color",c)} style={{
                width:22, height:22, borderRadius:"50%", background:c, cursor:"pointer",
                border:`2px solid ${form.color===c?"#fff":"transparent"}`,
                boxShadow: form.color===c ? `0 0 0 2px ${c}66` : "none",
              }} />
            ))}
          </div>
        </div>

        <div style={{ marginBottom:20 }}>
          <label style={{ display:"block", fontSize:12, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8 }}>
            Members Access
          </label>
          <div style={{ display:"flex", flexDirection:"column", gap:6, maxHeight:180, overflowY:"auto" }}>
            {allMembers.map(m => {
              const checked = form.memberIds.includes(m.id)
              const isOwner = m.role === "owner"
              return (
                <div key={m.id} onClick={()=>{ if(!isOwner) toggleMember(m.id) }} style={{
                  display:"flex", alignItems:"center", gap:10,
                  padding:"7px 10px", borderRadius:6,
                  background: checked ? "var(--cyan)0a" : "var(--surface)",
                  border:`1px solid ${checked?"var(--cyan)33":"var(--border)"}`,
                  cursor: isOwner ? "default" : "pointer",
                  transition:"all 0.1s",
                }}>
                  <Avatar name={m.name} size={26} color={ROLE_COLORS[m.role] ?? "var(--muted)"} />
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, color:"var(--text)" }}>{m.name}</div>
                    <Mono color="var(--muted)" size={10}>{m.email}</Mono>
                  </div>
                  {isOwner
                    ? <span style={{ fontSize:10, color:"var(--amber)", fontFamily:"var(--font-mono)" }}>always</span>
                    : <div style={{
                        width:14, height:14, borderRadius:3, flexShrink:0,
                        background: checked ? "var(--cyan)" : "var(--surface)",
                        border:`1px solid ${checked?"var(--cyan)":"var(--border2)"}`,
                        display:"flex", alignItems:"center", justifyContent:"center",
                      }}>
                        {checked && <span style={{ fontSize:10, color:"#000" }}>✓</span>}
                      </div>
                  }
                </div>
              )
            })}
          </div>
        </div>

        <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={()=>onSave(form)}>{isEdit?"Save Changes":"Create Workspace"}</Btn>
        </div>
      </div>
    </div>
  )
}

// ── Invite member modal ───────────────────────────────────────────────────
export const InviteModal = ({ onClose, onInvite, existingEmails }) => {
  const [email, setEmail] = useState("")
  const [role,  setRole]  = useState("member")
  const [error, setError] = useState("")

  const handle = () => {
    if (!email.includes("@")) return setError("Enter a valid email address.")
    if (existingEmails.includes(email.toLowerCase())) return setError("This email is already a member.")
    onInvite({ email: email.toLowerCase(), role })
  }

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:200,
      background:"rgba(8,10,15,0.8)", backdropFilter:"blur(4px)",
      display:"flex", alignItems:"center", justifyContent:"center",
    }} onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="page-enter" style={{
        background:"var(--panel)", border:"1px solid var(--border2)",
        borderRadius:10, width:400, padding:"26px 28px",
      }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <span style={{ fontFamily:"var(--font-head)", fontSize:16, fontWeight:700, color:"var(--text)" }}>Invite Member</span>
          <button onClick={onClose} style={{ background:"none",border:"none",color:"var(--muted)",cursor:"pointer",fontSize:20 }}>×</button>
        </div>
        <InputField label="Email" value={email} onChange={v=>{setEmail(v);setError("")}} placeholder="colleague@company.com" type="email" />
        {error && <div style={{ fontSize:12, color:"var(--red)", marginTop:-8, marginBottom:12 }}>{error}</div>}
        <div style={{ marginBottom:20 }}>
          <label style={{ display:"block", fontSize:12, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8 }}>Role</label>
          <div style={{ display:"flex", gap:8 }}>
            {["member","admin"].map(r => (
              <button key={r} onClick={()=>setRole(r)} style={{
                flex:1, padding:"8px 0", borderRadius:5, cursor:"pointer",
                border:`1px solid ${role===r?ROLE_COLORS[r]:"var(--border)"}`,
                background: role===r ? `${ROLE_COLORS[r]}18` : "var(--surface)",
                color: role===r ? ROLE_COLORS[r] : "var(--muted)",
                fontSize:13, fontFamily:"var(--font-ui)",
              }}>{r.charAt(0).toUpperCase()+r.slice(1)}</button>
            ))}
          </div>
          <div style={{ fontSize:12, color:"var(--muted)", marginTop:6 }}>
            {role === "admin" ? "Can manage flows, members, and workspaces. Cannot delete the account." : "Can view and run flows in workspaces they are assigned to."}
          </div>
        </div>
        <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={handle}>Send Invite</Btn>
        </div>
      </div>
    </div>
  )
}

// ── Credential Modal ─────────────────────────────────────────────────────
export const CredentialModal = ({ credential, workspaces, onClose, onSave }) => {
  const isEdit  = !!credential
  const [type,     setType]     = useState(credential?.type ?? "http")
  const [name,     setName]     = useState(credential?.name ?? "")
  const [wsId,     setWsId]     = useState(credential?.workspaceId ?? workspaces[0]?.id ?? "")
  const [fields,   setFields]   = useState(credential?.fields ?? {})
  const [revealed, setRevealed] = useState({})    // { fieldKey: true } to show plaintext
  const [testing,  setTesting]  = useState(false)
  const [testRes,  setTestRes]  = useState(null)  // null | { ok, msg }
  const meta = CRED_TYPE_META[type] ?? CRED_TYPE_META.secret

  const setField = (k, v) => setFields(f => ({...f, [k]:v}))
  const toggleReveal = (k) => setRevealed(r => ({...r, [k]:!r[k]}))

  const handleTypeChange = (t) => { setType(t); setFields({}); setTestRes(null) }

  const valid = name.trim().length > 0 &&
    meta.fields.filter(f => !f.hint?.includes("Optional")).every(f =>
      !f.secret || (fields[f.key]?.length ?? 0) > 0 || isEdit
    )

  const testConnection = async () => {
    setTesting(true); setTestRes(null)
    await new Promise(r => setTimeout(r, 900 + Math.random()*600))
    // Mock: fail if any required secret field is empty and not in edit mode
    const missingSecrets = meta.fields.filter(f => f.secret && !fields[f.key] && !isEdit)
    setTestRes(missingSecrets.length ? { ok:false, msg:"Missing required secret fields." } : { ok:true, msg:"Connection successful — credentials verified." })
    setTesting(false)
  }

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:200,
      background:"rgba(8,10,15,0.82)", backdropFilter:"blur(4px)",
      display:"flex", alignItems:"center", justifyContent:"center",
    }} onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="page-enter" style={{
        background:"var(--panel)", border:"1px solid var(--border2)",
        borderRadius:10, width:500, maxHeight:"90vh", overflow:"hidden",
        display:"flex", flexDirection:"column",
        boxShadow:"0 24px 64px rgba(0,0,0,0.65)",
      }}>
        {/* Header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"22px 26px 16px", flexShrink:0 }}>
          <div>
            <span style={{ fontFamily:"var(--font-head)", fontSize:16, fontWeight:700, color:"var(--text)" }}>
              {isEdit ? "Edit Credential" : "New Credential"}
            </span>
            {meta.hint && <div style={{ fontSize:12, color:"var(--muted)", marginTop:3, fontFamily:"var(--font-ui)" }}>{meta.hint}</div>}
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"var(--muted)", cursor:"pointer", fontSize:20, lineHeight:1 }}>×</button>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"0 26px 22px" }}>
          {/* Type picker */}
          <div style={{ marginBottom:16 }}>
            <label style={{ display:"block", fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8, fontFamily:"var(--font-ui)" }}>Type</label>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:5 }}>
              {Object.entries(CRED_TYPE_META).map(([k, m]) => (
                <button key={k} onClick={() => !isEdit && handleTypeChange(k)} title={m.hint} style={{
                  padding:"8px 10px", borderRadius:6, cursor: isEdit ? "default" : "pointer",
                  border:`1px solid ${type===k ? m.color : "var(--border)"}`,
                  background: type===k ? `${m.color}14` : "var(--surface)",
                  display:"flex", alignItems:"center", gap:7,
                  opacity: isEdit && type!==k ? 0.35 : 1, transition:"all 0.1s",
                }}>
                  <span style={{ fontFamily:"var(--font-mono)", fontSize:14, color: m.color, flexShrink:0 }}>{m.icon}</span>
                  <span style={{ fontSize:11, color: type===k ? "var(--text)" : "var(--muted)", fontWeight:500, fontFamily:"var(--font-ui)", textAlign:"left", lineHeight:1.2 }}>{m.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Name + Workspace row */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:16 }}>
            <div>
              <label style={{ display:"block", fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:5, fontFamily:"var(--font-ui)" }}>Name <span style={{ color:"var(--amber)" }}>*</span></label>
              <input value={name} onChange={e=>setName(e.target.value)} placeholder="OpenAI Production"
                style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5, padding:"7px 10px", fontSize:13, color:"var(--text)", outline:"none", fontFamily:"var(--font-ui)", boxSizing:"border-box" }}
                onFocus={e=>e.target.style.borderColor="var(--cyan)"} onBlur={e=>e.target.style.borderColor="var(--border2)"} />
            </div>
            <div>
              <label style={{ display:"block", fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:5, fontFamily:"var(--font-ui)" }}>Workspace</label>
              <select value={wsId} onChange={e=>setWsId(e.target.value)} style={{
                width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:5,
                padding:"7px 10px", fontSize:12, color:"var(--text)", outline:"none", fontFamily:"var(--font-ui)", cursor:"pointer",
              }}>
                {workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}
              </select>
            </div>
          </div>

          {/* Type-specific fields */}
          <div style={{ borderTop:"1px solid var(--border)", paddingTop:14, marginBottom:14 }}>
            {meta.fields.map(f => (
              <div key={f.key} style={{ marginBottom:12 }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
                  <label style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase", letterSpacing:"0.07em", fontFamily:"var(--font-ui)" }}>{f.label}</label>
                  {f.hint && <span style={{ fontSize:10, color:"var(--dim)", fontFamily:"var(--font-ui)", maxWidth:200, textAlign:"right" }}>{f.hint}</span>}
                </div>
                <div style={{ position:"relative" }}>
                  <input
                    type={f.secret && !revealed[f.key] ? "password" : "text"}
                    value={fields[f.key] ?? ""}
                    onChange={e=>setField(f.key, e.target.value)}
                    placeholder={isEdit && f.secret ? "leave blank to keep existing value" : (f.placeholder ?? "")}
                    style={{
                      width:"100%", background:"var(--bg)", border:"1px solid var(--border2)",
                      borderRadius:5, padding:`7px ${f.secret ? "64px" : "10px"} 7px 10px`,
                      fontSize:13, color:"var(--text)", outline:"none", fontFamily:"var(--font-mono)", boxSizing:"border-box",
                    }}
                    onFocus={e=>e.target.style.borderColor="var(--cyan)"}
                    onBlur={e=>e.target.style.borderColor="var(--border2)"}
                  />
                  {f.secret && (
                    <div style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", display:"flex", alignItems:"center", gap:5 }}>
                      <button onClick={()=>toggleReveal(f.key)} title={revealed[f.key]?"Hide":"Show"}
                        style={{ background:"none", border:"none", cursor:"pointer", fontSize:14, color:"var(--muted)", padding:0, lineHeight:1 }}>
                        {revealed[f.key] ? "◑" : "◐"}
                      </button>
                      <span style={{ fontSize:12, color:"var(--muted)" }}>🔒</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Test connection */}
          <div style={{ marginBottom:14 }}>
            <button onClick={testConnection} disabled={testing}
              style={{ padding:"6px 14px", borderRadius:5, cursor:testing?"default":"pointer", fontSize:12, fontFamily:"var(--font-ui)", fontWeight:500,
                background:"var(--surface)", border:"1px solid var(--border2)", color:"var(--muted)", transition:"all 0.1s",
              }}
              onMouseEnter={e=>{if(!testing){e.currentTarget.style.borderColor="var(--cyan)55";e.currentTarget.style.color="var(--cyan)"}}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--border2)";e.currentTarget.style.color="var(--muted)"}}>
              {testing ? "⟳ Testing…" : "⇄ Test Connection"}
            </button>
            {testRes && (
              <span style={{ marginLeft:10, fontSize:12, fontFamily:"var(--font-ui)", color:testRes.ok?"var(--green)":"var(--red)" }}>
                {testRes.ok ? "✓" : "✗"} {testRes.msg}
              </span>
            )}
          </div>

          {/* Security note */}
          <div style={{ background:"var(--amber)08", border:"1px solid var(--amber)22", borderRadius:5, padding:"8px 12px", fontSize:12, color:"var(--amber)", lineHeight:1.6 }}>
            🔒 Secret fields are AES-256 encrypted at rest. They never appear in execution logs, API responses, or exports.
          </div>
        </div>

        {/* Footer */}
        <div style={{ display:"flex", justifyContent:"flex-end", gap:8, padding:"14px 26px", borderTop:"1px solid var(--border)", flexShrink:0 }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={() => valid && onSave({ type, name:name.trim(), workspaceId:wsId, fields })}>
            {isEdit ? "Save Changes" : "Create Credential"}
          </Btn>
        </div>
      </div>
    </div>
  )
}

// ── Main Settings Page ────────────────────────────────────────────────────
// ─── PROFILE PAGE ────────────────────────────────────────────────────────────
export const ProfilePage = ({ session }) => {
  const [activeSection, setSection] = useState("profile")

  // ── Profile form ──────────────────────────────────────────────────────────
  const [profile, setProfile] = useState({
    name:      session.name,
    email:     session.email,
    handle:    "kobami",
    timezone:  "America/New_York",
    language:  "en",
    bio:       "Building Orion — the SQLite of automation engines.",
    avatarColor: "cyan",
  })
  const [profileFlash,  setProfileFlash]  = useState(false)

  // ── Preferences ──────────────────────────────────────────────────────────
  const [prefs, setPrefs] = useState({
    theme:               "dark",
    editorViewMode:      "dag",
    autoSave:            true,
    autoSaveInterval:    30,
    showNodePreview:      true,
    showMinimap:          true,
    showExecutionToasts:  true,
    compactFlowList:      false,
    defaultEdgeKind:      "success",
    confirmOnDelete:      true,
    keyboardShortcuts:    true,
    reducedMotion:        false,
    dateFormat:           "relative",
    numberFormat:         "en-US",
  })
  const [prefsFlash, setPrefsFlash] = useState(false)
  const setPref = (k, v) => setPrefs(p => ({...p, [k]:v}))

  // ── Notification preferences ──────────────────────────────────────────────
  const [notifs, setNotifs] = useState({
    executionFailed:   true,
    executionSuccess:  false,
    flowDisabled:      true,
    credentialExpiring:true,
    weeklyDigest:      true,
    productUpdates:    false,
    channels: { email:true, inApp:true, slack:false },
  })
  const [notifsFlash, setNotifsFlash] = useState(false)

  // ── Sessions (mock) ───────────────────────────────────────────────────────
  const [sessions] = useState([
    { id:"s1", device:"Chrome on macOS",     location:"New York, US",    ip:"73.42.11.8",    lastActive: Date.now()-60000,        current:true  },
    { id:"s2", device:"Safari on iPhone 15", location:"New York, US",    ip:"73.42.11.8",    lastActive: Date.now()-3600000*2,    current:false },
    { id:"s3", device:"Firefox on Ubuntu",   location:"Amsterdam, NL",   ip:"145.22.34.102", lastActive: Date.now()-86400000*3,   current:false },
  ])
  const [revokedSessions, setRevoked] = useState(new Set())

  // ── Password ──────────────────────────────────────────────────────────────
  const [pwForm, setPwForm]   = useState({ current:"", next:"", confirm:"" })
  const [pwFlash, setPwFlash] = useState(null)   // null | "success" | "error"

  // ── Connected accounts ────────────────────────────────────────────────────
  const [connected, setConnected] = useState({
    github:  { connected:true,  username:"kobami-dev", connectedAt: Date.now()-86400000*30  },
    google:  { connected:true,  username:"kobami@gmail.com", connectedAt: Date.now()-86400000*90 },
    slack:   { connected:false, username:null,         connectedAt: null },
    linear:  { connected:false, username:null,         connectedAt: null },
  })

  const flash = (set) => { set(true); setTimeout(()=>set(false), 2200) }

  const SECTIONS = [
    { id:"profile",    label:"Profile",            icon:"◎" },
    { id:"prefs",      label:"Preferences",        icon:"⚙" },
    { id:"notifs",     label:"Notifications",      icon:"◉" },
    { id:"security",   label:"Security",           icon:"⟨⟩" },
    { id:"sessions",   label:"Active Sessions",    icon:"⊡" },
    { id:"connected",  label:"Connected Accounts", icon:"⬡" },
    { id:"danger",     label:"Danger Zone",        icon:"⚠" },
  ]

  const TIMEZONES = ["America/New_York","America/Chicago","America/Denver","America/Los_Angeles","America/Sao_Paulo","Europe/London","Europe/Paris","Europe/Berlin","Europe/Amsterdam","Asia/Dubai","Asia/Kolkata","Asia/Singapore","Asia/Tokyo","Australia/Sydney","Pacific/Auckland"]
  const LANGUAGES = [["en","English"],["es","Español"],["fr","Français"],["de","Deutsch"],["ja","日本語"],["zh","中文"],["pt","Português"]]

  const FieldLabel = ({ children }) => (
    <div style={{ fontSize:12, color:"var(--muted)", marginBottom:5, fontFamily:"var(--font-ui)", fontWeight:500 }}>{children}</div>
  )
  const Field = ({ children }) => (
    <div style={{ marginBottom:18 }}>{children}</div>
  )
  const Input = ({ value, onChange, placeholder, type="text", disabled }) => (
    <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} disabled={disabled}
      style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:6,
        padding:"8px 12px", fontSize:13, color: disabled ? "var(--muted)" : "var(--text)", outline:"none",
        fontFamily:"var(--font-ui)", opacity: disabled ? 0.7 : 1,
      }}
      onFocus={e=>{ if(!disabled) e.target.style.borderColor="var(--cyan)" }}
      onBlur={e=>e.target.style.borderColor="var(--border2)"}
    />
  )
  const Select = ({ value, onChange, options }) => (
    <select value={value} onChange={e=>onChange(e.target.value)}
      style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:6,
        padding:"8px 12px", fontSize:13, color:"var(--text)", outline:"none",
        fontFamily:"var(--font-ui)", appearance:"none", cursor:"pointer",
      }}>
      {options.map(([v,l])=>(<option key={v} value={v}>{l}</option>))}
    </select>
  )
  const SaveBtn = ({ onClick, flash, label="Save changes" }) => (
    <Btn variant="primary" onClick={onClick} style={{ minWidth:130, position:"relative" }}>
      {flash ? "✓ Saved" : label}
    </Btn>
  )
  const RadioGroup = ({ value, onChange, options }) => (
    <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
      {options.map(([v,l]) => (
        <button key={v} onClick={() => onChange(v)} style={{
          padding:"5px 14px", borderRadius:6, cursor:"pointer",
          fontSize:12, fontFamily:"var(--font-ui)",
          background: value===v ? "var(--cyan)18" : "transparent",
          border:`1px solid ${value===v ? "var(--cyan)" : "var(--border2)"}`,
          color: value===v ? "var(--cyan)" : "var(--muted)",
          transition:"all 0.1s",
        }}>{l}</button>
      ))}
    </div>
  )

  return (
    <div style={{ display:"flex", minHeight:"100%" }}>

      {/* Sidebar */}
      <div style={{ width:200, borderRight:"1px solid var(--border)", padding:"28px 0", flexShrink:0, background:"var(--surface)" }}>
        {/* Avatar block */}
        <div style={{ padding:"0 20px 24px", borderBottom:"1px solid var(--border)", marginBottom:12 }}>
          <div style={{
            width:56, height:56, borderRadius:"50%", marginBottom:12,
            background:"var(--cyan)22", border:"2px solid var(--cyan)44",
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:24, fontFamily:"var(--font-mono)", color:"var(--cyan)",
          }}>{session.name.charAt(0)}</div>
          <div style={{ fontSize:14, fontWeight:700, color:"var(--text)", fontFamily:"var(--font-head)" }}>{session.name}</div>
          <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-mono)", marginTop:2 }}>@{profile.handle}</div>
          {session.isSuperAdmin && (
            <div style={{ display:"inline-flex", alignItems:"center", gap:4, marginTop:6,
              padding:"1px 7px", borderRadius:3, background:"var(--red)18",
              border:"1px solid var(--red)44", fontSize:10, color:"var(--red)", fontFamily:"var(--font-mono)" }}>
              ⊠ Super Admin
            </div>
          )}
        </div>

        {SECTIONS.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)} style={{
            width:"100%", textAlign:"left", padding:"9px 20px", background:"none",
            border:"none", cursor:"pointer", display:"flex", alignItems:"center", gap:10,
            borderLeft: activeSection===s.id ? "2px solid var(--cyan)" : "2px solid transparent",
            background: activeSection===s.id ? "var(--cyan)0d" : "transparent",
            transition:"all 0.1s",
          }}>
            <span style={{ fontSize:12, color: activeSection===s.id ? "var(--cyan)" : "var(--dim)", width:14 }}>{s.icon}</span>
            <span style={{ fontSize:13, fontFamily:"var(--font-ui)", fontWeight: activeSection===s.id ? 600 : 400,
              color: activeSection===s.id ? "var(--cyan)" : s.id==="danger" ? "var(--red)" : "var(--muted)" }}>
              {s.label}
            </span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex:1, padding:"36px 48px", maxWidth:680, overflow:"auto" }}>

        {/* ── PROFILE ── */}
        {activeSection === "profile" && (
          <div>
            <SectionHeader title="Profile" subtitle="Your public identity on Orion" />
            <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:10, padding:28, marginBottom:24 }}>

              {/* Avatar */}
              <div style={{ display:"flex", alignItems:"center", gap:20, marginBottom:28, paddingBottom:24, borderBottom:"1px solid var(--border)" }}>
                <div style={{ position:"relative" }}>
                  <div style={{
                    width:72, height:72, borderRadius:"50%",
                    background:"var(--cyan)22", border:"2px solid var(--cyan)44",
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:32, fontFamily:"var(--font-mono)", color:"var(--cyan)",
                  }}>{session.name.charAt(0)}</div>
                  <div style={{ position:"absolute", bottom:0, right:0, width:22, height:22, borderRadius:"50%",
                    background:"var(--panel)", border:"2px solid var(--border2)",
                    display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer",
                    fontSize:11, color:"var(--muted)" }}
                    onClick={() => toast.info("Avatar upload — coming soon")}
                  >✎</div>
                </div>
                <div>
                  <div style={{ fontSize:15, fontWeight:700, color:"var(--text)", fontFamily:"var(--font-head)" }}>{profile.name}</div>
                  <div style={{ fontSize:12, color:"var(--muted)", fontFamily:"var(--font-mono)", marginTop:2 }}>{profile.email}</div>
                  <button onClick={() => toast.info("Avatar upload — coming soon")}
                    style={{ marginTop:8, fontSize:12, color:"var(--cyan)", background:"none", border:"none", cursor:"pointer", padding:0, fontFamily:"var(--font-ui)" }}>
                    Change photo →
                  </button>
                </div>
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 20px" }}>
                <Field>
                  <FieldLabel>Display name</FieldLabel>
                  <Input value={profile.name} onChange={v=>setProfile(p=>({...p,name:v}))} />
                </Field>
                <Field>
                  <FieldLabel>Handle</FieldLabel>
                  <Input value={profile.handle} onChange={v=>setProfile(p=>({...p,handle:v}))} placeholder="@handle" />
                </Field>
                <Field>
                  <FieldLabel>Email</FieldLabel>
                  <Input value={profile.email} onChange={v=>setProfile(p=>({...p,email:v}))} type="email" />
                </Field>
                <Field>
                  <FieldLabel>Timezone</FieldLabel>
                  <Select value={profile.timezone} onChange={v=>setProfile(p=>({...p,timezone:v}))} options={TIMEZONES.map(tz=>[tz,tz])} />
                </Field>
              </div>

              <Field>
                <FieldLabel>Bio</FieldLabel>
                <textarea value={profile.bio} onChange={e=>setProfile(p=>({...p,bio:e.target.value}))}
                  rows={3} placeholder="A short bio…"
                  style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:6,
                    padding:"8px 12px", fontSize:13, color:"var(--text)", outline:"none",
                    fontFamily:"var(--font-ui)", resize:"vertical", lineHeight:1.5,
                  }}
                  onFocus={e=>e.target.style.borderColor="var(--cyan)"}
                  onBlur={e=>e.target.style.borderColor="var(--border2)"}
                />
              </Field>

              <Field>
                <FieldLabel>Language</FieldLabel>
                <div style={{ maxWidth:220 }}>
                  <Select value={profile.language} onChange={v=>setProfile(p=>({...p,language:v}))} options={LANGUAGES} />
                </div>
              </Field>

              <SaveBtn onClick={() => flash(setProfileFlash)} flash={profileFlash} />
            </div>
          </div>
        )}

        {/* ── PREFERENCES ── */}
        {activeSection === "prefs" && (
          <div>
            <SectionHeader title="Preferences" subtitle="Customize your Orion experience" />

            <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:10, padding:28, marginBottom:20 }}>
              <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:16, fontFamily:"var(--font-ui)" }}>Appearance</div>

              <Field>
                <FieldLabel>Theme</FieldLabel>
                <RadioGroup value={prefs.theme} onChange={v=>setPref("theme",v)}
                  options={[["dark","Dark"],["light","Light"],["system","System"]]} />
              </Field>

              <Field>
                <FieldLabel>Date format</FieldLabel>
                <RadioGroup value={prefs.dateFormat} onChange={v=>setPref("dateFormat",v)}
                  options={[["relative","Relative (2 hrs ago)"],["absolute","Absolute (Mar 11, 2026)"],["iso","ISO 8601"]]} />
              </Field>

              <Field>
                <FieldLabel>Reduce motion</FieldLabel>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <Toggle enabled={prefs.reducedMotion} onChange={v=>setPref("reducedMotion",v)} />
                  <span style={{ fontSize:12, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>Disable animations and transitions</span>
                </div>
              </Field>
            </div>

            <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:10, padding:28, marginBottom:20 }}>
              <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:16, fontFamily:"var(--font-ui)" }}>Flow Editor</div>

              <Field>
                <FieldLabel>Default view mode</FieldLabel>
                <RadioGroup value={prefs.editorViewMode} onChange={v=>setPref("editorViewMode",v)}
                  options={[["dag","DAG"],["linear","Linear"],["json","JSON"]]} />
              </Field>

              <Field>
                <FieldLabel>Default edge kind</FieldLabel>
                <RadioGroup value={prefs.defaultEdgeKind} onChange={v=>setPref("defaultEdgeKind",v)}
                  options={[["success","Success"],["error","Error"],["always","Always"]]} />
              </Field>

              {[
                ["autoSave",           "Auto-save flows",           "Automatically save every " + prefs.autoSaveInterval + "s"],
                ["showNodePreview",    "Show node preview",         "Show data preview inside node cards on the canvas"],
                ["showMinimap",        "Show minimap",              "Show the minimap overview in the DAG editor"],
                ["confirmOnDelete",    "Confirm before delete",     "Show a confirmation prompt when deleting nodes or edges"],
                ["showExecutionToasts","Execution toast alerts",    "Show pop-up notifications for execution events"],
                ["compactFlowList",    "Compact flow list",         "Reduce row height in the Flows table"],
              ].map(([k, label, desc]) => (
                <div key={k} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
                  <div>
                    <div style={{ fontSize:13, color:"var(--text)", fontFamily:"var(--font-ui)", fontWeight:500 }}>{label}</div>
                    <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)", marginTop:2 }}>{desc}</div>
                  </div>
                  <Toggle enabled={prefs[k]} onChange={v=>setPref(k,v)} />
                </div>
              ))}
            </div>

            <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:10, padding:28, marginBottom:24 }}>
              <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:16, fontFamily:"var(--font-ui)" }}>General</div>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:0 }}>
                <div>
                  <div style={{ fontSize:13, color:"var(--text)", fontFamily:"var(--font-ui)", fontWeight:500 }}>Keyboard shortcuts</div>
                  <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)", marginTop:2 }}>Enable ⌘K palette, Delete, ⌘A, ⌘C/V etc.</div>
                </div>
                <Toggle enabled={prefs.keyboardShortcuts} onChange={v=>setPref("keyboardShortcuts",v)} />
              </div>
            </div>

            <SaveBtn onClick={() => flash(setPrefsFlash)} flash={prefsFlash} />
          </div>
        )}

        {/* ── NOTIFICATIONS ── */}
        {activeSection === "notifs" && (
          <div>
            <SectionHeader title="Notifications" subtitle="Control what Orion sends you and how" />
            <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:10, padding:28, marginBottom:20 }}>
              <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:16 }}>Channels</div>
              {[["email","Email","✉","var(--cyan)"],["inApp","In-app","◉","var(--green)"],["slack","Slack","⬡","var(--purple)"]].map(([k,label,icon,color]) => (
                <div key={k} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ fontSize:14, color, width:18 }}>{icon}</span>
                    <span style={{ fontSize:13, color:"var(--text)", fontFamily:"var(--font-ui)", fontWeight:500 }}>{label}</span>
                  </div>
                  <Toggle enabled={notifs.channels[k]} onChange={v=>setNotifs(n=>({...n,channels:{...n.channels,[k]:v}}))} />
                </div>
              ))}
            </div>

            <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:10, padding:28, marginBottom:24 }}>
              <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:16 }}>Events</div>
              {[
                ["executionFailed",    "Execution failed",     "Any flow run ends in a failure or timeout"],
                ["executionSuccess",   "Execution succeeded",  "Each successful run (can be noisy on high-volume flows)"],
                ["flowDisabled",       "Flow auto-disabled",   "A flow is paused after repeated consecutive failures"],
                ["credentialExpiring", "Credential expiring",  "A secret or OAuth token is within 7 days of expiry"],
                ["weeklyDigest",       "Weekly digest",        "Summary of runs, failures, and flow health each Monday"],
                ["productUpdates",     "Product updates",      "New Orion features, changelogs, and announcements"],
              ].map(([k, label, desc]) => (
                <div key={k} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18 }}>
                  <div>
                    <div style={{ fontSize:13, color:"var(--text)", fontWeight:500, fontFamily:"var(--font-ui)" }}>{label}</div>
                    <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)", marginTop:2 }}>{desc}</div>
                  </div>
                  <Toggle enabled={notifs[k]} onChange={v=>setNotifs(n=>({...n,[k]:v}))} />
                </div>
              ))}
            </div>

            <SaveBtn onClick={() => flash(setNotifsFlash)} flash={notifsFlash} />
          </div>
        )}

        {/* ── SECURITY ── */}
        {activeSection === "security" && (
          <div>
            <SectionHeader title="Security" subtitle="Manage your password and login settings" />
            <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:10, padding:28, marginBottom:20 }}>
              <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:20 }}>Change Password</div>

              {pwFlash && (
                <div style={{ marginBottom:16, padding:"10px 14px", borderRadius:6,
                  background: pwFlash==="success" ? "var(--green)18" : "var(--red)18",
                  border:`1px solid ${pwFlash==="success" ? "var(--green)55" : "var(--red)55"}`,
                  fontSize:13, color: pwFlash==="success" ? "var(--green)" : "var(--red)" }}>
                  {pwFlash==="success" ? "✓ Password updated successfully" : "✗ Current password is incorrect"}
                </div>
              )}

              <Field><FieldLabel>Current password</FieldLabel>
                <Input type="password" value={pwForm.current} onChange={v=>setPwForm(p=>({...p,current:v}))} />
              </Field>
              <Field><FieldLabel>New password</FieldLabel>
                <Input type="password" value={pwForm.next} onChange={v=>setPwForm(p=>({...p,next:v}))} />
              </Field>
              <Field><FieldLabel>Confirm new password</FieldLabel>
                <Input type="password" value={pwForm.confirm} onChange={v=>setPwForm(p=>({...p,confirm:v}))} />
              </Field>

              {pwForm.next && (
                <div style={{ marginBottom:16 }}>
                  <div style={{ fontSize:11, color:"var(--muted)", marginBottom:6 }}>Password strength</div>
                  {(() => {
                    const score = [/.{8,}/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(r=>r.test(pwForm.next)).length
                    const colors = ["var(--red)","var(--red)","var(--amber)","var(--amber)","var(--green)"]
                    const labels = ["","Weak","Fair","Good","Strong"]
                    return (
                      <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                        {[0,1,2,3].map(i=>(
                          <div key={i} style={{ height:4, flex:1, borderRadius:2, background: i<score ? colors[score] : "var(--border2)", transition:"background 0.2s" }} />
                        ))}
                        <span style={{ fontSize:11, color:colors[score], marginLeft:6, fontFamily:"var(--font-mono)", minWidth:40 }}>{labels[score]}</span>
                      </div>
                    )
                  })()}
                </div>
              )}

              <Btn variant="primary" onClick={() => {
                if (pwForm.next !== pwForm.confirm) { setPwFlash("error"); setTimeout(()=>setPwFlash(null),3000); return }
                setPwFlash("success"); setPwForm({current:"",next:"",confirm:""}); setTimeout(()=>setPwFlash(null),3000)
              }}>Update password</Btn>
            </div>

            <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:10, padding:28, marginBottom:20 }}>
              <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:16 }}>Two-Factor Authentication</div>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div>
                  <div style={{ fontSize:13, color:"var(--text)", fontWeight:500, fontFamily:"var(--font-ui)" }}>Authenticator app (TOTP)</div>
                  <div style={{ fontSize:11, color:"var(--muted)", marginTop:2 }}>Use an app like 1Password, Authy, or Google Authenticator</div>
                </div>
                <Btn variant="ghost" small onClick={()=>toast.info("2FA setup — coming soon")}>Enable</Btn>
              </div>
            </div>

            <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:10, padding:28 }}>
              <div style={{ fontSize:12, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:16 }}>Login History</div>
              {[
                { event:"Signed in",       ip:"73.42.11.8",    loc:"New York, US",   at: Date.now()-60000 },
                { event:"Signed in",       ip:"73.42.11.8",    loc:"New York, US",   at: Date.now()-86400000*2 },
                { event:"Password changed",ip:"73.42.11.8",    loc:"New York, US",   at: Date.now()-86400000*14 },
                { event:"Signed in",       ip:"145.22.34.102", loc:"Amsterdam, NL",  at: Date.now()-86400000*30 },
              ].map((ev,i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"10px 0", borderBottom: i<3 ? "1px solid var(--border)" : "none" }}>
                  <div>
                    <div style={{ fontSize:13, color:"var(--text)", fontFamily:"var(--font-ui)" }}>{ev.event}</div>
                    <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-mono)", marginTop:2 }}>{ev.ip} · {ev.loc}</div>
                  </div>
                  <Mono size={11} color="var(--dim)">{fmt.time(Date.now()-ev.at)}</Mono>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── SESSIONS ── */}
        {activeSection === "sessions" && (
          <div>
            <SectionHeader title="Active Sessions" subtitle="Devices and browsers currently signed into your account" />
            <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:10, overflow:"hidden", marginBottom:16 }}>
              {sessions.map((s,i) => (
                <div key={s.id} style={{ display:"flex", alignItems:"center", gap:16, padding:"16px 24px",
                  borderBottom: i<sessions.length-1 ? "1px solid var(--border)" : "none",
                  opacity: revokedSessions.has(s.id) ? 0.4 : 1, transition:"opacity 0.2s" }}>
                  <div style={{ fontSize:24, color:"var(--dim)", flexShrink:0 }}>
                    {s.device.includes("iPhone") || s.device.includes("mobile") ? "📱" : "💻"}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ fontSize:13, fontWeight:600, color:"var(--text)", fontFamily:"var(--font-ui)" }}>{s.device}</span>
                      {s.current && (
                        <span style={{ fontSize:10, padding:"1px 7px", borderRadius:3,
                          background:"var(--green)18", border:"1px solid var(--green)44", color:"var(--green)",
                          fontFamily:"var(--font-mono)" }}>current</span>
                      )}
                    </div>
                    <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-mono)", marginTop:3 }}>
                      {s.ip} · {s.location} · Last active {fmt.time(Date.now()-s.lastActive)}
                    </div>
                  </div>
                  {!s.current && !revokedSessions.has(s.id) && (
                    <Btn small variant="ghost" style={{ color:"var(--red)", borderColor:"var(--red)44" }}
                      onClick={() => { setRevoked(r=>new Set([...r,s.id])); toast.info("Session revoked", {detail:s.device}) }}>
                      Revoke
                    </Btn>
                  )}
                  {revokedSessions.has(s.id) && <Mono size={11} color="var(--dim)">revoked</Mono>}
                </div>
              ))}
            </div>
            <Btn variant="ghost" style={{ color:"var(--red)" }}
              onClick={() => { setRevoked(new Set(sessions.filter(s=>!s.current).map(s=>s.id))); toast.info("All other sessions revoked") }}>
              Sign out all other sessions
            </Btn>
          </div>
        )}

        {/* ── CONNECTED ACCOUNTS ── */}
        {activeSection === "connected" && (
          <div>
            <SectionHeader title="Connected Accounts" subtitle="Link third-party accounts for integrations and sign-in" />
            <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:10, overflow:"hidden" }}>
              {[
                { id:"github",  label:"GitHub",  icon:"⬡", color:"var(--text)",   desc:"Sync repos, trigger on push events" },
                { id:"google",  label:"Google",  icon:"◎", color:"var(--red)",    desc:"Calendar triggers, Drive attachments" },
                { id:"slack",   label:"Slack",   icon:"⬡", color:"var(--purple)", desc:"Post to channels, trigger on messages" },
                { id:"linear",  label:"Linear",  icon:"◈", color:"var(--cyan)",   desc:"Create issues, sync project events" },
              ].map((acct, i) => {
                const c = connected[acct.id]
                return (
                  <div key={acct.id} style={{ display:"flex", alignItems:"center", gap:16, padding:"18px 24px",
                    borderBottom: i<3 ? "1px solid var(--border)" : "none" }}>
                    <span style={{ fontSize:22, color:acct.color, width:28, textAlign:"center" }}>{acct.icon}</span>
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, fontWeight:600, color:"var(--text)", fontFamily:"var(--font-ui)" }}>{acct.label}</div>
                      {c.connected
                        ? <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-mono)", marginTop:2 }}>
                            Connected as {c.username} · {fmt.time(Date.now()-c.connectedAt)}
                          </div>
                        : <div style={{ fontSize:11, color:"var(--dim)", fontFamily:"var(--font-ui)", marginTop:2 }}>{acct.desc}</div>
                      }
                    </div>
                    {c.connected
                      ? <Btn small variant="ghost" style={{ color:"var(--muted)" }}
                          onClick={() => { setConnected(p=>({...p,[acct.id]:{...p[acct.id],connected:false,username:null}})); toast.info(`${acct.label} disconnected`) }}>
                          Disconnect
                        </Btn>
                      : <Btn small variant="primary"
                          onClick={() => { setConnected(p=>({...p,[acct.id]:{connected:true,username:"kobami",connectedAt:Date.now()}})); toast.success(`${acct.label} connected`) }}>
                          Connect
                        </Btn>
                    }
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── DANGER ZONE ── */}
        {activeSection === "danger" && (
          <div>
            <SectionHeader title="Danger Zone" subtitle="Irreversible and destructive actions" />
            {[
              { label:"Export my data", desc:"Download a full archive of your profile, flows, and execution history as JSON.", btn:"Export", variant:"ghost", action:()=>toast.info("Export started — you'll receive an email when it's ready") },
              { label:"Delete all execution history", desc:"Permanently erase all execution records for flows you own. This cannot be undone.", btn:"Delete history", variant:"ghost", action:()=>toast.error("Execution history cleared") },
              { label:"Delete account", desc:"Permanently delete your account and remove you from all workspaces. Account owners must transfer ownership first.", btn:"Delete account", danger:true, action:()=>toast.error("Account deletion requires confirmation — check your email") },
            ].map((item,i) => (
              <div key={i} style={{ background:"var(--panel)", border:`1px solid ${item.danger ? "var(--red)44" : "var(--border)"}`, borderRadius:10, padding:24, marginBottom:16,
                display:"flex", alignItems:"center", justifyContent:"space-between", gap:24 }}>
                <div>
                  <div style={{ fontSize:14, fontWeight:600, color: item.danger ? "var(--red)" : "var(--text)", fontFamily:"var(--font-ui)", marginBottom:4 }}>{item.label}</div>
                  <div style={{ fontSize:12, color:"var(--muted)", fontFamily:"var(--font-ui)", lineHeight:1.5, maxWidth:400 }}>{item.desc}</div>
                </div>
                <Btn small variant="ghost"
                  style={ item.danger ? { color:"var(--red)", borderColor:"var(--red)55", whiteSpace:"nowrap" } : { whiteSpace:"nowrap" }}
                  onClick={item.action}>{item.btn}</Btn>
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  )
}

export const SettingsPage = ({ session }) => {
  const [account, setAccount]       = useState(ACCOUNT_DATA)
  const [activeSection, setSection] = useState("account")
  const [showInvite, setShowInvite] = useState(false)
  const [wsModal, setWsModal]       = useState(null)   // null | "create" | workspace obj (edit)
  const [wsMembersModal, setWsMembersModal] = useState(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const [newKeyName, setNewKeyName] = useState("")
  const [revealedKey, setRevealedKey] = useState(null)
  const [accountForm, setAccountForm] = useState({ name: account.name })
  const [credModal, setCredModal] = useState(null)   // null | "create" | cred obj (edit)
  const [gitWorkspace, setGitWorkspace] = useState(account.workspaces[0]?.id ?? null)
  const [gitWorkspaces, setGitWorkspaces] = useState(account.workspaces)
  const [expandedEnv, setExpandedEnv] = useState(null)
  const [connectModal, setConnectModal] = useState(null) // null | wsId
  const [promotingEnv, setPromotingEnv] = useState(null)

  // Notifications state — lifted out of IIFE to satisfy Rules of Hooks
  const [notifPrefs, setNotifPrefs] = useState({
    channels: {
      email:   { enabled: true,  address: "kobami@orionhq.dev" },
      slack:   { enabled: true,  webhookUrl: "https://hooks.slack.com/services/T00/B00/xxxx" },
      webhook: { enabled: false, url: "" },
    },
    events: {
      "execution.failed":    { email:true,  slack:true,  webhook:false, label:"Execution failed",    desc:"Fires when any flow execution fails or is cancelled." },
      "execution.slow":      { email:false, slack:true,  webhook:false, label:"Slow execution (p95)", desc:"Fires when a run exceeds the p95 duration threshold." },
      "flow.disabled_auto":  { email:true,  slack:true,  webhook:false, label:"Flow auto-disabled",   desc:"Fires when a flow is auto-disabled after repeated failures." },
      "credential.expiring": { email:true,  slack:false, webhook:false, label:"Credential expiring",  desc:"Fires 7 days before an OAuth2 token or secret expires." },
      "member.joined":       { email:false, slack:true,  webhook:false, label:"New member joined",    desc:"Fires when an invited member accepts and joins the account." },
      "queue.pressure":      { email:false, slack:false, webhook:false, label:"Queue pressure",       desc:"Fires when queue depth exceeds 80% of capacity." },
    },
  })
  const [savedNotif, setSavedNotif] = useState(false)
  const flashNotif   = () => { setSavedNotif(true); setTimeout(()=>setSavedNotif(false), 2200) }
  const setChannel   = (ch, k, v) => setNotifPrefs(p => ({...p, channels:{ ...p.channels, [ch]:{...p.channels[ch],[k]:v} }}))
  const setEventCh   = (ev, ch, v) => setNotifPrefs(p => ({...p, events:{ ...p.events, [ev]:{...p.events[ev],[ch]:v} }}))
  const NOTIF_CHANNELS = [
    { id:"email",   label:"Email",          icon:"✉", color:"var(--cyan)"   },
    { id:"slack",   label:"Slack",          icon:"⬡", color:"var(--purple)" },
    { id:"webhook", label:"Custom Webhook", icon:"⚡", color:"var(--amber)"  },
  ]

  const isOwnerOrAdmin = ["owner","admin"].includes(
    account.members.find(m=>m.id===session.userId)?.role ?? "member"
  )
  const hasWorkspaces  = PLAN_HAS_WORKSPACES(account.plan)
  const limits         = PLAN_LIMITS[account.plan]

  const flash = () => { setSavedFlash(true); setTimeout(()=>setSavedFlash(false), 2000) }

  // ── Sidebar nav sections ────────────────────────────────────────────────
  const SECTIONS = [
    { id:"account",     label:"Account",     icon:"⬡" },
    { id:"members",     label:"Members",     icon:"◎" },
    ...( hasWorkspaces ? [{ id:"workspaces", label:"Workspaces", icon:"⬢" }] : [] ),
    { id:"credentials", label:"Credentials", icon:"⟨⟩" },
    { id:"apikeys",     label:"API Keys",    icon:"⌗" },
    { id:"git",         label:"Git & Deploy",icon:"⎇" },
    { id:"auditlog",    label:"Audit Log",   icon:"⊡" },
    { id:"notifications",label:"Notifications",icon:"◉" },
    { id:"billing",     label:"Billing",     icon:"◈" },
    { id:"danger",      label:"Danger Zone", icon:"⚠" },
  ]

  // ── Account section handlers ────────────────────────────────────────────
  const saveAccount = () => {
    setAccount(a => ({...a, name: accountForm.name}))
    ACCOUNT_DATA = {...ACCOUNT_DATA, name: accountForm.name}
    flash()
  }

  // ── Member section handlers ─────────────────────────────────────────────
  const handleInvite = ({ email, role }) => {
    const id = `usr_inv_${Date.now()}`
    const newMember = { id, name: email.split("@")[0], email, role, status:"pending", joinedAt: Date.now(), lastActiveAt: null }
    setAccount(a => ({...a, members: [...a.members, newMember]}))
    setShowInvite(false)
  }
  const removeMember = (id) => {
    setAccount(a => ({
      ...a,
      members: a.members.filter(m=>m.id!==id),
      workspaces: a.workspaces.map(ws => ({...ws, memberIds: ws.memberIds.filter(mid=>mid!==id)}))
    }))
  }
  const changeRole = (id, newRole) => {
    setAccount(a => ({...a, members: a.members.map(m => m.id===id ? {...m, role:newRole} : m)}))
  }

  const saveWorkspace = (form) => {
    if (wsModal === "create") {
      const newWs = { id:`ws_${Date.now()}`, ...form, flowCount:0, createdAt:Date.now() }
      setAccount(a => ({...a, workspaces: [...a.workspaces, newWs]}))
      toast.success("Workspace created", { detail: form.name })
    } else {
      setAccount(a => ({...a, workspaces: a.workspaces.map(ws => ws.id===wsModal.id ? {...ws,...form} : ws)}))
      toast.success("Workspace updated", { detail: form.name })
    }
    setWsModal(null)
  }
  const deleteWorkspace = (id) => {
    const ws = account.workspaces.find(w => w.id === id)
    setAccount(a => ({...a, workspaces: a.workspaces.filter(ws=>ws.id!==id)}))
    toast.info("Workspace deleted", { detail: ws?.name })
  }

  // ── API Key handlers ────────────────────────────────────────────────────
  const createApiKey = () => {
    if (!newKeyName.trim()) return
    const id  = `key_${Date.now()}`
    const raw = `sk-${newKeyName.toLowerCase().replace(/\s+/g,"-").slice(0,4)}-${Math.random().toString(36).slice(2,6)}`
    const newKey = { id, name:newKeyName.trim(), prefix:raw, lastUsedAt:null, createdAt:Date.now(), scopes:["flows:read","flows:run"] }
    setAccount(a => ({...a, apiKeys:[...a.apiKeys, newKey]}))
    setRevealedKey({ id, full: `${raw}${"x".repeat(24)}` })
    setNewKeyName("")
    toast.success("API key created — copy it now, it won't be shown again", { detail: newKeyName.trim(), duration: 5000 })
  }
  const revokeKey = (id) => {
    const k = account.apiKeys.find(k => k.id === id)
    setAccount(a => ({...a, apiKeys: a.apiKeys.filter(k=>k.id!==id)}))
    toast.warning("API key revoked", { detail: k?.name })
  }

  // ── Credential handlers ─────────────────────────────────────────────────
  const saveCred = async (form) => {
    if (credModal === "create") {
      const newCred = { id:`cred_${Date.now()}`, ...form, usedBy:[], createdAt:Date.now(), updatedAt:Date.now() }
      // Optimistic
      setAccount(a => ({...a, credentials:[...(a.credentials??[]), newCred]}))
      setCredModal(null)
      try {
        await credentialApi.create({ name:form.name, type:form.type, workspaceId:form.workspaceId, data:form.fields })
        toast.success("Credential saved", { detail: form.name })
        setApiOnline(true)
      } catch(e) {
        toast.warning("Saved locally — backend unreachable", { detail: e.message })
        setApiOnline(false)
      }
    } else {
      setAccount(a => ({...a, credentials:(a.credentials??[]).map(c => c.id===credModal.id ? {...c,...form,updatedAt:Date.now()} : c)}))
      setCredModal(null)
      try {
        await credentialApi.update(credModal.id, { name:form.name, data:form.fields })
        toast.success("Credential updated", { detail: form.name })
        setApiOnline(true)
      } catch(e) {
        toast.warning("Saved locally — backend unreachable", { detail: e.message })
        setApiOnline(false)
      }
    }
  }
  const deleteCred = async (id) => {
    const c = account.credentials?.find(c => c.id === id)
    setAccount(a => ({...a, credentials:(a.credentials??[]).filter(c=>c.id!==id)}))
    try {
      await credentialApi.delete(id)
      toast.info("Credential deleted", { detail: c?.name })
      setApiOnline(true)
    } catch(e) {
      // Restore on failure
      setAccount(a => ({...a, credentials:[...(a.credentials??[]), c]}))
      toast.error("Failed to delete credential", { detail: e.message })
    }
  }

  // ── Sidebar item ────────────────────────────────────────────────────────
  const SideItem = ({ id, icon, label }) => (
    <button onClick={()=>setSection(id)} style={{
      display:"flex", alignItems:"center", gap:10, width:"100%",
      padding:"8px 12px", borderRadius:6, cursor:"pointer",
      background: activeSection===id ? "var(--cyan)0d" : "transparent",
      border: `1px solid ${activeSection===id?"var(--cyan)22":"transparent"}`,
      color: activeSection===id ? "var(--cyan)" : id==="danger"?"var(--red)88":"var(--muted)",
      fontFamily:"var(--font-ui)", fontSize:14, textAlign:"left",
      transition:"all 0.1s",
    }}>
      <span style={{ fontFamily:"var(--font-mono)", fontSize:14 }}>{icon}</span>
      {label}
    </button>
  )

  return (
    <div className="page-enter" style={{ padding:"32px 28px", maxWidth:1100 }}>
      <div style={{ marginBottom:24 }}>
        <h2 style={{ fontFamily:"var(--font-head)", fontSize:18, fontWeight:700, color:"var(--text)", letterSpacing:"-0.02em", marginBottom:4 }}>
          Settings
        </h2>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <Mono color="var(--muted)" size={12}>{account.name}</Mono>
          <span style={{ color:"var(--dim)" }}>·</span>
          <PlanBadge plan={account.plan} />
          {!hasWorkspaces && (
            <span style={{ fontSize:12, color:"var(--muted)" }}>
              Upgrade to Pro to unlock multiple workspaces
            </span>
          )}
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"200px 1fr", gap:24, alignItems:"start" }}>
        {/* Sidebar */}
        <div style={{
          background:"var(--panel)", border:"1px solid var(--border)",
          borderRadius:8, padding:"10px 8px",
          position:"sticky", top:72,
        }}>
          {SECTIONS.map(s => <SideItem key={s.id} {...s} />)}
        </div>

        {/* Content */}
        <div style={{ background:"var(--panel)", border:"1px solid var(--border)", borderRadius:8, padding:"28px 28px" }}>

          {/* ── Account ─────────────────────────────────────────────── */}
          {activeSection === "account" && (
            <div>
              <SettingsSection title="Account Details" description="Your account name as it appears across the platform.">
                <InputField label="Account Name" value={accountForm.name}
                  onChange={v=>setAccountForm(f=>({...f,name:v}))} placeholder="Acme Corp" />
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <Btn variant="primary" onClick={saveAccount}>Save Changes</Btn>
                  {savedFlash && <span style={{ fontSize:12, color:"var(--green)" }}>✓ Saved</span>}
                </div>
              </SettingsSection>

              <Divider />

              <SettingsSection title="Plan & Usage" description="Current plan limits and consumption.">
                <div style={{
                  background:"var(--surface)", border:"1px solid var(--border)",
                  borderRadius:8, padding:"16px 18px", marginBottom:16,
                  display:"flex", alignItems:"center", justifyContent:"space-between",
                }}>
                  <div>
                    <div style={{ fontSize:12, color:"var(--muted)", marginBottom:4 }}>Current Plan</div>
                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <PlanBadge plan={account.plan} />
                      <Mono color="var(--muted)" size={11}>{account.id}</Mono>
                    </div>
                  </div>
                  <Btn variant="default">Upgrade Plan</Btn>
                </div>
                <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"16px 18px" }}>
                  <UsageBar used={account.members.length}   limit={limits.members}    label="Members"    color="var(--cyan)" />
                  <UsageBar used={account.workspaces.length} limit={limits.workspaces} label="Workspaces" color="var(--purple)" />
                  <UsageBar used={12}                        limit={limits.flows}      label="Active Flows" color="var(--green)" />
                  <UsageBar used={account.apiKeys.length}   limit={limits.apiKeys}    label="API Keys"   color="var(--amber)" />
                </div>
              </SettingsSection>

              {!hasWorkspaces && (
                <>
                  <Divider />
                  <SettingsSection title="Primary Workspace" description="Your account has one workspace. Upgrade to Pro to create more.">
                    <div style={{ background:"var(--surface)", border:`1px solid ${account.workspaces[0].color}44`, borderRadius:8, padding:"14px 16px", borderLeft:`3px solid ${account.workspaces[0].color}` }}>
                      <div style={{ fontSize:14, fontWeight:600, color:"var(--text)", marginBottom:4 }}>{account.workspaces[0].name}</div>
                      <Mono color="var(--muted)" size={10}>{account.workspaces[0].id}</Mono>
                      <div style={{ marginTop:10, display:"flex", gap:20 }}>
                        <div><div style={{ fontSize:11, color:"var(--muted)", marginBottom:2 }}>Flows</div><Mono>{account.workspaces[0].flowCount}</Mono></div>
                        <div><div style={{ fontSize:11, color:"var(--muted)", marginBottom:2 }}>Members</div><Mono>{account.members.length}</Mono></div>
                      </div>
                    </div>
                  </SettingsSection>
                </>
              )}
            </div>
          )}

          {/* ── Members ─────────────────────────────────────────────── */}
          {activeSection === "members" && (
            <div>
              <SettingsSection
                title="Team Members"
                description={`${account.members.length} member${account.members.length!==1?"s":""} in this account`}
                action={isOwnerOrAdmin && <Btn variant="primary" onClick={()=>setShowInvite(true)}>+ Invite Member</Btn>}
              >
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {account.members.map(m => {
                    const roleColor = ROLE_COLORS[m.role] ?? "var(--muted)"
                    const isSelf = m.id === session.userId
                    return (
                      <div key={m.id} style={{
                        background:"var(--surface)", border:"1px solid var(--border)",
                        borderRadius:7, padding:"12px 14px",
                        display:"flex", alignItems:"center", gap:12,
                      }}>
                        <Avatar name={m.name} size={34} color={m.status==="pending"?"var(--dim)":roleColor} />
                        <div style={{ flex:1 }}>
                          <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:2 }}>
                            <span style={{ fontSize:14, color:"var(--text)", fontWeight:500 }}>{m.name}</span>
                            {isSelf && <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:"var(--cyan)", background:"var(--cyan)18", padding:"1px 5px", borderRadius:2 }}>you</span>}
                            {m.status === "pending" && <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:"var(--amber)", background:"var(--amber)18", padding:"1px 5px", borderRadius:2 }}>pending invite</span>}
                          </div>
                          <Mono color="var(--muted)" size={11}>{m.email}</Mono>
                        </div>
                        <div style={{ fontSize:12, color:"var(--muted)", textAlign:"right", minWidth:80 }}>
                          {m.lastActiveAt ? fmt.time(now - m.lastActiveAt) : "never"}
                        </div>
                        {/* Role selector */}
                        {isOwnerOrAdmin && !isSelf && m.role !== "owner" ? (
                          <select
                            value={m.role}
                            onChange={e=>changeRole(m.id, e.target.value)}
                            style={{
                              background:"var(--panel)", border:`1px solid ${roleColor}44`,
                              borderRadius:4, padding:"3px 8px",
                              color:roleColor, fontSize:12, fontFamily:"var(--font-mono)",
                              cursor:"pointer", outline:"none",
                            }}
                          >
                            <option value="member">member</option>
                            <option value="admin">admin</option>
                          </select>
                        ) : (
                          <span style={{
                            padding:"2px 8px", borderRadius:3, fontSize:12,
                            background:`${roleColor}18`, color:roleColor,
                            border:`1px solid ${roleColor}33`,
                            fontFamily:"var(--font-mono)",
                          }}>{m.role}</span>
                        )}
                        {isOwnerOrAdmin && !isSelf && m.role !== "owner" && (
                          <Btn small variant="danger" onClick={()=>removeMember(m.id)}>Remove</Btn>
                        )}
                      </div>
                    )
                  })}
                </div>
              </SettingsSection>
            </div>
          )}

          {/* ── Workspaces (Pro/Enterprise only) ────────────────────── */}
          {activeSection === "workspaces" && hasWorkspaces && (
            <div>
              <SettingsSection
                title="Workspaces"
                description="Isolate flows and control member access per workspace."
                action={
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    {limits.workspaces !== -1 && (
                      <Mono color="var(--muted)" size={11}>{account.workspaces.length} / {limits.workspaces}</Mono>
                    )}
                    <Btn variant="primary" onClick={()=>setWsModal("create")}
                      disabled={limits.workspaces!==-1 && account.workspaces.length>=limits.workspaces}>
                      + New Workspace
                    </Btn>
                  </div>
                }
              >
                <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
                  {account.workspaces.map(ws => (
                    <div key={ws.id} style={{ background:"var(--surface)", borderRadius:8, border:"1px solid var(--border)", overflow:"hidden" }}>
                      <WorkspaceCard
                        ws={ws} members={account.members}
                        isOnlyWorkspace={account.workspaces.length === 1}
                        onEdit={ws => setWsModal(ws)}
                        onDelete={deleteWorkspace}
                        onManageMembers={ws => setWsMembersModal(ws)}
                      />
                      <div style={{ padding:"0 16px 16px" }}>
                        <WorkspaceVarsSettings
                          workspace={ws}
                          onUpdate={updatedWs => setAccount(a => ({
                            ...a,
                            workspaces: a.workspaces.map(w => w.id===updatedWs.id ? updatedWs : w)
                          }))}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </SettingsSection>
            </div>
          )}

          {/* ── Credentials ─────────────────────────────────────────── */}
          {activeSection === "credentials" && (
            <div>
              <SettingsSection
                title="Credentials"
                description="Secrets used by nodes at runtime. Values are encrypted at rest and never exposed in logs or outputs."
                action={
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    {limits.credentials !== -1 && (
                      <Mono color="var(--muted)" size={11}>{(account.credentials??[]).length} / {limits.credentials}</Mono>
                    )}
                    <Btn variant="primary" onClick={() => setCredModal("create")}>+ New Credential</Btn>
                  </div>
                }
              >
                {(account.credentials??[]).length === 0 ? (
                  <div style={{ textAlign:"center", padding:"40px 0", color:"var(--muted)", fontSize:13 }}>
                    No credentials yet. Add one to let nodes authenticate against external services.
                  </div>
                ) : (
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {(account.credentials??[]).map(cred => {
                      const meta = CRED_TYPE_META[cred.type] ?? CRED_TYPE_META.secret
                      const ws   = account.workspaces.find(w=>w.id===cred.workspaceId)
                      return (
                        <div key={cred.id} style={{
                          background:"var(--surface)", border:"1px solid var(--border)",
                          borderRadius:7, padding:"13px 16px",
                          borderLeft:`2px solid ${meta.color}`,
                          display:"flex", alignItems:"center", gap:14,
                        }}>
                          <div style={{
                            width:32, height:32, borderRadius:6, flexShrink:0,
                            background:`${meta.color}18`, border:`1px solid ${meta.color}33`,
                            display:"flex", alignItems:"center", justifyContent:"center",
                            fontFamily:"var(--font-mono)", fontSize:14, color:meta.color,
                          }}>{meta.icon}</div>
                          <div style={{ flex:1 }}>
                            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3 }}>
                              <span style={{ fontSize:14, fontWeight:500, color:"var(--text)" }}>{cred.name}</span>
                              <span style={{
                                fontSize:10, fontFamily:"var(--font-mono)",
                                background:`${meta.color}18`, color:meta.color,
                                border:`1px solid ${meta.color}33`,
                                padding:"1px 5px", borderRadius:2,
                              }}>{meta.label}</span>
                              {ws && (
                                <span style={{ fontSize:10, fontFamily:"var(--font-mono)", color:"var(--muted)",
                                  background:"var(--border)", padding:"1px 5px", borderRadius:2 }}>
                                  {ws.name}
                                </span>
                              )}
                            </div>
                            <div style={{ display:"flex", gap:12 }}>
                              <Mono color="var(--muted)" size={10}>
                                {Object.entries(cred.fields)[0]?.[1] ?? "•••"}
                              </Mono>
                              <Mono color="var(--dim)" size={10}>updated {fmt.time(now - cred.updatedAt)}</Mono>
                            </div>
                          </div>
                          {cred.usedBy.length > 0 && (
                            <div style={{ textAlign:"right" }}>
                              <div style={{ fontSize:10, color:"var(--muted)", marginBottom:3 }}>Used by</div>
                              <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                                {cred.usedBy.slice(0,2).map(fid => (
                                  <Mono key={fid} size={9} color="var(--muted)">
                                    {FLOWS.find(f=>f.id===fid)?.name ?? fid}
                                  </Mono>
                                ))}
                                {cred.usedBy.length > 2 && <Mono size={9} color="var(--dim)">+{cred.usedBy.length-2} more</Mono>}
                              </div>
                            </div>
                          )}
                          <div style={{ display:"flex", gap:6 }}>
                            <Btn small variant="ghost" onClick={() => setCredModal(cred)}>Edit</Btn>
                            <Btn small variant="danger" onClick={() => deleteCred(cred.id)}>Delete</Btn>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </SettingsSection>
            </div>
          )}

          {/* ── API Keys ─────────────────────────────────────────────── */}
          {activeSection === "apikeys" && (
            <div>
              <SettingsSection title="API Keys" description="Use these to authenticate against the Orion API programmatically.">
                <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:16 }}>
                  {account.apiKeys.map(k => (
                    <div key={k.id} style={{
                      background:"var(--surface)", border:"1px solid var(--border)",
                      borderRadius:7, padding:"12px 14px",
                      display:"flex", alignItems:"center", gap:14,
                    }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:14, color:"var(--text)", fontWeight:500, marginBottom:4 }}>{k.name}</div>
                        <div style={{ display:"flex", gap:12, alignItems:"center" }}>
                          <Mono size={11}>
                            {revealedKey?.id===k.id ? revealedKey.full : `${k.prefix}${"•".repeat(24)}`}
                          </Mono>
                          {revealedKey?.id===k.id && (
                            <Btn small variant="ghost" onClick={()=>setRevealedKey(null)}>Hide</Btn>
                          )}
                        </div>
                      </div>
                      <div style={{ textAlign:"right" }}>
                        <div style={{ fontSize:11, color:"var(--muted)", marginBottom:2 }}>Last used</div>
                        <Mono size={11} color="var(--muted)">{k.lastUsedAt ? fmt.time(now-k.lastUsedAt) : "never"}</Mono>
                      </div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:4, maxWidth:200, justifyContent:"flex-end" }}>
                        {k.scopes.map(s => (
                          <span key={s} style={{
                            fontSize:10, fontFamily:"var(--font-mono)",
                            background:"var(--border)", color:"var(--muted)",
                            padding:"1px 5px", borderRadius:2,
                          }}>{s}</span>
                        ))}
                      </div>
                      <Btn small variant="danger" onClick={()=>revokeKey(k.id)}>Revoke</Btn>
                    </div>
                  ))}
                </div>
                {(limits.apiKeys === -1 || account.apiKeys.length < limits.apiKeys) && (
                  <div style={{ display:"flex", gap:8 }}>
                    <input
                      value={newKeyName} onChange={e=>setNewKeyName(e.target.value)}
                      placeholder="Key name (e.g. Production)"
                      onKeyDown={e=>{ if(e.key==="Enter") createApiKey() }}
                      style={{
                        flex:1, background:"var(--bg)", border:"1px solid var(--border2)",
                        borderRadius:5, padding:"7px 12px", fontSize:13,
                        color:"var(--text)", outline:"none", fontFamily:"var(--font-ui)",
                      }}
                      onFocus={e=>e.target.style.borderColor="var(--cyan)"}
                      onBlur={e=>e.target.style.borderColor="var(--border2)"}
                    />
                    <Btn variant="default" onClick={createApiKey}>Generate Key</Btn>
                  </div>
                )}
                {revealedKey && !account.apiKeys.find(k=>k.id===revealedKey.id) && null}
                <div style={{ marginTop:14, fontSize:12, color:"var(--muted)", lineHeight:1.7 }}>
                  API keys grant programmatic access. Treat them like passwords — they cannot be viewed again after creation.
                </div>
              </SettingsSection>
            </div>
          )}

          {/* ── Audit Log ────────────────────────────────────────────── */}
          {activeSection === "auditlog" && (() => {
            const AUDIT_COLORS = {
              "member.invited":      "var(--green)",
              "member.removed":      "var(--red)",
              "member.role_changed": "var(--amber)",
              "flow.enabled":        "var(--green)",
              "flow.disabled":       "var(--amber)",
              "flow.triggered":      "var(--cyan)",
              "apikey.created":      "var(--cyan)",
              "apikey.revoked":      "var(--red)",
              "credential.created":  "var(--purple)",
              "credential.updated":  "var(--purple)",
              "credential.deleted":  "var(--red)",
              "workspace.created":   "var(--cyan)",
              "workspace.deleted":   "var(--red)",
            }
            const AUDIT_ICONS = {
              "member.invited":      "◎+",
              "member.removed":      "◎−",
              "member.role_changed": "◎→",
              "flow.enabled":        "▶",
              "flow.disabled":       "⏸",
              "flow.triggered":      "▷",
              "apikey.created":      "⌗+",
              "apikey.revoked":      "⌗×",
              "credential.created":  "⟨⟩+",
              "credential.updated":  "⟨⟩~",
              "credential.deleted":  "⟨⟩×",
              "workspace.created":   "⬢+",
              "workspace.deleted":   "⬢×",
            }
            return (
              <SettingsSection
                title="Audit Log"
                description="A record of all significant actions taken by members in this account."
              >
                <div style={{ position:"relative" }}>
                  {/* Timeline line */}
                  <div style={{
                    position:"absolute", left:17, top:8, bottom:8,
                    width:1, background:"var(--border2)",
                  }} />
                  <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
                    {(account.auditLog ?? []).map((entry, i) => {
                      const color = AUDIT_COLORS[entry.action] ?? "var(--muted)"
                      const icon  = AUDIT_ICONS[entry.action]  ?? "·"
                      const [ns, verb] = entry.action.split(".")
                      return (
                        <div key={entry.id} style={{
                          display:"flex", gap:14, alignItems:"flex-start",
                          padding:"10px 0",
                          borderBottom: i < (account.auditLog.length-1) ? "1px solid var(--border)44" : "none",
                        }}>
                          {/* Icon dot */}
                          <div style={{
                            width:34, height:34, borderRadius:"50%", flexShrink:0,
                            background:`${color}18`, border:`1px solid ${color}44`,
                            display:"flex", alignItems:"center", justifyContent:"center",
                            fontFamily:"var(--font-mono)", fontSize:10, color,
                            zIndex:1, position:"relative",
                          }}>{icon}</div>
                          {/* Content */}
                          <div style={{ flex:1, paddingTop:6 }}>
                            <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:3, flexWrap:"wrap" }}>
                              <span style={{ fontFamily:"var(--font-mono)", fontSize:12, color }}>
                                {entry.action}
                              </span>
                              <span style={{
                                fontFamily:"var(--font-mono)", fontSize:11,
                                background:"var(--surface)", border:"1px solid var(--border)",
                                padding:"1px 6px", borderRadius:3, color:"var(--text)",
                              }}>{entry.subject}</span>
                              {Object.entries(entry.meta ?? {}).map(([k,v]) => (
                                <span key={k} style={{ fontSize:11, color:"var(--muted)" }}>
                                  {k}:{Array.isArray(v) ? v.join(",") : String(v)}
                                </span>
                              ))}
                            </div>
                            <div style={{ display:"flex", gap:10 }}>
                              <span style={{ fontSize:12, color:"var(--muted)" }}>by</span>
                              <Mono size={11} color="var(--text)">{entry.actor}</Mono>
                              <Mono size={11} color="var(--dim)">{fmt.time(now - entry.at)}</Mono>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </SettingsSection>
            )
          })()}

          {/* ── Notifications ─────────────────────────────────────────── */}
          {activeSection === "notifications" && (
              <div>
                {/* Channel config */}
                <SettingsSection
                  title="Alert Channels"
                  description="Configure where Orion sends notifications. At least one channel must be enabled."
                >
                  <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                    {NOTIF_CHANNELS.map(ch => {
                      const cfg = notifPrefs.channels[ch.id]
                      return (
                        <div key={ch.id} style={{
                          background:"var(--surface)", border:`1px solid ${cfg.enabled ? ch.color+"44" : "var(--border)"}`,
                          borderRadius:8, padding:"14px 16px",
                          borderLeft:`2px solid ${cfg.enabled ? ch.color : "var(--border2)"}`,
                          transition:"border-color 0.15s",
                        }}>
                          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom: cfg.enabled ? 12 : 0 }}>
                            <span style={{ fontFamily:"var(--font-mono)", fontSize:16, color: cfg.enabled ? ch.color : "var(--muted)" }}>{ch.icon}</span>
                            <span style={{ fontSize:14, fontWeight:500, color: cfg.enabled ? "var(--text)" : "var(--muted)", flex:1 }}>{ch.label}</span>
                            <Toggle enabled={cfg.enabled} onChange={v => setChannel(ch.id, "enabled", v)} />
                          </div>
                          {cfg.enabled && (
                            <div>
                              {"address" in cfg && (
                                <InputField
                                  label="Email Address" value={cfg.address}
                                  onChange={v => setChannel(ch.id, "address", v)}
                                  placeholder="alerts@yourcompany.com" type="email"
                                />
                              )}
                              {"webhookUrl" in cfg && (
                                <InputField
                                  label="Slack Webhook URL" value={cfg.webhookUrl}
                                  onChange={v => setChannel(ch.id, "webhookUrl", v)}
                                  placeholder="https://hooks.slack.com/services/…" mono
                                />
                              )}
                              {"url" in cfg && !("webhookUrl" in cfg) && (
                                <InputField
                                  label="Endpoint URL" value={cfg.url}
                                  onChange={v => setChannel(ch.id, "url", v)}
                                  placeholder="https://yourserver.com/orion-alerts" mono
                                />
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </SettingsSection>

                {/* Per-event matrix */}
                <SettingsSection
                  title="Event Rules"
                  description="Choose which channels receive which events. Disabled channels are greyed out."
                >
                  <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
                    {/* Header row */}
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 80px 80px 80px", gap:0, marginBottom:4, padding:"0 16px" }}>
                      <div />
                      {NOTIF_CHANNELS.map(ch => (
                        <div key={ch.id} style={{ textAlign:"center", fontSize:11, color: notifPrefs.channels[ch.id].enabled ? ch.color : "var(--dim)", textTransform:"uppercase", letterSpacing:"0.07em" }}>
                          {ch.icon}
                        </div>
                      ))}
                    </div>
                    {Object.entries(notifPrefs.events).map(([evKey, ev], i, arr) => (
                      <div key={evKey} style={{
                        display:"grid", gridTemplateColumns:"1fr 80px 80px 80px",
                        alignItems:"center", padding:"10px 16px",
                        borderBottom: i < arr.length-1 ? "1px solid var(--border)" : "none",
                        background:"var(--panel)",
                        borderRadius: i===0 ? "7px 7px 0 0" : i===arr.length-1 ? "0 0 7px 7px" : 0,
                        border:"1px solid var(--border)",
                        marginTop: i===0 ? 0 : -1,
                      }}>
                        <div>
                          <div style={{ fontSize:13, color:"var(--text)", marginBottom:2 }}>{ev.label}</div>
                          <div style={{ fontSize:11, color:"var(--muted)" }}>{ev.desc}</div>
                        </div>
                        {NOTIF_CHANNELS.map(ch => {
                          const chEnabled = notifPrefs.channels[ch.id].enabled
                          return (
                            <div key={ch.id} style={{ display:"flex", justifyContent:"center" }}>
                              <input
                                type="checkbox"
                                checked={ev[ch.id] && chEnabled}
                                disabled={!chEnabled}
                                onChange={e => setEventCh(evKey, ch.id, e.target.checked)}
                                style={{ width:15, height:15, cursor: chEnabled ? "pointer" : "not-allowed", accentColor: ch.color, opacity: chEnabled ? 1 : 0.3 }}
                              />
                            </div>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                  <div style={{ display:"flex", justifyContent:"flex-end", marginTop:16, gap:8, alignItems:"center" }}>
                    {savedNotif && <span style={{ fontSize:12, color:"var(--green)", fontFamily:"var(--font-mono)" }}>✓ Saved</span>}
                    <Btn variant="primary" onClick={flashNotif}>Save Preferences</Btn>
                  </div>
                </SettingsSection>
              </div>
            )}

          {/* ── Billing ──────────────────────────────────────────────── */}
          {/* ── Git & Deployments ────────────────────────────────── */}
          {activeSection === "git" && (() => {
            const ws     = gitWorkspaces.find(w => w.id === gitWorkspace)
            const git    = ws?.git ?? null
            const PROVIDER_META = {
              github:    { label:"GitHub",    icon:"⎇", color:"var(--text)" },
              gitlab:    { label:"GitLab",    icon:"⎇", color:"var(--amber)" },
              bitbucket: { label:"Bitbucket", icon:"⎇", color:"var(--cyan)" },
            }
            const ENV_STATUS_META = {
              deployed: { label:"Deployed",  color:"var(--green)", dot:"●" },
              behind:   { label:"Behind",    color:"var(--amber)", dot:"◐" },
              failed:   { label:"Failed",    color:"var(--red)",   dot:"●" },
              pending:  { label:"Pending",   color:"var(--muted)", dot:"○" },
            }
            const patchGitWs = (wsId, patch) =>
              setGitWorkspaces(ws => ws.map(w => w.id===wsId ? {...w, git:{...w.git,...patch}} : w))
            const patchEnv = (wsId, envId, patch) =>
              setGitWorkspaces(ws => ws.map(w => w.id!==wsId ? w : {
                ...w, git:{...w.git, environments: w.git.environments.map(e => e.id===envId?{...e,...patch}:e)}
              }))
            const doPromote = (envId) => {
              setPromotingEnv(envId)
              setTimeout(() => {
                const devEnv = git.environments.find(e=>e.id==="env_dev")
                patchEnv(ws.id, envId, {
                  status:"deployed", lastDeployedAt:Date.now(), lastDeployedSha:devEnv?.lastDeployedSha ?? "abc1234",
                  lastDeployedBy: session.email,
                  deployHistory: [
                    { sha:devEnv?.lastDeployedSha??"abc1234", message:"Promoted from dev", deployedAt:Date.now(), deployedBy:session.email, status:"success", duration:7800 },
                    ...(git.environments.find(e=>e.id===envId)?.deployHistory ?? []).slice(0,4),
                  ]
                })
                setPromotingEnv(null)
                toast.success("Deployed to production", { detail:`sha ${devEnv?.lastDeployedSha?.slice(0,7) ?? "abc1234"}` })
              }, 1800)
            }

            return (
              <div>
                {/* Workspace selector */}
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20 }}>
                  <span style={{ fontSize:12, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>Workspace</span>
                  <div style={{ display:"flex", gap:6 }}>
                    {gitWorkspaces.map(w => (
                      <button key={w.id} onClick={() => setGitWorkspace(w.id)}
                        style={{ padding:"4px 12px", borderRadius:5, cursor:"pointer", fontSize:12,
                          background: gitWorkspace===w.id ? `${w.color}18` : "var(--surface)",
                          border:`1px solid ${gitWorkspace===w.id ? w.color+"55" : "var(--border)"}`,
                          color: gitWorkspace===w.id ? w.color : "var(--muted)",
                          fontFamily:"var(--font-ui)", fontWeight: gitWorkspace===w.id ? 600 : 400,
                          transition:"all 0.1s" }}>
                        {w.name}
                        {w.git && <span style={{ marginLeft:5, fontSize:9, color: gitWorkspace===w.id ? w.color+"99" : "var(--dim)" }}>⎇</span>}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Not connected */}
                {!git && (
                  <SettingsSection title="Git & Deployments" description="Connect a git repo to auto-deploy flows on push.">
                    <div style={{ textAlign:"center", padding:"40px 20px",
                      background:"var(--surface)", border:"1px dashed var(--border2)", borderRadius:8 }}>
                      <div style={{ fontSize:28, marginBottom:10, opacity:0.3 }}>⎇</div>
                      <div style={{ fontSize:14, color:"var(--text)", marginBottom:6, fontWeight:500 }}>No repository connected</div>
                      <div style={{ fontSize:12, color:"var(--muted)", marginBottom:20, maxWidth:340, margin:"0 auto 20px" }}>
                        Connect a GitHub, GitLab, or Bitbucket repo. Each branch can map to an environment — dev auto-deploys on push, production requires manual promotion.
                      </div>
                      <Btn variant="primary" onClick={() => setConnectModal(ws.id)}>⎇ Connect Repository</Btn>
                    </div>
                  </SettingsSection>
                )}

                {/* Connected */}
                {git && (
                  <>
                    {/* Repo header */}
                    <SettingsSection
                      title="Repository"
                      description="Flows are loaded from this repo. Push to a connected branch to trigger a deploy."
                    >
                      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                        background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8,
                        padding:"14px 16px", marginBottom:0 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                          <div style={{ width:36, height:36, borderRadius:7, background:"var(--bg)",
                            border:"1px solid var(--border2)", display:"flex", alignItems:"center",
                            justifyContent:"center", fontSize:18, color:"var(--muted)" }}>⎇</div>
                          <div>
                            <div style={{ fontSize:14, fontWeight:600, color:"var(--text)", marginBottom:2,
                              fontFamily:"var(--font-ui)" }}>{git.repoName}</div>
                            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                              <Mono size={11} color="var(--green)">
                                {PROVIDER_META[git.provider]?.label ?? git.provider}
                              </Mono>
                              <Mono size={10} color="var(--dim)">connected {fmt.time(now - git.connectedAt)}</Mono>
                            </div>
                          </div>
                        </div>
                        <div style={{ display:"flex", gap:6 }}>
                          <Btn small variant="ghost" onClick={() => window.open(git.repoUrl,"_blank")}>Open repo ↗</Btn>
                          <Btn small variant="danger" onClick={() => {
                            patchGitWs(ws.id, null)
                            setGitWorkspaces(w => w.map(ww => ww.id===ws.id ? {...ww, git:null} : ww))
                            toast.info("Repository disconnected")
                          }}>Disconnect</Btn>
                        </div>
                      </div>
                    </SettingsSection>

                    <div style={{ height:1, background:"var(--border)", margin:"20px 0" }} />

                    {/* Environments */}
                    <SettingsSection
                      title="Environments"
                      description="Each branch maps to an environment. Webhooks are registered as /hooks/[env-label]/path."
                      action={
                        <Btn small variant="default" onClick={() => {
                          const newEnv = {
                            id:`env_${Date.now()}`, branch:"feature", label:"Preview",
                            autoDeploy:true, requiresApproval:false,
                            lastDeployedAt:null, lastDeployedSha:null, lastDeployedBy:null,
                            status:"pending", deployHistory:[],
                          }
                          patchGitWs(ws.id, { environments:[...git.environments, newEnv] })
                        }}>+ Add Environment</Btn>
                      }
                    >
                      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                        {git.environments.map(env => {
                          const sm      = ENV_STATUS_META[env.status] ?? ENV_STATUS_META.pending
                          const isOpen  = expandedEnv === env.id
                          const isProd  = env.requiresApproval
                          const devEnv  = git.environments.find(e=>e.id==="env_dev")
                          const canPromote = isProd && devEnv && devEnv.lastDeployedSha !== env.lastDeployedSha
                          const promoting  = promotingEnv === env.id

                          return (
                            <div key={env.id} style={{
                              background:"var(--surface)", borderRadius:8, overflow:"hidden",
                              border:`1px solid ${isProd ? "var(--cyan)33" : "var(--border)"}`,
                              borderLeft:`2px solid ${isProd ? "var(--cyan)" : "var(--border2)"}`,
                            }}>
                              {/* Environment row */}
                              <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px" }}>
                                {/* Branch + label */}
                                <div style={{ flex:1, minWidth:0 }}>
                                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                                    <span style={{ fontSize:13, fontWeight:600, color:"var(--text)",
                                      fontFamily:"var(--font-ui)" }}>{env.label}</span>
                                    {isProd && (
                                      <span style={{ fontSize:9, color:"var(--cyan)", background:"var(--cyan)12",
                                        border:"1px solid var(--cyan)33", padding:"1px 5px", borderRadius:2,
                                        fontFamily:"var(--font-mono)", textTransform:"uppercase" }}>production</span>
                                    )}
                                    <span style={{ fontSize:11, color:sm.color, fontFamily:"var(--font-mono)" }}>
                                      {sm.dot} {sm.label}
                                    </span>
                                  </div>
                                  <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                                    <span style={{ fontFamily:"var(--font-mono)", fontSize:11,
                                      color:"var(--muted)", background:"var(--bg)",
                                      border:"1px solid var(--border)", padding:"1px 7px", borderRadius:3 }}>
                                      ⎇ {env.branch}
                                    </span>
                                    <span style={{ fontFamily:"var(--font-mono)", fontSize:11, color:"var(--purple)" }}>
                                      /hooks/{env.label.toLowerCase()}/…
                                    </span>
                                    {env.lastDeployedSha && (
                                      <Mono size={10} color="var(--dim)">
                                        {env.lastDeployedSha.slice(0,7)} · {env.lastDeployedAt ? fmt.time(now-env.lastDeployedAt) : "never"}
                                      </Mono>
                                    )}
                                  </div>
                                </div>

                                {/* Flags */}
                                <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
                                  <div style={{ display:"flex", alignItems:"center", gap:5 }}
                                    title={env.autoDeploy ? "Auto-deploys on push" : "Manual deploy only"}>
                                    <Toggle
                                      value={env.autoDeploy}
                                      onChange={v => patchEnv(ws.id, env.id, { autoDeploy:v })}
                                    />
                                    <span style={{ fontSize:11, color:"var(--muted)", fontFamily:"var(--font-ui)" }}>Auto</span>
                                  </div>

                                  {/* Cron behaviour */}
                                  <select
                                    value={env.cronBehaviour ?? (isProd ? "active" : "paused")}
                                    onChange={e => patchEnv(ws.id, env.id, { cronBehaviour:e.target.value })}
                                    title="Cron / event trigger behaviour in this environment"
                                    style={{ background:"var(--bg)", border:"1px solid var(--border2)", borderRadius:4,
                                      padding:"3px 6px", fontSize:10, color:"var(--muted)", outline:"none",
                                      cursor:"pointer", fontFamily:"var(--font-mono)" }}
                                    onFocus={e=>e.target.style.borderColor="var(--cyan)"}
                                    onBlur={e=>e.target.style.borderColor="var(--border2)"}
                                  >
                                    <option value="active">⏱ active</option>
                                    <option value="paused">⏸ paused</option>
                                    <option value="simulate">◎ simulate</option>
                                  </select>
                                </div>

                                {/* Promote / history */}
                                <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                                  {canPromote && (
                                    <button
                                      onClick={() => doPromote(env.id)}
                                      disabled={promoting}
                                      style={{ padding:"4px 12px", borderRadius:5, cursor: promoting ? "default" : "pointer",
                                        fontSize:11, fontFamily:"var(--font-ui)", fontWeight:600,
                                        background: promoting ? "var(--surface)" : "var(--cyan)18",
                                        border:`1px solid ${promoting ? "var(--border)" : "var(--cyan)55"}`,
                                        color: promoting ? "var(--muted)" : "var(--cyan)",
                                        transition:"all 0.15s" }}>
                                      {promoting ? "Deploying…" : "↑ Promote"}
                                    </button>
                                  )}
                                  <button
                                    onClick={() => setExpandedEnv(isOpen ? null : env.id)}
                                    style={{ padding:"4px 10px", borderRadius:5, cursor:"pointer",
                                      fontSize:11, fontFamily:"var(--font-ui)",
                                      background: isOpen ? "var(--surface)" : "transparent",
                                      border:"1px solid var(--border)", color:"var(--muted)",
                                      transition:"all 0.1s" }}>
                                    {isOpen ? "▴ history" : "▾ history"}
                                  </button>
                                </div>
                              </div>

                              {/* Deploy history drawer */}
                              {isOpen && (
                                <div style={{ borderTop:"1px solid var(--border)", background:"var(--bg)",
                                  padding:"10px 16px" }}>
                                  <div style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase",
                                    letterSpacing:"0.06em", fontFamily:"var(--font-ui)", marginBottom:8 }}>
                                    Deploy history
                                  </div>
                                  {env.deployHistory.length === 0 ? (
                                    <div style={{ fontSize:12, color:"var(--dim)", padding:"6px 0" }}>No deploys yet.</div>
                                  ) : (
                                    <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                                      {env.deployHistory.map((d, i) => (
                                        <div key={i} style={{ display:"flex", alignItems:"center", gap:10,
                                          padding:"7px 10px", borderRadius:5,
                                          background:"var(--panel)", border:"1px solid var(--border)" }}>
                                          {/* Status dot */}
                                          <span style={{ fontSize:10, color: d.status==="success"?"var(--green)":d.status==="failed"?"var(--red)":"var(--muted)", flexShrink:0 }}>
                                            {d.status==="success"?"●":d.status==="failed"?"●":"○"}
                                          </span>
                                          {/* SHA */}
                                          <Mono size={10} color="var(--cyan)" style={{ flexShrink:0 }}>{d.sha.slice(0,7)}</Mono>
                                          {/* Message */}
                                          <span style={{ fontSize:11, color:"var(--text)", flex:1,
                                            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                                            fontFamily:"var(--font-ui)" }}>{d.message}</span>
                                          {/* Error */}
                                          {d.error && (
                                            <span style={{ fontSize:10, color:"var(--red)", fontFamily:"var(--font-mono)",
                                              background:"var(--red)08", border:"1px solid var(--red)22",
                                              padding:"1px 6px", borderRadius:3, maxWidth:200,
                                              overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                              {d.error}
                                            </span>
                                          )}
                                          {/* Meta */}
                                          <div style={{ display:"flex", gap:8, flexShrink:0, alignItems:"center" }}>
                                            <Mono size={10} color="var(--muted)">{fmt.time(now - d.deployedAt)}</Mono>
                                            <Mono size={10} color="var(--dim)">{(d.duration/1000).toFixed(1)}s</Mono>
                                            <Mono size={10} color="var(--dim)">{d.deployedBy === "auto" ? "⎇ push" : d.deployedBy.split("@")[0]}</Mono>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </SettingsSection>
                  </>
                )}

                {/* Connect repo modal */}
                {connectModal && (
                  <div style={{ position:"fixed", inset:0, zIndex:200, background:"rgba(8,10,15,0.8)",
                    backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center" }}
                    onClick={e => { if(e.target===e.currentTarget) setConnectModal(null) }}>
                    <div className="page-enter" style={{ background:"var(--panel)", border:"1px solid var(--border2)",
                      borderRadius:10, width:480, padding:"26px 28px", boxShadow:"0 24px 64px rgba(0,0,0,0.6)" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
                        <div>
                          <div style={{ fontFamily:"var(--font-head)", fontSize:16, fontWeight:700,
                            color:"var(--text)", marginBottom:3 }}>Connect Repository</div>
                          <Mono size={11} color="var(--muted)">{ws?.name}</Mono>
                        </div>
                        <button onClick={() => setConnectModal(null)} style={{ background:"none", border:"none",
                          color:"var(--muted)", cursor:"pointer", fontSize:20 }}>×</button>
                      </div>

                      {/* Provider */}
                      <div style={{ marginBottom:14 }}>
                        <div style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase",
                          letterSpacing:"0.07em", marginBottom:8, fontFamily:"var(--font-ui)" }}>Provider</div>
                        <div style={{ display:"flex", gap:6 }}>
                          {["github","gitlab","bitbucket"].map(p => {
                            const active = (connectModal?.provider ?? "github") === p
                            return (
                              <button key={p} onClick={() => setConnectModal(c => ({...c, provider:p}))}
                                style={{ flex:1, padding:"8px 0", borderRadius:6, cursor:"pointer",
                                  fontSize:12, fontFamily:"var(--font-ui)", fontWeight: active?600:400,
                                  background: active?"var(--cyan)12":"var(--surface)",
                                  border:`1px solid ${active?"var(--cyan)44":"var(--border)"}`,
                                  color: active?"var(--cyan)":"var(--muted)", transition:"all 0.1s" }}>
                                ⎇ {PROVIDER_META[p].label}
                              </button>
                            )
                          })}
                        </div>
                      </div>

                      {/* Repo URL */}
                      <div style={{ marginBottom:14 }}>
                        <label style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase",
                          letterSpacing:"0.07em", marginBottom:5, display:"block", fontFamily:"var(--font-ui)" }}>
                          Repository URL
                        </label>
                        <input
                          placeholder="https://github.com/org/flows-repo"
                          value={connectModal?.repoUrl ?? ""}
                          onChange={e => setConnectModal(c => ({...c, repoUrl:e.target.value}))}
                          style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)",
                            borderRadius:5, padding:"7px 10px", fontSize:12, color:"var(--text)",
                            outline:"none", boxSizing:"border-box", fontFamily:"var(--font-mono)" }}
                          onFocus={e=>e.target.style.borderColor="var(--cyan)"}
                          onBlur={e=>e.target.style.borderColor="var(--border2)"}
                        />
                      </div>

                      {/* Access token */}
                      <div style={{ marginBottom:20 }}>
                        <label style={{ fontSize:11, color:"var(--muted)", textTransform:"uppercase",
                          letterSpacing:"0.07em", marginBottom:5, display:"block", fontFamily:"var(--font-ui)" }}>
                          Access Token
                        </label>
                        <input
                          type="password"
                          placeholder="ghp_••••••••••••••••••••••••••••••••••••"
                          value={connectModal?.token ?? ""}
                          onChange={e => setConnectModal(c => ({...c, token:e.target.value}))}
                          style={{ width:"100%", background:"var(--bg)", border:"1px solid var(--border2)",
                            borderRadius:5, padding:"7px 10px", fontSize:12, color:"var(--text)",
                            outline:"none", boxSizing:"border-box", fontFamily:"var(--font-mono)" }}
                          onFocus={e=>e.target.style.borderColor="var(--cyan)"}
                          onBlur={e=>e.target.style.borderColor="var(--border2)"}
                        />
                        <div style={{ fontSize:10, color:"var(--dim)", marginTop:4 }}>
                          Read access only required. Token stored encrypted, never shown again.
                        </div>
                      </div>

                      <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
                        <Btn variant="ghost" onClick={() => setConnectModal(null)}>Cancel</Btn>
                        <Btn variant="primary" onClick={() => {
                          const url  = connectModal?.repoUrl ?? ""
                          const name = url.replace(/https?:\/\/[^/]+\//,"").replace(/\.git$/,"")
                          const newGit = {
                            provider: connectModal?.provider ?? "github",
                            repoUrl: url, repoName: name,
                            connectedAt: Date.now(),
                            environments:[
                              { id:`env_prod_${Date.now()}`,    branch:"main",    label:"Production", autoDeploy:false, requiresApproval:true,  lastDeployedAt:null, lastDeployedSha:null, lastDeployedBy:null, status:"pending", deployHistory:[] },
                              { id:`env_dev_${Date.now()+1}`,   branch:"dev",     label:"Dev",        autoDeploy:true,  requiresApproval:false, lastDeployedAt:null, lastDeployedSha:null, lastDeployedBy:null, status:"pending", deployHistory:[] },
                            ],
                          }
                          setGitWorkspaces(ws => ws.map(w => w.id===connectModal.wsId||w.id===ws.id ? {...w, git:newGit} : w))
                          setConnectModal(null)
                          toast.success("Repository connected", { detail: name })
                        }}>Connect</Btn>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {activeSection === "billing" && (
            <SettingsSection title="Billing" description="Manage your subscription and invoices.">
              <div style={{
                background:"var(--surface)", border:"1px solid var(--border)",
                borderRadius:8, padding:"32px", textAlign:"center", color:"var(--muted)",
              }}>
                <div style={{ fontSize:24, marginBottom:10 }}>◈</div>
                <div style={{ fontSize:14 }}>Billing portal coming soon.</div>
                <div style={{ fontSize:12, marginTop:4 }}>For now, contact billing@orionhq.dev</div>
              </div>
            </SettingsSection>
          )}

          {/* ── Danger Zone ──────────────────────────────────────────── */}
          {activeSection === "danger" && (
            <div>
              <SettingsSection title="Danger Zone">
                <div style={{
                  border:"1px solid var(--red)33", borderRadius:8, overflow:"hidden",
                }}>
                  {[
                    {
                      title:"Reset all API Keys",
                      desc:"Revoke every existing API key immediately. All integrations will break until new keys are issued.",
                      action:"Reset Keys",
                    },
                    {
                      title:"Transfer Account Ownership",
                      desc:"Assign the owner role to another admin member. You will be downgraded to admin.",
                      action:"Transfer Ownership",
                    },
                    {
                      title:"Delete Account",
                      desc:"Permanently delete this account, all workspaces, flows, executions, and members. This cannot be undone.",
                      action:"Delete Account",
                      terminal:true,
                    },
                  ].map((item, i, arr) => (
                    <div key={item.title} style={{
                      padding:"18px 20px",
                      borderBottom: i < arr.length-1 ? "1px solid var(--red)22" : "none",
                      display:"flex", alignItems:"center", justifyContent:"space-between", gap:20,
                    }}>
                      <div>
                        <div style={{ fontSize:14, color: item.terminal?"var(--red)":"var(--text)", fontWeight:500, marginBottom:3 }}>{item.title}</div>
                        <div style={{ fontSize:12, color:"var(--muted)", maxWidth:480 }}>{item.desc}</div>
                      </div>
                      <Btn variant="danger" onClick={()=>toast.error(`${item.title} — not wired in prototype`)}>
                        {item.action}
                      </Btn>
                    </div>
                  ))}
                </div>
              </SettingsSection>
            </div>
          )}

        </div>
      </div>

      {/* Modals */}
      {showInvite && (
        <InviteModal
          onClose={()=>setShowInvite(false)}
          onInvite={handleInvite}
          existingEmails={account.members.map(m=>m.email)}
        />
      )}
      {wsModal && (
        <WorkspaceModal
          workspace={wsModal === "create" ? null : wsModal}
          allMembers={account.members}
          onClose={()=>setWsModal(null)}
          onSave={saveWorkspace}
        />
      )}
      {wsMembersModal && (
        <WorkspaceModal
          workspace={wsMembersModal}
          allMembers={account.members}
          onClose={()=>setWsMembersModal(null)}
          onSave={saveWorkspace}
        />
      )}
      {credModal && (
        <CredentialModal
          credential={credModal === "create" ? null : credModal}
          workspaces={account.workspaces}
          onClose={()=>setCredModal(null)}
          onSave={saveCred}
        />
      )}
    </div>
  )
}


// ─── FLOW EDITOR ─────────────────────────────────────────────────────────────

const NODE_W = 190
const NODE_H = 68
const PORT_R = 6
