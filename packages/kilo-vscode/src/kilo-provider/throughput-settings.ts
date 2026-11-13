import * as vscode from "vscode"

type Post = (msg: unknown) => void

export function buildThroughputSettingMessage() {
  const config = vscode.workspace.getConfiguration("kilo-code-surge.new")
  return {
    type: "throughputSettingLoaded" as const,
    visible: config.get<boolean>("showTokenThroughput", true),
  }
}

export function watchThroughputConfig(post: Post): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("kilo-code-surge.new.showTokenThroughput")) {
      post(buildThroughputSettingMessage())
    }
  })
}
