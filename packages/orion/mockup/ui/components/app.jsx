import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiStatusBanner } from './api.js'
import { SESSION } from './mock.js'
import { SideNav, CommandPalette, ShortcutsModal, ToastContainer, useShortcutsModal } from './primitives.jsx'
import { FlowEditor } from './flow-editor.jsx'
import { FlowsPage, ExecutionsPage, MetricsPage, TemplatesPage, PluginsPage, ExecReviewMode } from './pages.jsx'
import { SettingsPage, SystemAdminPage, ProfilePage } from './settings.jsx'

// ─── APP SHELL ───────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab]                 = useState("Flows")
  const [execFlowFilter, setExecFlowFilter] = useState(null)
  const [editingFlowId, setEditingFlowId] = useState(null)
  const [reviewExec, setReviewExec] = useState(null)
  // Toggle this to test non-superadmin view
  const [session] = useState(SESSION)
  const [, setShortcutsOpen] = useShortcutsModal()

  // Global ? shortcut
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.target.matches("input,textarea,select")) {
        setShortcutsOpen(v => !v)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [])

  const handleViewExec = (flowId) => {
    setExecFlowFilter(flowId)
    setTab("Executions")
  }

  const handleSetTab = (t) => {
    // Guard: non-superadmins can never navigate to System
    if (t === "System" && !session.isSuperAdmin) return
    setTab(t)
    if (t !== "Executions") setExecFlowFilter(null)
  }

  return (
    <div style={{ minHeight:"100vh", background:"var(--bg)", display:"flex" }}>
      <SideNav tab={tab} setTab={handleSetTab} session={session} />
      <ApiStatusBanner />
      <CommandPalette
        onNavigate={handleSetTab}
        onEditFlow={setEditingFlowId}
        onViewExec={handleViewExec}
        session={session}
      />
      <ShortcutsModal />
      <ToastContainer />
      <main style={{ flex:1, minWidth:0, display:"flex", flexDirection:"column", overflow:"hidden", height:"100vh" }}>
        {reviewExec ? (
          <ExecReviewMode exec={reviewExec} onBack={() => setReviewExec(null)} />
        ) : editingFlowId ? (
          <FlowEditor flowId={editingFlowId} onBack={()=>setEditingFlowId(null)} />
        ) : (
          <div style={{ flex:1, overflow:"auto" }}>
            {tab === "Flows"      && <FlowsPage onViewExec={handleViewExec} onEditFlow={setEditingFlowId} onOpenTemplates={()=>setTab("Templates")} />}
            {tab === "Templates"  && <TemplatesPage onUseTemplate={(id)=>{ setEditingFlowId(id) }} />}
            {tab === "Executions" && <ExecutionsPage filterFlowId={execFlowFilter} onClearFilter={()=>setExecFlowFilter(null)} onReviewExec={setReviewExec} />}
            {tab === "Metrics"    && <MetricsPage />}
            {tab === "Plugins"    && <PluginsPage />}
            {tab === "Settings"   && <SettingsPage session={session} />}
            {tab === "System"     && session.isSuperAdmin && <SystemAdminPage setPage={setTab} />}
            {tab === "Profile"    && <ProfilePage session={session} />}
          </div>
        )}
      </main>
    </div>
  )
}


const root = document.getElementById('root')
createRoot(root).render(<App />)
