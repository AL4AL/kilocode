import { createEffect, createMemo, onCleanup, For, Show } from "solid-js"
import { useLanguage } from "../../context/language"
import { useSession } from "../../context/session"
import { useVSCode } from "../../context/vscode"
import { fanoutScriptRunning } from "../../context/fanout-family"
import { spawnStrips } from "./background-agents"

/** Keep the header count and the permission family current while this chat is open. */
export function useFanoutPoll() {
  const session = useSession()
  const vscode = useVSCode()
  createEffect(() => {
    const sessionID = session.currentSessionID()
    const scripts = sessionID ? spawnStrips(session.getSessionToolParts(sessionID)) : []
    if (!sessionID || scripts.length === 0) return
    let n = 0
    const send = () => {
      for (const row of scripts) {
        vscode.postMessage({
          type: "requestFanout",
          requestID: `strip-${sessionID}-${row.scriptId}-${++n}`,
          scriptID: row.scriptId,
          sessionID,
          offset: 0,
          limit: 1,
        })
      }
    }
    send()
    const timer = setInterval(send, 2000)
    onCleanup(() => clearInterval(timer))
  })
}

/** One summary for a spawn script. A click scrolls to its card. */
export function SpawnStrip() {
  const session = useSession()
  const language = useLanguage()
  const rows = createMemo(() => {
    const id = session.currentSessionID()
    if (!id) return []
    return spawnStrips(session.getSessionToolParts(id))
      .map((row) => {
        const live = fanoutScriptRunning(id, row.scriptId)
        return { ...row, running: live ?? row.running }
      })
      .filter((row) => row.running > 0)
  })

  const open = (id: string) => {
    document.querySelector(`[data-part-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" })
  }

  return (
    <Show when={rows().length > 0}>
      <For each={rows()}>
        {(row) => (
          <button type="button" data-component="spawn-strip" onClick={() => open(row.id)}>
            {language.t("task.spawn.running", { count: String(row.running) })}
          </button>
        )}
      </For>
    </Show>
  )
}
