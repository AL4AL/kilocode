import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useData, type FanoutJob } from "../context/data"
import { AgentAvatar, AgentAvatarPalette } from "./agent-avatar"

const ROW = 28
const VIEW = 240
const PAGE = 50

export function SpawnRoster(props: {
  scriptId: string
  pending?: number
  running?: number
  done?: number
  failed?: number
}) {
  const data = useData()
  const [rows, setRows] = createSignal<FanoutJob[]>([])
  const seeded = () => (props.pending ?? 0) + (props.running ?? 0) + (props.done ?? 0) + (props.failed ?? 0)
  const [total, setTotal] = createSignal(seeded())
  const [scroll, setScroll] = createSignal(0)

  createEffect(() => {
    if (rows().length > 0) return
    setTotal(seeded())
  })

  const load = (offset: number) => {
    const fanout = data.fanout
    if (!fanout) return
    void fanout(props.scriptId, offset, PAGE).then((page) => {
      if (!page) return
      setTotal(page.total)
      setRows((prev) => {
        const next = prev.slice()
        page.jobs.forEach((job, index) => {
          next[page.offset + index] = job
        })
        next.length = page.total
        return next
      })
    })
  }

  createEffect(() => {
    load(0)
    const timer = setInterval(() => load(Math.floor(scroll() / ROW / PAGE) * PAGE), 2000)
    onCleanup(() => clearInterval(timer))
  })

  const start = createMemo(() => Math.max(0, Math.floor(scroll() / ROW) - 4))
  const end = createMemo(() => Math.min(total(), start() + Math.ceil(VIEW / ROW) + 8))
  const visible = createMemo(() => {
    const from = start()
    const to = end()
    if (from > 0 && rows()[from] == null) load(Math.floor(from / PAGE) * PAGE)
    return rows()
      .slice(from, to)
      .map((job, index) => ({ job, index: from + index }))
      .filter((item): item is { job: FanoutJob; index: number } => item.job != null)
  })

  return (
    <div data-component="spawn-roster" data-spawn-script={props.scriptId}>
      <Show when={data.fanout}>
        <div
          data-slot="spawn-view"
          style={{ height: `${Math.min(VIEW, Math.max(ROW, total() * ROW))}px` }}
          onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
        >
          <div data-slot="spawn-roster-track" style={{ height: `${total() * ROW}px` }}>
            <AgentAvatarPalette ids={visible().flatMap((item) => (item.job.sessionId ? [item.job.sessionId] : []))}>
              <For each={visible()}>
                {(item) => (
                  <button
                    type="button"
                    data-slot="spawn-row"
                    style={{ top: `${item.index * ROW}px` }}
                    disabled={!item.job.sessionId}
                    onClick={() => {
                      const id = item.job.sessionId
                      if (id) data.navigateToSession?.(id)
                    }}
                  >
                    <AgentAvatar id={item.job.sessionId ?? item.job.id} status={item.job.status === "running" ? "running" : undefined} />
                    <span>{item.job.title || item.job.label}</span>
                  </button>
                )}
              </For>
            </AgentAvatarPalette>
          </div>
        </div>
      </Show>
    </div>
  )
}
