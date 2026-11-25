import type { DeviceAuthInitiateResponse, DeviceAuthPollResponse } from "../types.js"
import { KILO_API_BASE } from "../api/constants.js"

export async function initiateDeviceAuth(
  options: { baseURL?: string; signal?: AbortSignal } = {},
): Promise<DeviceAuthInitiateResponse> {
  const url = `${(options.baseURL ?? KILO_API_BASE).replace(/\/+$/, "")}/api/device-auth/codes`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    redirect: "error",
    ...(options.signal ? { signal: options.signal } : {}),
  })

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("Too many pending authorization requests. Please try again later.")
    }
    throw new Error(`Failed to initiate device authorization: ${response.status}`)
  }

  const data = await response.json()
  return data as DeviceAuthInitiateResponse
}

export async function pollDeviceAuth(
  code: string,
  options: { baseURL?: string; signal?: AbortSignal } = {},
): Promise<DeviceAuthPollResponse> {
  const url = `${(options.baseURL ?? KILO_API_BASE).replace(/\/+$/, "")}/api/device-auth/codes/${encodeURIComponent(code)}`
  const response = options.signal
    ? await fetch(url, { signal: options.signal, redirect: "error" })
    : await fetch(url, { redirect: "error" })

  if (response.status === 202) {
    return { status: "pending" }
  }

  if (response.status === 403) {
    return { status: "denied" }
  }

  if (response.status === 410) {
    return { status: "expired" }
  }

  if (!response.ok) {
    throw new Error(`Failed to poll device authorization: ${response.status}`)
  }

  const data = await response.json()
  return data as DeviceAuthPollResponse
}
