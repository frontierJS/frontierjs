// A stand-in for the `vscode` module, so the Mesa providers can be driven from
// plain node.
//
// Mesa support is NOT a language server — it calls the vscode API directly, so
// there is no stdio protocol to drive it over the way test/lsp-client.js drives
// Litestone. The alternative is @vscode/test-electron, which downloads a VS Code
// build per run.
//
// What is stubbed is only the editor: the classes the providers construct, the
// event registrations, and a TextDocument. The MESA COMPILER IS THE REAL ONE —
// the defect this suite exists for was a resolver hunting a package name that no
// longer exists, and a fake compiler would have resolved happily.
//
// Register it before requiring anything under out/:
//   require('./vscode-stub').install()

'use strict'

const Module = require('module')

// ─── Value types ──────────────────────────────────────────────────────────────

class Position {
  constructor(line, character) { this.line = line; this.character = character }
}

class Range {
  constructor(a, b, c, d) {
    if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d) }
    else { this.start = a; this.end = b }
  }
  get isEmpty() {
    return this.start.line === this.end.line && this.start.character === this.end.character
  }
}

class Diagnostic {
  constructor(range, message, severity) {
    this.range = range; this.message = message; this.severity = severity
  }
}

class MarkdownString {
  constructor(value = '') { this.value = value }
  appendMarkdown(v) { this.value += v; return this }
  appendText(v)     { this.value += v; return this }
  appendCodeblock(v, lang = '') { this.value += `\n\`\`\`${lang}\n${v}\n\`\`\`\n`; return this }
}

class Hover {
  constructor(contents, range) { this.contents = contents; this.range = range }
}

class CompletionItem {
  constructor(label, kind) { this.label = label; this.kind = kind }
}

class SnippetString {
  constructor(value = '') { this.value = value }
}

class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    this.name = name; this.detail = detail; this.kind = kind
    this.range = range; this.selectionRange = selectionRange
    this.children = []
  }
}

// The providers only ever read a member and hand it back, so the identity of an
// enum value does not matter — but an unknown member must not read `undefined`,
// which is how a typo'd kind would pass unnoticed.
const enumOf = name => new Proxy({}, {
  get: (_t, key) => {
    if (typeof key !== 'string') return undefined
    return `${name}.${key}`
  }
})

// ─── Documents ────────────────────────────────────────────────────────────────

class TextDocument {
  constructor(fsPath, text, languageId = 'mesa') {
    this._text = text
    this.languageId = languageId
    this.uri = { fsPath, scheme: 'file', path: fsPath, toString: () => `file://${fsPath}` }
    this.fileName = fsPath
  }
  getText(range) {
    if (!range) return this._text
    return this._text.slice(this.offsetAt(range.start), this.offsetAt(range.end))
  }
  get lineCount() { return this._text.split('\n').length }
  lineAt(lineOrPosition) {
    const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line
    const text = this._text.split('\n')[line] ?? ''
    return { text, lineNumber: line, range: new Range(line, 0, line, text.length) }
  }
  offsetAt(position) {
    const lines = this._text.split('\n')
    let offset = 0
    for (let i = 0; i < position.line && i < lines.length; i++) offset += lines[i].length + 1
    return offset + position.character
  }
  positionAt(offset) {
    const before = this._text.slice(0, Math.max(0, Math.min(offset, this._text.length)))
    const lines  = before.split('\n')
    return new Position(lines.length - 1, lines[lines.length - 1].length)
  }
  /** The real one returns the match that SPANS the caret, not the first on the line. */
  getWordRangeAtPosition(position, regex = /[A-Za-z_$][\w$]*/) {
    const line = this.lineAt(position.line).text
    const re   = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
    let m
    while ((m = re.exec(line)) !== null) {
      const start = m.index, end = m.index + m[0].length
      if (position.character >= start && position.character <= end)
        return new Range(position.line, start, position.line, end)
      if (m[0] === '') re.lastIndex++
    }
    return undefined
  }
}

// ─── The module ───────────────────────────────────────────────────────────────

function makeApi() {
  const listeners = {
    open: [], save: [], change: [], close: []
  }
  const register = (bucket, fn) => { listeners[bucket].push(fn); return { dispose() {} } }

  const diagnosticCollections = []
  const providers = { hover: [], completion: [], symbol: [] }
  const messages  = []
  const settings  = new Map()   // 'mesa.compilerPath' → value

  const api = {
    Position, Range, Diagnostic, MarkdownString, Hover,
    CompletionItem, SnippetString, DocumentSymbol,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CompletionItemKind: enumOf('CompletionItemKind'),
    SymbolKind:         enumOf('SymbolKind'),
    Uri: { file: p => ({ fsPath: p, toString: () => `file://${p}` }) },

    workspace: {
      textDocuments: [],
      workspaceFolders: [],
      getConfiguration: section => ({
        get: key => settings.get(`${section}.${key}`)
      }),
      onDidOpenTextDocument:   fn => register('open', fn),
      onDidSaveTextDocument:   fn => register('save', fn),
      onDidChangeTextDocument: fn => register('change', fn),
      onDidCloseTextDocument:  fn => register('close', fn)
    },

    languages: {
      createDiagnosticCollection(name) {
        const store = new Map()
        const collection = {
          name,
          set:    (uri, diags) => store.set(uri.toString(), diags),
          delete: uri => store.delete(uri.toString()),
          get:    uri => store.get(uri.toString()),
          clear:  () => store.clear(),
          dispose: () => { collection.disposed = true; store.clear() },
          _store: store
        }
        diagnosticCollections.push(collection)
        return collection
      },
      registerHoverProvider:          (sel, p) => { providers.hover.push({ sel, p }); return { dispose() {} } },
      registerCompletionItemProvider: (sel, p, ...t) => { providers.completion.push({ sel, p, triggers: t }); return { dispose() {} } },
      registerDocumentSymbolProvider: (sel, p) => { providers.symbol.push({ sel, p }); return { dispose() {} } }
    },

    window: {
      showInformationMessage: (...args) => { messages.push(args[0]); return Promise.resolve(undefined) },
      showWarningMessage:     (...args) => { messages.push(args[0]); return Promise.resolve(undefined) },
      showErrorMessage:       (...args) => { messages.push(args[0]); return Promise.resolve(undefined) }
    },

    commands: {
      executeCommand:  () => Promise.resolve(),
      registerCommand: () => ({ dispose() {} })
    },

    // ── test-facing handles (not part of the vscode API) ──
    _: { listeners, diagnosticCollections, providers, messages, settings, TextDocument }
  }
  return api
}

let api = null

/** Put the stub in the module cache so `require('vscode')` resolves to it. */
function install() {
  if (api) return api
  api = makeApi()
  const original = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return api
    return original.call(this, request, parent, isMain)
  }
  return api
}

/** An ExtensionContext with just the two members the clients touch. */
function extensionContext(extensionPath) {
  return { subscriptions: [], extensionPath, extensionUri: { fsPath: extensionPath } }
}

module.exports = { install, extensionContext, TextDocument, Position, Range }
