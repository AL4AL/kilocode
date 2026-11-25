import { createNativeStore } from "./store"
import type { NativeEvent } from "./contracts"
import { createProviderRegistry, type NativeSecretStorage } from "./providers"
import { createSessionEngine } from "./sessions"
import { createWorkspaceTools } from "./tools"
import { createNativeConfig } from "./configuration"
import { createNativeMcpService } from "./mcp-registry"

type Listener = (event: NativeEvent) => void
type Options = { root: string; secrets: NativeSecretStorage; trusted: () => boolean; onError?: (err: unknown) => void }

export function createNativeRuntime(options: Options) {
  const store = createNativeStore(options.root)
  const listeners = new Set<Listener>()
  let disposed = false
  const report =
    options.onError ?? ((err: unknown) => console.error("[Kilo New] Native runtime event listener failed:", err))
  const emit = (event: NativeEvent) => {
    if (disposed) return
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (err) {
        report(err)
      }
    }
  }
  const providers = createProviderRegistry(options.secrets, emit)
  const config = createNativeConfig(store, emit)
  const tools = createWorkspaceTools(store, options.trusted, emit)
  const mcp = createNativeMcpService(store, options.secrets, (dir, server) => tools.authorizeMcp(dir, server), emit)
  tools.useMcp(mcp)
  const sessions = createSessionEngine(store, providers, tools, config, emit)

  return {
    store,
    providers,
    config,
    sessions,
    tools,
    mcp,
    onEvent(listener: Listener) {
      if (disposed) throw new Error("Native runtime is disposed")
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit,
    dispose() {
      disposed = true
      listeners.clear()
      sessions.dispose()
      tools.dispose()
      providers.dispose()
      void mcp.dispose().catch(report)
    },
  }
}
