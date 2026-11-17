import { Effect, Schema } from "effect"
import { Tool } from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./spawn-script.txt"
import { FanoutStore } from "@/kilocode/fanout/store"
import type { ReportMode } from "@/kilocode/fanout/report"
import { runScript } from "@/kilocode/fanout/script"
import { armFanoutResume } from "@/kilocode/fanout/resume"

const DEFAULT_CAP = 4
const MAX_CAP = 64
const ROLLUP_AT = 10

const Params = Schema.Struct({
  script: Schema.String.annotate({
    description:
      "JavaScript (strict). Only spawn exists—no require/import. spawn(prompt, opts?) or spawn({ prompt, label, paths, isolate }). One spawn per unit of work; await is optional.",
  }),
  cap: Schema.optional(Schema.Number).annotate({
    description: "How many children run at once. Defaults to 4. Further spawn() calls wait.",
  }),
  isolate: Schema.optional(Schema.Boolean).annotate({
    description: "Give every child its own git worktree. A spawn() call can still set isolate for one child.",
  }),
  report: Schema.optional(Schema.Literals(["each", "rollup", "none"])).annotate({
    description:
      "How child results return to this chat: each (one synthetic message per child), rollup (one summary when all finish; default when >10 children), or none (roster only).",
  }),
})

type Meta = {
  scriptId: string
  pending: number
  running: number
  done: number
  failed: number
  inboxQueued?: number
  report?: ReportMode
}

function cap(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return DEFAULT_CAP
  return Math.min(MAX_CAP, Math.max(1, Math.floor(value)))
}

function reportMode(total: number, value: ReportMode | undefined): ReportMode {
  if (value) return value
  return total > ROLLUP_AT ? "rollup" : "each"
}

export const SpawnScriptTool = Tool.define<typeof Params, Meta, never, "spawn_script">(
  "spawn_script",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Params,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        yield* ctx.ask({
          permission: "spawn_script",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })
        const directory = yield* InstanceState.directory
        const id = crypto.randomUUID()
        const limit = cap(params.cap)
        yield* Effect.promise(() =>
          FanoutStore.open({
            id,
            parentID: ctx.sessionID,
            directory,
            cap: limit,
            agent: ctx.agent,
            messageID: ctx.messageID,
            callID: ctx.callID,
          }),
        )
        const ran = yield* Effect.tryPromise({
          try: () =>
            runScript(params.script, async (call) => {
              await FanoutStore.addJob(id, {
                id: crypto.randomUUID(),
                label: call.label,
                prompt: call.prompt,
                paths: call.paths,
                isolate: params.isolate === true || call.isolate,
                status: "pending",
                attempt: 0,
              })
            }),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          Effect.ensuring(Effect.sync(() => armFanoutResume())),
          Effect.match({
            onFailure: (err) => err,
            onSuccess: () => undefined,
          }),
        )
        const counts = FanoutStore.counts(id)
        const total = counts.pending + counts.running + counts.done + counts.failed
        const mode = reportMode(total, params.report)
        yield* Effect.promise(() => FanoutStore.patchScript(id, { report: mode }))
        if (ran) {
          return {
            title: "Spawn script failed",
            metadata: { scriptId: id, ...counts },
            output: ran.message,
          }
        }
        const title = total === 1 ? "Queued 1 child" : `Queued ${total} children`
        const meta: Meta = { scriptId: id, ...counts, report: mode, inboxQueued: 0 }
        yield* ctx.metadata({
          title,
          metadata: meta,
        })
        const reportLine =
          mode === "none"
            ? "Report mode none: results stay on the spawn card only."
            : mode === "rollup"
              ? "Report mode rollup: one combined summary arrives when every child has finished (when you are idle)."
              : "Report mode each: one synthetic message per child, queued one per idle turn."
        return {
          title,
          metadata: meta,
          output: [
            `${title} (script ${id}).`,
            `Counts: ${counts.pending} pending, ${counts.running} running, ${counts.done} done, ${counts.failed} failed.`,
            reportLine,
            `Up to ${limit} children run at once.`,
            "Children use this workspace unless you set isolate. Each is a full agent (write, bash, etc.).",
            "This tool result only confirms enqueue. Watch the spawn_script card for live status and queued reports.",
            "Each child must end with: FANOUT_RESULT ok <summary> or FANOUT_RESULT fail <reason>.",
            "Do not poll, sleep, list dirs, or call task/spawn_script again for the same batch.",
            "Children keep running if the network drops or the editor closes.",
            "Stop on this chat cancels pending and running spawn children for this session.",
          ].join("\n"),
        }
      }),
  }),
)
