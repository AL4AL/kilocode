import { Effect, Schema } from "effect"
import { Tool } from "@/tool/tool"
import { answer } from "@/kilocode/fanout/scope"
import DESCRIPTION from "./scope-reply.txt"

const Params = Schema.Struct({
  id: Schema.String.annotate({ description: "Scope request id from the mailbox." }),
  answer: Schema.Literals(["allow", "deny", "patch"]).annotate({
    description: "allow lets the requester edit the path. deny refuses it. patch means you will make the change yourself.",
  }),
})

type Meta = { id: string; answer: "allow" | "deny" | "patch" }

export const ScopeReplyTool = Tool.define<typeof Params, Meta, never, "scope_reply">(
  "scope_reply",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Params,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        const mail = yield* Effect.tryPromise({
          try: () => answer(ctx.sessionID, params.id, params.answer),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }).pipe(
          Effect.match({
            onFailure: (err) => err,
            onSuccess: (value) => value,
          }),
        )
        if (mail instanceof Error) {
          return { title: "Scope reply failed", metadata: { id: params.id, answer: params.answer }, output: mail.message }
        }
        return {
          title: `Scope ${params.answer}`,
          metadata: { id: params.id, answer: params.answer },
          output: `Request ${params.id} is ${params.answer}.`,
        }
      }),
  }),
)
