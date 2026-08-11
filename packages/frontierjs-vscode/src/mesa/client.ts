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

// The three providers are plain JS. They are imported, not require()d, so that
// esbuild pulls them into the packaged bundle — a computed require would be left
// alone and the marketplace copy would throw on the first hover.
import { provideHover }           from './hover'
import { provideCompletionItems } from './completions'
import { provideDocumentSymbols } from './symbols'

// The compiler is ESM. `await import(p)` is rewritten to a require() by tsc under
// module:commonjs, and require() of an ESM file throws in the extension host —
// so the specifier has to be opaque to both compilers.
const dynamicImport: (specifier: string) => Promise<any> =
  new Function('specifier', 'return import(specifier)') as any

// ─── State ────────────────────────────────────────────────────────────────────

let diagnosticCollection: vscode.DiagnosticCollection | null = null
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
let _compile: Function | null = null
let _compilerNotFoundShown    = false
let _extensionPath            = ''

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startMesaClient(context: vscode.ExtensionContext) {
  // The sibling-package fallback below is relative to the extension root, which
  // __dirname does not give: it is out/ in the packaged bundle and out/mesa/ in
  // the tsc output, two different depths.
  _extensionPath      = context.extensionPath
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
  _extensionPath = ''
}

// ─── Compiler resolution ──────────────────────────────────────────────────────
// The package is `@frontierjs/mesa` and its entry is src/compiler.js — it was
// `@mesa/compiler/compiler.js` when this file was written, so every candidate
// missed and the diagnostics silently offered to be configured instead.
// Search order:
//   1. mesa.compilerPath setting (explicit — a file, or a directory to probe)
//   2. each workspace folder
//   3. every directory from the edited file up to the filesystem root (monorepo)
//   4. a sibling packages/mesa next to the extension itself (dev/F5 in this repo)

/** The places a mesa checkout hides under one directory, in probe order. */
function compilerEntriesUnder(dir: string): string[] {
  return [
    path.join(dir, 'node_modules', '@frontierjs', 'mesa', 'src', 'compiler.js'),
    path.join(dir, 'packages', 'mesa', 'src', 'compiler.js'),
    path.join(dir, 'src', 'compiler.js'),
    path.join(dir, 'compiler.js')
  ]
}

async function resolveCompiler(triggerFilePath?: string): Promise<Function | null> {
  if (_compile) return _compile

  const config       = vscode.workspace.getConfiguration('mesa')
  const explicitPath = config.get<string>('compilerPath')
  const candidates:  string[] = []

  const { existsSync, statSync } = require('fs')

  if (explicitPath) {
    // A setting naming the package directory rather than the file is the likelier
    // typo of the two, and it costs one stat to accept.
    const isDir = existsSync(explicitPath) && statSync(explicitPath).isDirectory()
    if (isDir) candidates.push(...compilerEntriesUnder(explicitPath))
    else candidates.push(explicitPath)
  }

  for (const folder of vscode.workspace.workspaceFolders ?? [])
    candidates.push(...compilerEntriesUnder(folder.uri.fsPath))

  if (triggerFilePath) {
    let dir = path.dirname(triggerFilePath)
    while (true) {
      candidates.push(...compilerEntriesUnder(dir))
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  if (_extensionPath)
    candidates.push(path.join(_extensionPath, '..', 'mesa', 'src', 'compiler.js'))

  const { pathToFileURL } = require('url')
  const seen = new Set<string>()

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    if (!existsSync(candidate)) continue
    try {
      const mod = await dynamicImport(pathToFileURL(candidate).href)
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

// A QUOTED name is the compiler naming the thing it is complaining about; the
// prose around it is not. Matching a declared variable on a word boundary
// anywhere in the message underlined `let a = 1` for
// `bind:group={missing} — 'missing' must be a top-level let variable`, because
// "must be a top-level" contains a standalone `a`. Single-letter names are
// ordinary, so the wrong line was underlined with nothing looking wrong.
function findRangeForMessage(doc: vscode.TextDocument, message: string, source: string, scriptOffset: number, analysis: any): vscode.Range {
  const quoted = [...message.matchAll(/'([^']+)'/g)]
    .map(m => m[1])
    .filter(id => id.length >= 2 && id.length <= 80)
    .filter(id => !['let','const','var','export','bind','on','function'].includes(id))

  for (const id of quoted) {
    const v = analysis?.vars?.[id]
    if (v?.nodeStart != null)
      return rangeFromOffsets(doc, scriptOffset + v.nodeStart, scriptOffset + (v.nodeEnd ?? v.nodeStart + id.length))
    const idx = findBestOccurrence(source, id)
    if (idx !== -1) return rangeFromOffsets(doc, idx, idx + id.length)
  }

  // Only when the message quotes nothing is a bare mention worth trusting.
  if (!quoted.length && analysis?.vars) {
    for (const [name, v] of Object.entries<any>(analysis.vars)) {
      if (v.nodeStart != null && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(message))
        return rangeFromOffsets(doc, scriptOffset + v.nodeStart, scriptOffset + (v.nodeEnd ?? v.nodeStart + name.length))
    }
  }

  return new vscode.Range(0, 0, 0, 0)
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
