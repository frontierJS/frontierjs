// mesa/client.ts
// Activates all Mesa (.mesa) language support features:
//   ✓  Syntax highlighting    — via mesa.tmLanguage.json (grammar)
//   ✓  Compiler diagnostics   — errors + warnings as you type/save
//   ✓  Hover documentation    — $context, $async, directives, builtins
//   ✓  Completions            — $, {, :, |, < trigger characters
//   ✓  Document symbols       — outline panel (Props / State / Derived / ...)
//   ✓  Snippets               — full component structure snippets
//
// Unlike Litestone (which uses LSP), Mesa uses the simpler vscode API directly.
// The compiler is resolved at runtime from node_modules or workspace root.

import * as vscode from 'vscode'
import * as path   from 'path'

// Mesa implementation — plain JS modules (no compilation overhead)
/* eslint-disable @typescript-eslint/no-var-requires */
const { provideHover }           = require('./hover')
const { provideCompletionItems } = require('./completions')
const { provideDocumentSymbols } = require('./symbols')
/* eslint-enable @typescript-eslint/no-var-requires */

// ─── State ────────────────────────────────────────────────────────────────────

let diagnosticCollection: vscode.DiagnosticCollection | null = null
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
let _compile: Function | null = null
let _compilerNotFoundShown    = false

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startMesaClient(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection('mesa')
  context.subscriptions.push(diagnosticCollection)

  // Validate all currently open .mesa files immediately
  vscode.workspace.textDocuments.forEach(validateIfMesa)

  // Validate on open
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(validateIfMesa)
  )

  // Validate on save — immediate, no debounce
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.languageId !== 'mesa') return
      cancelDebounce(doc.uri.toString())
      validate(doc)
    })
  )

  // Validate on change — debounced (respects mesa.validateOnType + mesa.validateDelay)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      const doc = event.document
      if (doc.languageId !== 'mesa') return
      const config = vscode.workspace.getConfiguration('mesa')
      if (!config.get('validateOnType')) return
      const delay = (config.get('validateDelay') as number) ?? 300
      const key   = doc.uri.toString()
      cancelDebounce(key)
      debounceTimers.set(key, setTimeout(() => {
        debounceTimers.delete(key)
        validate(doc)
      }, delay))
    })
  )

  // Clear diagnostics on close
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(doc => {
      if (doc.languageId !== 'mesa') return
      cancelDebounce(doc.uri.toString())
      diagnosticCollection?.delete(doc.uri)
    })
  )

  // Hover documentation
  context.subscriptions.push(
    vscode.languages.registerHoverProvider('mesa', { provideHover })
  )

  // Completions — trigger on $ { : | <
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      'mesa',
      { provideCompletionItems },
      '$', '{', ':', '|', '<'
    )
  )

  // Document symbols (outline panel: Props / Reactive State / Derived / ...)
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider('mesa', { provideDocumentSymbols })
  )

  console.log('[FrontierJS] Mesa language support activated')
}

export async function stopMesaClient() {
  for (const timer of debounceTimers.values()) clearTimeout(timer)
  debounceTimers.clear()
  diagnosticCollection?.dispose()
  diagnosticCollection = null
  _compile = null
  _compilerNotFoundShown = false
}

// ─── Compiler resolution ──────────────────────────────────────────────────────
// Search order:
//   1. mesa.compilerPath setting (explicit)
//   2. node_modules/@mesa/compiler/compiler.js in each workspace folder
//   3. node_modules/mesa/compiler.js in each workspace folder
//   4. compiler.js at each workspace folder root
//   5. Walk up from the currently active file (monorepo support)
//   6. compiler.js next to the extension itself (dev/F5 mode)

async function resolveCompiler(triggerFilePath?: string): Promise<Function | null> {
  if (_compile) return _compile

  const config       = vscode.workspace.getConfiguration('mesa')
  const explicitPath = config.get<string>('compilerPath')
  const candidates:  string[] = []

  if (explicitPath) candidates.push(explicitPath)

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath
    candidates.push(
      path.join(root, 'node_modules', '@mesa', 'compiler', 'compiler.js'),
      path.join(root, 'node_modules', 'mesa', 'compiler.js'),
      path.join(root, 'compiler.js')
    )
  }

  if (triggerFilePath) {
    let dir = path.dirname(triggerFilePath)
    const fsRoot = path.parse(dir).root
    while (dir !== fsRoot) {
      candidates.push(
        path.join(dir, 'node_modules', '@mesa', 'compiler', 'compiler.js'),
        path.join(dir, 'node_modules', 'mesa', 'compiler.js'),
        path.join(dir, 'compiler.js')
      )
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  candidates.push(path.join(__dirname, '..', '..', 'compiler.js'))

  const { existsSync }    = require('fs')
  const { pathToFileURL } = require('url')
  const seen = new Set<string>()

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    if (!existsSync(candidate)) continue
    try {
      const mod = await import(pathToFileURL(candidate).href)
      if (typeof mod.compile === 'function') {
        _compile = mod.compile
        console.log(`[FrontierJS] Mesa compiler loaded: ${candidate}`)
        return _compile
      }
    } catch (err: any) {
      console.warn(`[FrontierJS] Failed to load Mesa compiler at ${candidate}: ${err.message}`)
    }
  }
  return null
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateIfMesa(doc: vscode.TextDocument) {
  if (doc.languageId === 'mesa') validate(doc)
}

async function validate(doc: vscode.TextDocument) {
  const compile = await resolveCompiler(doc.uri.fsPath)

  if (!compile) {
    if (!_compilerNotFoundShown) {
      _compilerNotFoundShown = true
      const choice = await vscode.window.showInformationMessage(
        'Mesa: compiler.js not found. Diagnostics disabled.',
        'Set Path', 'How?'
      )
      if (choice === 'Set Path')
        vscode.commands.executeCommand('workbench.action.openSettings', 'mesa.compilerPath')
      else if (choice === 'How?')
        vscode.window.showInformationMessage(
          'Add "mesa.compilerPath": "/path/to/compiler.js" to your settings, ' +
          'or place compiler.js at your workspace root.'
        )
    }
    return
  }

  _compilerNotFoundShown = false
  const source      = doc.getText()
  const diagnostics: vscode.Diagnostic[] = []
  const warnings:    string[] = []

  let ctx: any
  try {
    ctx = await compile(source, { debug: false, css: false, warning: (w: any) => warnings.push(w.message ?? String(w)) })
  } catch (err: any) {
    diagnostics.push(new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, Number.MAX_VALUE),
      `Mesa parse error: ${err.message}`,
      vscode.DiagnosticSeverity.Error
    ))
    diagnosticCollection?.set(doc.uri, diagnostics)
    return
  }

  const scriptOffset = findScriptContentOffset(source)

  for (const msg of [...(ctx.analysis?.errors ?? []), ...(ctx.analysis?.warnings ?? [])]) {
    const sev   = ctx.analysis.errors.includes(msg) ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
    const range = findRangeForMessage(doc, msg, source, scriptOffset, ctx.analysis)
    const diag  = new vscode.Diagnostic(range, msg, sev)
    diag.source = 'Mesa'
    diagnostics.push(diag)
  }

  const seen = new Set(diagnostics.map(d => d.message))
  for (const msg of warnings) {
    if (seen.has(msg)) continue
    const range = findRangeForMessage(doc, msg, source, scriptOffset, ctx.analysis)
    const diag  = new vscode.Diagnostic(range, msg, vscode.DiagnosticSeverity.Warning)
    diag.source = 'Mesa'
    diagnostics.push(diag)
  }

  diagnosticCollection?.set(doc.uri, diagnostics)
}

// ─── Position helpers ─────────────────────────────────────────────────────────

function findScriptContentOffset(source: string): number {
  const match = source.match(/<script[^>]*>/)
  return match ? (match.index! + match[0].length) : 0
}

function findRangeForMessage(doc: vscode.TextDocument, message: string, source: string, scriptOffset: number, analysis: any): vscode.Range {
  if (analysis?.vars) {
    for (const [name, v] of Object.entries<any>(analysis.vars)) {
      if (messageIsAbout(message, name) && v.nodeStart != null) {
        return rangeFromOffsets(doc, scriptOffset + v.nodeStart, scriptOffset + (v.nodeEnd ?? v.nodeStart + name.length))
      }
    }
  }
  for (const [, id] of [...message.matchAll(/'([^']+)'/g)]) {
    if (id.length < 2 || id.length > 80) continue
    if (['let','const','var','export','bind','on','function'].includes(id)) continue
    const idx = findBestOccurrence(source, id)
    if (idx !== -1) return rangeFromOffsets(doc, idx, idx + id.length)
  }
  return new vscode.Range(0, 0, 0, 0)
}

function messageIsAbout(message: string, name: string): boolean {
  return message.includes(`'${name}'`) || message.includes(`"${name}"`) ||
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(message)
}

function findBestOccurrence(source: string, needle: string): number {
  let fallback = -1, search = 0
  while (true) {
    const found = source.indexOf(needle, search)
    if (found === -1) break
    const before = source[found - 1], after = source[found + needle.length]
    if ((!before || /[\s{(=,\n]/.test(before)) && (!after || /[\s}),\n=:;]/.test(after))) return found
    if (fallback === -1) fallback = found
    search = found + 1
  }
  return fallback
}

function rangeFromOffsets(doc: vscode.TextDocument, start: number, end: number): vscode.Range {
  try { return new vscode.Range(doc.positionAt(Math.max(0, start)), doc.positionAt(Math.max(0, end))) }
  catch { return new vscode.Range(0, 0, 0, 0) }
}

function cancelDebounce(key: string) {
  const timer = debounceTimers.get(key)
  if (timer != null) { clearTimeout(timer); debounceTimers.delete(key) }
}
