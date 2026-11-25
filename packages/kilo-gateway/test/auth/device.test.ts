import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { KILO_API_BASE } from "../../src/api/constants.js"
import { initiateDeviceAuth, pollDeviceAuth } from "../../src/auth/device.js"

afterEach(() => mock.restore())

test("device initiation preserves the POST, JSON, and rate-limit error", async () => {
  const data = { code: "ABCD", verificationUrl: "https://example.com/device", expiresIn: 600, extra: true }
  const request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(data))

  await expect(initiateDeviceAuth()).resolves.toEqual(data)
  expect(request.mock.calls).toStrictEqual([
    [
      `${KILO_API_BASE}/api/device-auth/codes`,
      { method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error" },
    ],
  ])
  request.mockResolvedValue(new Response(null, { status: 429 }))
  await expect(initiateDeviceAuth()).rejects.toThrow("Too many pending authorization requests. Please try again later.")
})

test("device polling preserves the bare GET and JSON", async () => {
  const data = { status: "approved", token: "token", userEmail: "user@example.com", extra: true }
  const request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(data))

  await expect(pollDeviceAuth("code/with space")).resolves.toEqual(data)
  expect(request.mock.calls).toStrictEqual([
    [`${KILO_API_BASE}/api/device-auth/codes/code%2Fwith%20space`, { redirect: "error" }],
  ])
})

test("device endpoints accept an override base URL and AbortSignal", async () => {
  const signal = new AbortController().signal
  const request = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ status: "pending" }))

  await initiateDeviceAuth({ baseURL: "https://gateway.example/", signal })
  await pollDeviceAuth("code", { baseURL: "https://gateway.example/", signal })

  expect(request.mock.calls).toStrictEqual([
    [
      "https://gateway.example/api/device-auth/codes",
      { method: "POST", headers: { "Content-Type": "application/json" }, signal, redirect: "error" },
    ],
    ["https://gateway.example/api/device-auth/codes/code", { signal, redirect: "error" }],
  ])
})

test.each([
  [202, "pending"],
  [403, "denied"],
  [410, "expired"],
])("device polling maps HTTP %i to %s without parsing JSON", async (status, state) => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status }))

  await expect(pollDeviceAuth("code")).resolves.toEqual({ status: state })
})
