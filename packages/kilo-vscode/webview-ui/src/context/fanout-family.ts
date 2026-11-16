import { createStore } from "solid-js/store"

type Row = { running: number; ids: string[] }

const [state, setState] = createStore<Record<string, Record<string, Row>>>({})

/** Remember one script's children so permission routing and the header count stay current. */
export function noteFanout(parentID: string, scriptID: string, sessionIds: readonly string[], running: number) {
  setState(parentID, (prev) => ({
    ...(prev ?? {}),
    [scriptID]: { running, ids: [...sessionIds] },
  }))
}

export function fanoutScriptRunning(parentID: string | undefined, scriptID: string): number | undefined {
  if (!parentID) return
  return state[parentID]?.[scriptID]?.running
}

export function fanoutIds(parentID: string | undefined): readonly string[] {
  if (!parentID) return []
  const rows = state[parentID]
  if (!rows) return []
  return [...new Set(Object.values(rows).flatMap((row) => row.ids))]
}
