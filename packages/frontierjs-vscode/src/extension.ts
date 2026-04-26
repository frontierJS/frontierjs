import * as vscode from 'vscode'
import { startLitestoneClient, stopLitestoneClient } from './litestone/client'
// import { startMesaClient, stopMesaClient } from './mesa/client'  // uncomment when ready

export async function activate(context: vscode.ExtensionContext) {
  // Litestone language client
  await startLitestoneClient(context)

  // MESA language client — uncomment when ready
  // await startMesaClient(context)

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
  // await stopMesaClient()
}
