# Replace CLI/SDK Backend with Native VS Code Runtime

## Goal

Replace the VS Code extension's local `kilo serve` process and bundled CLI with an extension-host JavaScript runtime. The final VSIX must contain zero bytes of the `kilo` executable, must not launch or require a local Kilo backend, and must add no package dependencies. Use existing VS Code/Node APIs, existing workspace packages, and direct network APIs where needed.

Preserve VS Code product behavior: agent loop, sessions, tools, permissions/questions, built-in provider protocols and auth, Kilo cloud integrations, MCP (local and remote), agents/skills, indexing/search, browser/LSP integrations, and Agent Manager/worktrees. CLI/TUI-only interfaces are out of scope.

## Current State

**Already built (native runtime)** — `packages/kilo-vscode/src/services/native-runtime/`:
- `store.ts` — atomic file storage under `globalStorage/native-runtime/v1`, crash-safe
- `sessions.ts` — create/list/get/messages/delete/abort/prompt with persisted state
- `tools.ts` — read_file/write_file/edit_file/create_directory/run_command/ask_user with permission gates
- `providers.ts` — OpenAI-compatible, OpenAI-responses, Anthropic, Google + Kilo Gateway device auth
- `configuration.ts` — per-directory native config
- `mcp-registry.ts` + `mcp.ts` — per-directory stdio/Streamable HTTP MCP
- `runtime.ts` — composes store, providers, config, tools, MCP, sessions; emits `NativeEvent`
- `contracts.ts` — NativeSession, NativeMessage, NativePart, NativeEvent types

**Already built (bridge)** — `packages/kilo-vscode/src/kilo-provider/native-session-bridge.ts`:
- Maps native events → webview message contracts (sessionCreated/Updated/Deleted, messageCreated, partUpdated, permissionRequest/Resolved, questionRequest/Resolved, sessionTurnClosed, sessionError)
- Provides `create`, `list`, `messages`, `prompt`, `abort`, `delete`, `replyPermission`, `replyQuestion`, `dispose`

**Already wired (connection-service)** — `connection-service.ts:217-238`:
- `getNativeRuntime()` lazily creates the native runtime
- `createNativeSessionBridge(dir, post)` creates a per-directory bridge
- But **nothing calls these** — KiloProvider still uses `this.client` (SDK backed by `kilo serve`)

**Still using CLI/SDK** — `KiloProvider.ts` has ~23 direct `this.client.*` SDK calls plus ~40 indirect calls through handler files, agent-manager, services. ~86 files import `@kilocode/sdk` types.

**Build pipeline** — `build.ts` and `local-bin.ts` copy `bin/kilo` CLI binary, tree-sitter resources, bwrap, sandbox worker into the VSIX.

## Plan File

This plan file: `.kilo/plans/1795384271164-native-vscode-runtime-cutover.md`

## Phase 1: Core cutover — wire native runtime into KiloProvider

**Goal:** Make the core chat flow (create session, send/stream message, load messages, tools, providers, config, delete/abort) work through the native runtime + bridge instead of the SDK client.

### 1.1 Add `getNativeRuntime()` accessor to KiloProvider

Add a private getter that delegates to `this.connectionService.getNativeRuntime()`. Replace all `this.client` null-checks with `this.nativeRuntime` null-checks.

Files: `packages/kilo-vscode/src/KiloProvider.ts`

### 1.2 Create per-provider native session bridge

In `KiloProvider`, create a `createNativeSessionBridge(dir, post)` call during connection setup. The bridge's `post` callback sends webview messages. Store one bridge per directory (keyed by directory path).

Files: `packages/kilo-vscode/src/KiloProvider.ts`

### 1.3 Replace SDK session calls with native runtime

| SDK call | Native replacement | File |
|---|---|---|
| `client.session.create` | `runtime.sessions.create` | KiloProvider.ts:2320 |
| `client.session.get` | `runtime.sessions.get` | KiloProvider.ts:2359, 2390 |
| `client.session.list` | `runtime.sessions.list` | KiloProvider.ts:2634 |
| `client.session.delete` | `runtime.sessions.delete` | KiloProvider.ts:2811 |
| `client.session.abort` | `runtime.sessions.abort` | via bridge.abort |
| `client.session.promptAsync` | `bridge.prompt` / `runtime.sessions.prompt` | KiloProvider.ts:4904 |
| `client.session.command` | Map to `runtime.sessions.prompt` with `/` prefix | KiloProvider.ts:4992 |
| `client.session.messages` | `runtime.sessions.messages` | via bridge.messages |

Files: `packages/kilo-vscode/src/KiloProvider.ts`, `kilo-provider/session-page.ts`, `kilo-provider/message-page.ts`, `kilo-provider/session-search.ts`, `kilo-provider/file-search.ts`

### 1.4 Replace SDK tool/permission/question calls

| SDK call | Native replacement | File |
|---|---|---|
| `client.permission.list/reply` | `runtime.tools.replyPermission` + store-based list | connection-service.ts:718 |
| `client.question.list/reject` | `runtime.tools.replyQuestion` + store-based list | connection-service.ts:718 |
| `client.suggestion.list/dismiss` | Native runtime (implement) | connection-service.ts:1157 |
| `client.network.list/reject` | Native runtime (implement or skip) | connection-service.ts:78 |

Files: `packages/kilo-vscode/src/services/cli-backend/connection-service.ts`

### 1.5 Replace SDK provider calls

| SDK call | Native replacement | File |
|---|---|---|
| `client.config.providers` | `runtime.providers.list` | provider-actions.ts |
| `client.auth.set/remove` | `runtime.providers.connect/disconnect/connectDevice` | kilo-provider/handlers/auth.ts |
| `client.mcp.*` | `runtime.mcp.*` | kilo-provider/mcp-oauth.ts, services/mcp-auth/ |

Files: `packages/kilo-vscode/src/provider-actions.ts`, `kilo-provider/handlers/auth.ts`, `kilo-provider/mcp-oauth.ts`

### 1.6 Replace SDK config calls

| SDK call | Native replacement | File |
|---|---|---|
| `client.config.get` | `runtime.config.get` | KiloProvider.ts |
| `client.config.overlayUpdate` | Implement native overlay update | KiloProvider.ts:4192, 4209 |
| `client.global.config.get` | Implement native global config | KiloProvider.ts:3414 |
| `client.config.warnings` | Implement native config warnings | KiloProvider.ts:3771 |

Files: `packages/kilo-vscode/src/KiloProvider.ts`, `services/native-runtime/configuration.ts`

### 1.7 Wire bridge events to webview

Replace the SSE event subscription in `doInitializeConnection()` with bridge event subscription. The bridge already posts webview messages via its `post` callback.

Files: `packages/kilo-vscode/src/KiloProvider.ts`

## Phase 2: Fill native runtime gaps

Implement capabilities the native runtime lacks but KiloProvider needs.

### 2.1 session.command — map to prompt

Commands like `/goal`, `/compact` are sent as `client.session.command()`. Implement as `runtime.sessions.prompt()` with the command text prefixed.

Files: `packages/kilo-vscode/src/KiloProvider.ts`

### 2.2 session.deleteMessage

Implement `runtime.sessions.deleteMessage(dir, id, messageID)` — removes a message from the session's message list and emits `message.removed` event.

Files: `packages/kilo-vscode/src/services/native-runtime/sessions.ts`, `contracts.ts`, `native-session-bridge.ts`

### 2.3 session.revert / unrevert

Implement git-based revert/unrevert. Uses VS Code Git API or `git` CLI via `execTree`.

Files: `packages/kilo-vscode/src/services/native-runtime/sessions.ts`

### 2.4 session.summarize

Implement `runtime.sessions.summarize(dir, id, providerID, modelID)` — runs a compaction turn that summarizes conversation history.

Files: `packages/kilo-vscode/src/services/native-runtime/sessions.ts`

### 2.5 config.overlayUpdate

Implement `runtime.config.overlayUpdate(dir, scope, set, unset, expected)` — patches global/project config with optimistic concurrency.

Files: `packages/kilo-vscode/src/services/native-runtime/configuration.ts`

### 2.6 config.warnings

Implement `runtime.config.warnings(dir)` — validates config files and returns warnings.

Files: `packages/kilo-vscode/src/services/native-runtime/configuration.ts`

### 2.7 global.config.get

Implement `runtime.config.getGlobal()` — reads global config from extension storage.

Files: `packages/kilo-vscode/src/services/native-runtime/configuration.ts`

### 2.8 kilocode.* calls

Replace `client.kilocode.removeSkill`, `resumeSession`, `sessionModelUsage`, `providerUsage`, `backgroundJobs` with native implementations or direct Kilo Gateway network calls.

Files: `packages/kilo-vscode/src/KiloProvider.ts`, `services/native-runtime/`

### 2.9 enhancePrompt

Implement `runtime.enhancePrompt(text)` — calls the provider with an enhancement prompt.

Files: `packages/kilo-vscode/src/services/native-runtime/`, `KiloProvider.ts:1812`

### 2.10 suggestion.list/dismiss, network.list/reject, session.viewed

Implement or stub these in the native runtime. `session.viewed` can be a no-op (tracking is extension-side).

Files: `packages/kilo-vscode/src/services/native-runtime/`, `connection-service.ts`

## Phase 3: Cut SDK from all other files

Replace `@kilocode/sdk` runtime usage across the extension.

### 3.1 Handler files

`kilo-provider/handlers/` — permission-handler.ts, question.ts, cloud-session.ts, migration.ts, suggestion.ts, auth.ts, notifications.ts

### 3.2 Agent Manager files

`agent-manager/` — provider-lifecycle.ts, tool-start.ts, mcp-warmup.ts, terminal-manager.ts, orchestration-domain.ts, sandbox-bootstrap.ts, continue-in-worktree.ts, fork-session.ts, promotion-handoff.ts, etc.

### 3.3 Service files

`services/` — marketplace, notifications, RemoteStatusService, caffeination, browser-automation, notebook, telemetry, retention, etc.

### 3.4 Type-only imports

Replace `import type { KiloClient, Session, ... } from "@kilocode/sdk/v2/client"` with native runtime types or inline types.

Files: ~86 files across `src/`

## Phase 4: Remove CLI infrastructure

### 4.1 Remove ServerManager and SDK client creation

Delete `packages/kilo-vscode/src/services/cli-backend/server-manager.ts` and `sdk-sse-adapter.ts`. Remove `createKiloClient` import from `connection-service.ts`.

### 4.2 Remove CLI from build pipeline

- `packages/kilo-vscode/script/build.ts` — remove CLI binary copying, tree-sitter/sandbox resource copying, FFmpeg bundling
- `packages/kilo-vscode/script/local-bin.ts` — remove or repurpose (no longer needed)
- `packages/kilo-vscode/script/bwrap-helper.ts`, `ffmpeg-helper.ts` — remove
- `packages/kilo-vscode/src/services/cli-backend/cli-resources.ts` — remove
- Remove `bin/kilo` from package

### 4.3 Update package.json

Remove CLI-related fields, update `main` entry if needed.

## Phase 5: Validate

### 5.1 Typecheck, lint, tests

- `bun run typecheck` from `packages/kilo-vscode/`
- `bun run lint` from `packages/kilo-vscode/`
- `bun test` from `packages/kilo-vscode/`
- Native runtime unit tests (`tests/unit/native-runtime*.test.ts`)

### 5.2 VSIX inspection

Build a VSIX and inspect its archive:
- Assert no `bin/kilo`, `kilo.exe`, CLI build artifact
- Report compressed/uncompressed sizes
- Compare against current ~182 MB artifact

### 5.3 Runtime validation

Manual verification of:
- Create session, send message, stream response
- Tool execution with permission prompts
- Provider connect (Kilo Gateway device auth, API key)
- Session list, load messages, delete, abort
- Config read/write
- MCP server connection

## Key Decisions

1. **Fresh native store** — Do not migrate old sessions or provider credentials from `globalStorage/kilo-cli`. Leave old directory untouched; users reconnect providers. (Matches existing plan decision #4)

2. **No dynamic provider packages** — Hand-code adapters for built-in providers only. Do not support arbitrary dynamically installed provider npm packages. (Matches existing plan decision #1)

3. **No OS sandbox** — Remove/disable optional sandbox behavior. Permission checks are not process isolation. (Matches existing plan decision #3)

4. **No SDK fallback** — Do not keep a dual CLI/fallback build. Rollback uses a previously published VSIX. (Matches existing plan decision #8)

5. **Bridge as the adapter** — The `native-session-bridge.ts` is the single adapter between native runtime events and webview messages. All webview output flows through it.

## Risks

1. **Large surface** — ~86 files import `@kilocode/sdk`. Type-only imports are easy; runtime calls need native replacements. The inventory in Phase 1/3 must be exhaustive.

2. **Provider protocol parity** — OpenAI-compatible, OpenAI-responses, Anthropic, Google, and Kilo Gateway device auth must all work through `fetch` + SSE parsing in the extension host. Test each independently.

3. **Extension host responsiveness** — All agent/runtime work runs in the extension host. Streaming, tool output, and persistence must avoid blocking. Use async/cancellable patterns throughout.

4. **Git operations** — revert/unrevert/summarize need git integration. Use VS Code Git API where available, fall back to `git` CLI via `execTree`.

5. **Windows compatibility** — File operations use `O_NOFOLLOW` and directory-fd pinning on POSIX; Windows has no equivalent. Document as residual risk.

## Exit Criteria

- Typecheck, lint, and unit tests pass from `packages/kilo-vscode/`
- VSIX contains no `bin/kilo`, `kilo.exe`, or CLI build artifacts
- Core flows verified: create session, send/stream message, tools with permissions, provider connect, config, session list/delete/abort
- No `import` or runtime dependency on `@kilocode/sdk` client remains in `packages/kilo-vscode/src/`
- `packages/opencode/` CLI is no longer referenced by the extension build/package pipeline
