import { Button } from "@kilocode/kilo-ui/button"
import { useDialog } from "@kilocode/kilo-ui/context/dialog"
import { Dialog } from "@kilocode/kilo-ui/dialog"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { Switch } from "@kilocode/kilo-ui/switch"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { showToast } from "@kilocode/kilo-ui/toast"
import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import { useVSCode } from "../../context/vscode"
import type { ProviderAuthState, ProviderConfig } from "../../types/messages"
import { createProviderAction } from "../../utils/provider-action"
import { LLAMA_CPP_PROVIDER_ID, LLAMA_CPP_DEFAULTS, validateLlamaCppForm } from "./llama-cpp-provider"
import type { LlamaCppField, LlamaCppForm, LlamaCppResult } from "./llama-cpp-provider"
import { MASKED_CUSTOM_PROVIDER_KEY, resolveCustomProviderKey } from "../../../../src/shared/custom-provider"

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown, fallback: string) {
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  return fallback
}

function initForm(cfg: ProviderConfig | undefined, auth: ProviderAuthState | undefined): LlamaCppForm {
  if (!cfg) return { ...LLAMA_CPP_DEFAULTS }

  const opts = record(cfg.options)
  const models = record(cfg.models)
  const entry = Object.entries(models).at(0)
  const model = record(entry?.[1])
  const options = record(model.options)
  return {
    ...LLAMA_CPP_DEFAULTS,
    baseURL: text(opts.baseURL, LLAMA_CPP_DEFAULTS.baseURL),
    apiKey: resolveCustomProviderKey(auth),
    modelID: entry?.[0] ?? LLAMA_CPP_DEFAULTS.modelID,
    modelName: text(model.name, LLAMA_CPP_DEFAULTS.modelName),
    context: text(record(model.limit).context, LLAMA_CPP_DEFAULTS.context),
    output: text(record(model.limit).output, LLAMA_CPP_DEFAULTS.output),
    timeout: text(opts.timeout, LLAMA_CPP_DEFAULTS.timeout),
    temperature: text(options.temperature, LLAMA_CPP_DEFAULTS.temperature),
    topP: text(options.topP, LLAMA_CPP_DEFAULTS.topP),
    topK: text(options.topK, LLAMA_CPP_DEFAULTS.topK),
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : LLAMA_CPP_DEFAULTS.reasoning,
    toolCall: typeof model.tool_call === "boolean" ? model.tool_call : LLAMA_CPP_DEFAULTS.toolCall,
    thinking: typeof options.enable_thinking === "boolean" ? options.enable_thinking : LLAMA_CPP_DEFAULTS.thinking,
  }
}

const LlamaCppDialog = () => {
  const dialog = useDialog()
  const { config } = useConfig()
  const provider = useProvider()
  const language = useLanguage()
  const vscode = useVSCode()
  const action = createProviderAction(vscode)
  onCleanup(action.dispose)
  provider.trackDialog()

  const saved = config().provider?.[LLAMA_CPP_PROVIDER_ID]
  const [form, setForm] = createStore(initForm(saved, provider.authStates()[LLAMA_CPP_PROVIDER_ID]))
  const [errors, setErrors] = createStore<LlamaCppResult["errors"]>({})
  const [keyChanged, setKeyChanged] = createStore({ value: !saved })
  const [saving, setSaving] = createStore({ value: false })

  function update(key: LlamaCppField, value: string | boolean) {
    if (key === "reasoning" || key === "toolCall" || key === "thinking") {
      setForm(key, value as boolean)
    } else {
      setForm(key, value as string)
    }
    setErrors(key, undefined)
  }

  function save(e: SubmitEvent) {
    e.preventDefault()
    if (saving.value) return
    const result = validateLlamaCppForm(form)
    setErrors(result.errors)
    if (!result.config) return

    setSaving("value", true)
    action.send(
      {
        type: "saveCustomProvider",
        providerID: LLAMA_CPP_PROVIDER_ID,
        config: result.config,
        apiKey: keyChanged.value ? form.apiKey.trim() || undefined : undefined,
        apiKeyChanged: keyChanged.value,
      },
      {
        onConnected: () => {
          setSaving("value", false)
          dialog.close()
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("provider.connect.toast.connected.title", { provider: "llama.cpp" }),
            description: language.t("provider.connect.toast.connected.description", { provider: "llama.cpp" }),
          })
        },
        onError: (message) => {
          setSaving("value", false)
          showToast({ title: language.t("common.requestFailed"), description: message.message })
        },
      },
    )
  }

  const fieldError = (key: LlamaCppField) => {
    const err = errors[key]
    return err ? language.t(err) : undefined
  }

  return (
    <Dialog title={language.t("settings.providers.llamaCpp.title")} size="large" transition>
      <form
        onSubmit={save}
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "16px",
          padding: "0 16px 16px",
          "overflow-y": "auto",
          flex: 1,
        }}
      >
        <p style={{ margin: 0, color: "var(--text-weak-base)" }}>
          {language.t("settings.providers.llamaCpp.description")}
        </p>

        <TextField
          autofocus
          label={language.t("settings.providers.llamaCpp.baseURL")}
          description={language.t("settings.providers.llamaCpp.baseURLHint")}
          value={form.baseURL}
          onChange={(value) => update("baseURL", value)}
          validationState={errors.baseURL ? "invalid" : undefined}
          error={fieldError("baseURL")}
        />
        <TextField
          type="password"
          label={language.t("settings.providers.llamaCpp.apiKey")}
          description={language.t("settings.providers.llamaCpp.apiKeyHint")}
          value={form.apiKey}
          onChange={(value) => {
            const key =
              !keyChanged.value && form.apiKey === MASKED_CUSTOM_PROVIDER_KEY ? value.replace(/^\*+/, "") : value
            setForm("apiKey", key)
            setKeyChanged("value", true)
          }}
        />

        <h4 style={{ margin: 0 }}>{language.t("settings.providers.llamaCpp.modelSection")}</h4>
        <TextField
          label={language.t("settings.providers.llamaCpp.modelID")}
          description={language.t("settings.providers.llamaCpp.modelIDHint")}
          value={form.modelID}
          onChange={(value) => update("modelID", value)}
          validationState={errors.modelID ? "invalid" : undefined}
          error={fieldError("modelID")}
        />
        <TextField
          label={language.t("settings.providers.llamaCpp.modelName")}
          value={form.modelName}
          onChange={(value) => update("modelName", value)}
          validationState={errors.modelName ? "invalid" : undefined}
          error={fieldError("modelName")}
        />
        <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" }}>
          <TextField
            type="number"
            min="1"
            max="2097152"
            step="1"
            label={language.t("settings.providers.llamaCpp.context")}
            description={language.t("settings.providers.llamaCpp.tokenHint")}
            value={form.context}
            onChange={(value) => update("context", value)}
            validationState={errors.context ? "invalid" : undefined}
            error={fieldError("context")}
          />
          <TextField
            type="number"
            min="1"
            max="1048576"
            step="1"
            label={language.t("settings.providers.llamaCpp.output")}
            description={language.t("settings.providers.llamaCpp.tokenHint")}
            value={form.output}
            onChange={(value) => update("output", value)}
            validationState={errors.output ? "invalid" : undefined}
            error={fieldError("output")}
          />
        </div>

        <h4 style={{ margin: 0 }}>{language.t("settings.providers.llamaCpp.capabilities")}</h4>
        <Switch checked={form.toolCall} onChange={(value) => update("toolCall", value)}>
          {language.t("settings.providers.llamaCpp.toolCall")}
        </Switch>
        <Switch checked={form.reasoning} onChange={(value) => update("reasoning", value)}>
          {language.t("settings.providers.llamaCpp.reasoning")}
        </Switch>
        <Switch checked={form.thinking} onChange={(value) => update("thinking", value)}>
          {language.t("settings.providers.llamaCpp.thinking")}
        </Switch>

        <h4 style={{ margin: 0 }}>{language.t("settings.providers.llamaCpp.generation")}</h4>
        <div style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(140px, 1fr))", gap: "12px" }}>
          <TextField
            type="number"
            min="0"
            max="2"
            step="0.1"
            label={language.t("settings.providers.llamaCpp.temperature")}
            value={form.temperature}
            onChange={(value) => update("temperature", value)}
            validationState={errors.temperature ? "invalid" : undefined}
            error={fieldError("temperature")}
          />
          <TextField
            type="number"
            min="0"
            max="1"
            step="0.01"
            label={language.t("settings.providers.llamaCpp.topP")}
            value={form.topP}
            onChange={(value) => update("topP", value)}
            validationState={errors.topP ? "invalid" : undefined}
            error={fieldError("topP")}
          />
          <TextField
            type="number"
            min="1"
            max="1000"
            step="1"
            label={language.t("settings.providers.llamaCpp.topK")}
            value={form.topK}
            onChange={(value) => update("topK", value)}
            validationState={errors.topK ? "invalid" : undefined}
            error={fieldError("topK")}
          />
        </div>
        <TextField
          type="number"
          min="1000"
          max="3600000"
          step="1000"
          label={language.t("settings.providers.llamaCpp.timeout")}
          description={language.t("settings.providers.llamaCpp.timeoutHint")}
          value={form.timeout}
          onChange={(value) => update("timeout", value)}
          validationState={errors.timeout ? "invalid" : undefined}
          error={fieldError("timeout")}
        />

        <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px", "margin-top": "8px" }}>
          <Button type="button" variant="secondary" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={saving.value}>
            {saving.value ? <Spinner /> : language.t("settings.providers.llamaCpp.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export default LlamaCppDialog
