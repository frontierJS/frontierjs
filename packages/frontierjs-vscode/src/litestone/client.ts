// litestone/client.ts
// Starts and manages the Litestone Language Server process.
// VS Code talks to this process via the Language Server Protocol over stdio.
//
// What this file does:
//   - Locates the server entry point (src/litestone/server.ts compiled to out/)
//   - Spawns it as a Node.js child process
//   - Registers the language client with VS Code (handles diagnostics, completions,
//     hover, formatting, go-to-definition etc. automatically via LSP)

import * as path from 'path'
import * as vscode from 'vscode'
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node'

let client: LanguageClient | null = null

export async function startLitestoneClient(context: vscode.ExtensionContext) {
  const serverModule = context.asAbsolutePath(
    path.join('out', 'litestone', 'server.js')
  )

  // --inspect-brk=6009 enables attaching a debugger to the server process
  const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] }

  // Pass litestone.parserPath setting to the build-parser script via env var.
  // The server itself uses the pre-built bundle — this is only needed when
  // the user has a non-standard monorepo layout and re-runs build:parser manually.
  const parserPath = vscode.workspace
    .getConfiguration('litestone')
    .get<string>('parserPath', '')

  const env = parserPath
    ? { ...process.env, LITESTONE_SRC: parserPath }
    : process.env

  const serverOptions: ServerOptions = {
    run:   { module: serverModule, transport: TransportKind.ipc, options: { env } },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { ...debugOptions, env } },
  }

  const clientOptions: LanguageClientOptions = {
    // Activate for .lite and .litestone files
    documentSelector: [
      { scheme: 'file', language: 'litestone' },
    ],
    synchronize: {
      // Re-validate when any .lite file in the workspace changes
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{lite,litestone}'),
    },
  }

  client = new LanguageClient(
    'litestone',
    'Litestone Language Server',
    serverOptions,
    clientOptions
  )

  await client.start()

  // Format on save (respects litestone.formatOnSave setting)
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument(event => {
      if (event.document.languageId !== 'litestone') return
      const cfg = vscode.workspace.getConfiguration('litestone', event.document.uri)
      if (!cfg.get<boolean>('formatOnSave', true)) return
      event.waitUntil(
        vscode.commands.executeCommand<vscode.TextEdit[]>(
          'vscode.executeFormatDocumentProvider',
          event.document.uri,
          { insertSpaces: true, tabSize: 2 }
        ).then(edits => edits ?? [])
      )
    })
  )

  // litestone.format command — explicit format via command palette
  context.subscriptions.push(
    vscode.commands.registerCommand('litestone.format', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.document.languageId !== 'litestone') {
        vscode.window.showWarningMessage('Litestone: open a .lite file to format.')
        return
      }
      await vscode.commands.executeCommand('editor.action.formatDocument')
    })
  )
}

export async function stopLitestoneClient() {
  if (client) {
    await client.stop()
    client = null
  }
}
