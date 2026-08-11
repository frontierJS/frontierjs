import * as vscode from 'vscode'
import { startLitestoneClient, stopLitestoneClient } from './litestone/client'
import { startMesaClient, stopMesaClient } from './mesa/client'

export async function activate(context: vscode.ExtensionContext) {
  // Litestone language client
  await startLitestoneClient(context)

  // Mesa — plain vscode providers, no server. Diagnostics need the workspace's
  // own @frontierjs/mesa; without it the other three features still work.
  await startMesaClient(context)

  // Command: restart Litestone language server
  context.subscriptions.push(
    vscode.commands.registerCommand('litestone.restartServer', async () => {
      await stopLitestoneClient()
      await startLitestoneClient(context)
      vscode.window.showInformationMessage('Litestone language server restarted.')
    })
  )
}

export async function deactivate() {
  await stopLitestoneClient()
  await stopMesaClient()
}
